/** Tiny fetch wrapper. Errors come back as ApiError with per-field messages. */

export class ApiError extends Error {
  status: number;
  errors: Record<string, string>;
  code?: string;

  constructor(status: number, message: string, errors: Record<string, string> = {}, code?: string) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toError(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object') {
    const b = body as { detail?: unknown; errors?: Record<string, string>; code?: string };
    const message = typeof b.detail === 'string' ? b.detail : 'Something went wrong.';
    return new ApiError(status, message, b.errors ?? {}, b.code);
  }
  if (status === 413) return new ApiError(status, 'That upload is too big.');
  if (status >= 500) return new ApiError(status, 'The server hit a problem. Try again in a moment.');
  return new ApiError(status, 'Something went wrong.');
}

export interface RequestOptions {
  /** Don't treat a 401 as "you've been logged out". */
  quiet401?: boolean;
  signal?: AbortSignal;
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {}, signal: opts.signal };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, "Couldn't reach the server. Check your connection.");
  }
  const data = await parse(res);
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) onUnauthorized?.();
    throw toError(res.status, data);
  }
  return data as T;
}

export const api = {
  get: <T = unknown>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  put: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  patch: <T = unknown>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, opts),
  del: <T = unknown>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};

/** Upload with progress (fetch can't report upload progress). */
export function upload<T = unknown>(
  method: string,
  path: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open(method, path);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        if (xhr.status === 401) onUnauthorized?.();
        reject(toError(xhr.status, data));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Couldn't reach the server. Check your connection."));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
