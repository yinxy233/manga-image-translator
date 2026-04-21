export {};

declare global {
  interface GMRequestHandle {
    abort: () => void;
  }

  interface GMRequestResponse<T = unknown> {
    finalUrl?: string;
    readyState?: number;
    status: number;
    statusText?: string;
    responseHeaders?: string;
    response?: T;
    responseText?: string;
  }

  interface GMRequestDetails<T = unknown> {
    method?: string;
    url: string | URL;
    headers?: Record<string, string>;
    data?: BodyInit | FormData | string | Blob;
    responseType?: "arraybuffer" | "blob" | "json" | "stream";
    timeout?: number;
    fetch?: boolean;
    anonymous?: boolean;
    onabort?: (response: GMRequestResponse<T>) => void;
    onerror?: (response: GMRequestResponse<T>) => void;
    onload?: (response: GMRequestResponse<T>) => void;
    onloadstart?: (response: GMRequestResponse<T>) => void;
    onprogress?: (response: GMRequestResponse<T>) => void;
    ontimeout?: (response: GMRequestResponse<T>) => void;
  }

  function GM_getValue<T>(key: string, defaultValue?: T): T;
  function GM_setValue<T>(key: string, value: T): void;
  function GM_xmlhttpRequest<T = unknown>(details: GMRequestDetails<T>): GMRequestHandle;
}
