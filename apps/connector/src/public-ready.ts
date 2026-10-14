const READY_BODY = '{"error":"Surflet access required"}';
const OVERALL_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const MAX_BODY_BYTES = 4 * 1024;

class ReadinessError extends Error {
  constructor(host: string, detail: string) {
    super(`Quick Tunnel readiness failed (${host}; ${detail})`);
  }
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function raceAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener('abort', abort, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    }
    signal.addEventListener('abort', cancelled, { once: true });
  });
}

function errorCode(error: unknown) {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause as { code?: unknown; cause?: unknown } | undefined;
  }
  return undefined;
}

function retryableNetworkError(error: unknown) {
  const code = errorCode(error);
  return Boolean(
    code &&
      /^(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ECONNABORTED|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT))$/.test(
        code,
      ),
  );
}

function validateQuickTunnel(url: string) {
  let value: URL;
  try {
    value = new URL(url);
  } catch {
    throw new Error('invalid Quick Tunnel URL');
  }
  if (
    value.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(value.hostname) ||
    value.username ||
    value.password ||
    value.port ||
    value.pathname !== '/' ||
    value.search ||
    value.hash
  )
    throw new Error('invalid Quick Tunnel URL');
  return value;
}

async function readBoundedBody(response: Response, signal: AbortSignal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('response body exceeds readiness limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const next = await raceAbort(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error('response body exceeds readiness limit');
      chunks.push(next.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function discardBody(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

function requestSignal(parent: AbortSignal, ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('request timeout')), ms);
  const abort = () => controller.abort(parent.reason instanceof Error ? parent.reason : abortError());
  parent.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timeout);
      parent.removeEventListener('abort', abort);
    },
  };
}

/** Wait until a public Quick Tunnel reaches this connector's unauthenticated boundary. */
export async function waitForQuickTunnel(url: string, signal: AbortSignal): Promise<void> {
  const tunnel = validateQuickTunnel(url);
  const host = tunnel.hostname;
  const started = Date.now();
  let finalDetail = 'request timeout';

  for (;;) {
    throwIfAborted(signal);
    const remaining = OVERALL_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) throw new ReadinessError(host, finalDetail);
    const request = requestSignal(signal, Math.min(REQUEST_TIMEOUT_MS, remaining));
    try {
      const response = await raceAbort(
        fetch(tunnel, {
          method: 'GET',
          headers: { 'user-agent': 'Surflet-Connector/0.2' },
          credentials: 'omit',
          redirect: 'manual',
          signal: request.signal,
        }),
        request.signal,
      );
      const status = response.status;
      finalDetail = `HTTP ${status}`;
      if (status === 401) {
        const body = await readBoundedBody(response, request.signal);
        throwIfAborted(signal);
        throwIfAborted(request.signal);
        if (Date.now() - started >= OVERALL_TIMEOUT_MS) throw new ReadinessError(host, finalDetail);
        if (body === READY_BODY) return;
        throw new ReadinessError(host, finalDetail);
      }
      discardBody(response);
      if (status !== 429 && (status < 500 || status >= 600))
        throw new ReadinessError(host, finalDetail);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ReadinessError) throw error;
      const code = errorCode(error);
      if (code && /(?:CERT|TLS|SSL)/i.test(code)) throw new ReadinessError(host, code);
      if (request.signal.aborted) finalDetail = 'request timeout';
      else if (retryableNetworkError(error)) finalDetail = `DNS/network ${errorCode(error)}`;
      else throw new ReadinessError(host, 'request failed');
    } finally {
      request.close();
    }
    const left = OVERALL_TIMEOUT_MS - (Date.now() - started);
    if (left <= 0) throw new ReadinessError(host, finalDetail);
    await delay(Math.min(RETRY_DELAY_MS, left), signal);
  }
}
