from __future__ import annotations

from asyncio import Event, Lock
from typing import List

from PIL import Image
from pydantic import BaseModel

from manga_translator import Config
from server.sent_data_internal import fetch_data_stream, NotifyType, fetch_data

class ExecutorInstance(BaseModel):
    """Connection and busy state for one isolated model worker."""
    ip: str
    port: int
    nonce: str | None = None
    busy: bool = False

    def _headers(self) -> dict[str, str]:
        """Return the worker-authentication header when nonce checks are active."""
        if not self.nonce or self.nonce == "None":
            return {}
        return {"X-Nonce": self.nonce}

    def free_executor(self):
        """Mark this worker available for the next queue item."""
        self.busy = False

    async def sent(self, image: Image.Image | bytes, config: Config):
        """Execute a non-streaming translation on this worker."""
        return await fetch_data(
            "http://"+self.ip+":"+str(self.port)+"/simple_execute/translate",
            image,
            config,
            headers=self._headers(),
        )

    async def sent_stream(self, image: Image.Image | bytes, config: Config, sender: NotifyType):
        """Execute a translation and relay worker progress frames."""
        await fetch_data_stream(
            "http://"+self.ip+":"+str(self.port)+"/execute/translate",
            image,
            config,
            sender,
            headers=self._headers(),
        )

    async def sent_batch(self, images: List[Image.Image | bytes], config: Config, batch_size: int):
        """Execute a non-streaming batch with the worker's public argument names."""
        return await fetch_data("http://"+self.ip+":"+str(self.port)+"/simple_execute/translate_batch", 
                               {
                                   "images_with_configs": [
                                       (image, config) for image in images
                                   ],
                                   "batch_size": batch_size,
                               }, config, headers=self._headers())

    async def sent_batch_stream(self, images: List[Image.Image | bytes], config: Config, batch_size: int, sender: NotifyType):
        """Execute a batch and relay worker progress frames."""
        await fetch_data_stream("http://"+self.ip+":"+str(self.port)+"/execute/translate_batch",
                               {
                                   "images_with_configs": [
                                       (image, config) for image in images
                                   ],
                                   "batch_size": batch_size,
                               }, config, sender, headers=self._headers())

class Executors:
    """Serialize worker allocation and notify the public task queue on release."""
    def __init__(self):
        self.list: List[ExecutorInstance] = []
        self.lock: Lock = Lock()
        self.event = Event()

    def register(self, instance: ExecutorInstance):
        """Register one worker started by the local service."""
        self.list.append(instance)

    def free_executors(self) -> int:
        """Return the number of workers currently available."""
        return len([item for item in self.list if not item.busy])

    async def _find_instance(self):
        while True:
            instance = next((x for x in self.list if x.busy == False), None)
            if instance is not None:
                return instance
            #todo: cricial error: warn should never happen
            await self.event.wait()

    async def find_executor(self) -> ExecutorInstance:
        """Atomically reserve and return the next free worker."""
        async with self.lock:  # Using async with for lock management
            instance = await self._find_instance()
            instance.busy = True
            return instance

    async def free_executor(self, instance: ExecutorInstance):
        """Release a worker and wake queued/disconnected task cleanup."""
        from server.myqueue import task_queue
        instance.free_executor()
        self.event.set()
        self.event.clear()
        await task_queue.update_event()

executor_instances: Executors = Executors()
