import asyncio
import os
from typing import List, Optional

from PIL import Image
from fastapi import HTTPException
from fastapi.requests import Request

from manga_translator import Config
from server.instance import executor_instances
from server.sent_data_internal import NotifyType

class QueueElement:
    """Single-page queue item retaining compressed source bytes when possible."""
    req: Request
    image: bytes | Image.Image | str
    config: Config

    def __init__(self, req: Request, image: bytes | Image.Image, config: Config, length: int):
        self.req = req
        if length > 10:
            #todo: store image in "upload-cache" folder
            self.image = image
        else:
            self.image = image
        self.config = config

    def get_image(self) -> bytes | Image.Image:
        """Return the queued image without eagerly decoding encoded bytes."""
        if isinstance(self.image, str):
            return Image.open(self.image)
        else:
            return self.image

    def __del__(self):
        if isinstance(self.image, str):
            os.remove(self.image)

    async def is_client_disconnected(self) -> bool:
        """Return whether the originating HTTP client has disconnected."""
        if await self.req.is_disconnected():
            return True
        return False


class BatchQueueElement:
    """Batch translation queue element"""
    req: Request
    images: List[bytes | Image.Image]
    config: Config
    batch_size: int

    def __init__(self, req: Request, images: List[bytes | Image.Image], config: Config, batch_size: int):
        self.req = req
        self.images = images
        self.config = config
        self.batch_size = batch_size

    async def is_client_disconnected(self) -> bool:
        """Return whether the originating batch client has disconnected."""
        if await self.req.is_disconnected():
            return True
        return False


class TaskQueue:
    """In-memory FIFO for dispatching public requests to model workers."""
    def __init__(self):
        self.queue: List[QueueElement | BatchQueueElement] = []
        self.queue_event: asyncio.Event = asyncio.Event()

    def add_task(self, task: QueueElement | BatchQueueElement):
        """Append a request without starting model work immediately."""
        self.queue.append(task)

    def get_pos(self, task: QueueElement | BatchQueueElement) -> Optional[int]:
        """Return the current queue position, or None after removal."""
        try:
            return self.queue.index(task)
        except ValueError:
            return None
    async def update_event(self):
        """Drop disconnected queued clients and wake position waiters."""
        self.queue = [task for task in self.queue if not await task.is_client_disconnected()]
        self.queue_event.set()
        self.queue_event.clear()

    async def remove(self, task: QueueElement | BatchQueueElement):
        """Remove a task immediately before worker submission."""
        self.queue.remove(task)
        await self.update_event()

    async def wait_for_event(self, timeout_seconds: float = 0.5):
        """Wait briefly for capacity while still polling client disconnects."""
        try:
            await asyncio.wait_for(self.queue_event.wait(), timeout_seconds)
        except asyncio.TimeoutError:
            return

task_queue = TaskQueue()

async def wait_in_queue(task: QueueElement | BatchQueueElement, notify: NotifyType):
    """Wait for capacity, skip disconnected clients, and dispatch exactly once."""
    while True:
        queue_pos = task_queue.get_pos(task)
        if queue_pos is None:
            if notify:
                return
            else:
                raise HTTPException(500, detail="User is no longer connected")  # just for the logs
        if await task.is_client_disconnected():
            await task_queue.update_event()
            if notify:
                return
            raise HTTPException(499, detail="User disconnected before worker submission")
        if notify:
            notify(3, str(queue_pos).encode('utf-8'))
        if queue_pos < executor_instances.free_executors():
            instance = await executor_instances.find_executor()
            if await task.is_client_disconnected():
                await executor_instances.free_executor(instance)
                if notify:
                    return
                raise HTTPException(499, detail="User disconnected before worker submission")
            await task_queue.remove(task)
            if notify:
                notify(4, b"")

            try:
                # Process batch translation task
                if isinstance(task, BatchQueueElement):
                    if notify:
                        await instance.sent_batch_stream(task.images, task.config, task.batch_size, notify)
                    else:
                        result = await instance.sent_batch(task.images, task.config, task.batch_size)
                else:
                    # Process single translation task
                    if notify:
                        await instance.sent_stream(task.image, task.config, notify)
                    else:
                        result = await instance.sent(task.image, task.config)

                await executor_instances.free_executor(instance)

                if notify:
                    return
                else:
                    return result

            except Exception as e:
                # 确保实例被释放
                await executor_instances.free_executor(instance)

                # 如果是连接错误，发送友好的错误消息
                if "Cannot connect to host" in str(e) or "Connection refused" in str(e):
                    error_msg = "Translation service is starting up, please wait a moment and try again."
                else:
                    error_msg = f"Translation failed: {str(e)}"

                if notify:
                    notify(2, error_msg.encode('utf-8'))
                    return
                else:
                    raise HTTPException(500, detail=error_msg)
        else:
            await task_queue.wait_for_event()
