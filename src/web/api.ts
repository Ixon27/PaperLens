/** JSON fetch; throws Error(body.error) on non-2xx. Pass `json` to send a JSON body. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String(data.error) : `요청 실패 (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

/** `data` is the JSON-parsed payload our own server sent for that event name. */
export type SseHandler = (event: string, data: unknown) => void;

function parseSseChunk(chunk: string, onEvent: SseHandler) {
  let event = 'message';
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return;
  const raw = data.join('\n');
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // plain text payload
  }
  onEvent(event, parsed);
}

/** POST a JSON body and read the SSE response stream. Resolves when the stream ends. */
export async function postSse(path: string, body: unknown, { onEvent, signal }: { onEvent: SseHandler; signal?: AbortSignal }) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `요청 실패 (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      // keep default
    }
    throw new Error(msg);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      parseSseChunk(buf.slice(0, i), onEvent);
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) parseSseChunk(buf, onEvent);
}

const JOB_EVENTS = ['snapshot', 'status', 'progress', 'delta', 'text', 'page', 'done', 'error'];

/** Subscribe to a job's SSE stream. Closes itself after `done`/`error`. Returns an unsubscribe fn. */
export function subscribeJob(jobId: string, onEvent: SseHandler): () => void {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  let closed = false;
  const close = () => {
    closed = true;
    es.close();
  };
  for (const name of JOB_EVENTS) {
    es.addEventListener(name, (e) => {
      if (closed) return;
      // EventSource fires a bare Event named "error" on connection failure.
      if (!(e instanceof MessageEvent)) {
        if (name === 'error' && es.readyState === EventSource.CLOSED) close();
        return;
      }
      let data: unknown = e.data;
      try {
        data = JSON.parse(e.data as string);
      } catch {
        // plain text
      }
      if (name === 'done' || name === 'error') close();
      onEvent(name, data);
    });
  }
  return close;
}
