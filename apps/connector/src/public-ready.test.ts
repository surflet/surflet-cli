import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForQuickTunnel } from './public-ready.js';

const TUNNEL = 'https://ready-123.trycloudflare.com';
const READY = '{"error":"Surflet access required"}';

function response(status: number, body = '') {
  return new Response(body, { status });
}

function network(code: string) {
  return Object.assign(new TypeError('network failure'), { cause: Object.assign(new Error(code), { code }) });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('waitForQuickTunnel', () => {
  it('retries temporary DNS failures until the protected connector denial is public', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(network('ENOTFOUND'))
      .mockRejectedValueOnce(network('EAI_AGAIN'))
      .mockResolvedValue(response(401, READY));
    vi.stubGlobal('fetch', fetch);
    const ready = waitForQuickTunnel(TUNNEL, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(ready).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      headers: { 'user-agent': 'Surflet-Connector/0.2' },
    });
  });

  it('recovers from provider 5xx responses', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const errorPage = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, headers: new Headers({ 'content-length': '999999' }), body: errorPage })
      .mockResolvedValue(response(401, READY));
    vi.stubGlobal('fetch', fetch);
    const ready = waitForQuickTunnel(TUNNEL, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(ready).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancelled).toBe(true);
  });

  it('bounds a hung response header by the overall deadline without leaking the input URL', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const pending = waitForQuickTunnel(`${TUNNEL}/?secret=never-print`, new AbortController().signal);
    await expect(pending).rejects.toThrow('invalid Quick Tunnel URL');
    expect(fetch).not.toHaveBeenCalled();

    const timed = waitForQuickTunnel(TUNNEL, new AbortController().signal);
    const rejected = expect(timed).rejects.toThrow(/request timeout/);
    await vi.advanceTimersByTimeAsync(120_001);
    await rejected;
  });

  it('aborts a hung fetch and a retry wait immediately', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const inflight = new AbortController();
    const waiting = waitForQuickTunnel(TUNNEL, inflight.signal);
    inflight.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    fetch.mockRejectedValue(network('ECONNREFUSED'));
    const sleep = new AbortController();
    const retrying = waitForQuickTunnel(TUNNEL, sleep.signal);
    await vi.advanceTimersByTimeAsync(0);
    sleep.abort();
    await expect(retrying).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report ready when cancellation wins a response completion race', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => (resolve = done))));
    const controller = new AbortController();
    const pending = waitForQuickTunnel(TUNNEL, controller.signal);
    controller.abort();
    resolve(response(401, READY));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects redirects, successful pages, bad denial bodies, permanent 4xx, and TLS errors', async () => {
    const cases: Array<[Response | Error, RegExp]> = [
      [response(302), /HTTP 302/],
      [response(200, 'ok'), /HTTP 200/],
      [response(401, '{"error":"different"}'), /HTTP 401/],
      [response(403, 'no'), /HTTP 403/],
      [network('ERR_TLS_CERT_ALTNAME_INVALID'), /ERR_TLS_CERT_ALTNAME_INVALID/],
    ];
    for (const [result, expected] of cases) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => (result instanceof Response ? Promise.resolve(result) : Promise.reject(result))),
      );
      await expect(waitForQuickTunnel(TUNNEL, new AbortController().signal)).rejects.toThrow(expected);
      vi.unstubAllGlobals();
    }
  });

  it('rejects unsafe origins before making any request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const url of [
      'http://ready.trycloudflare.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://ready.trycloudflare.com.evil.example',
      'https://user@ready.trycloudflare.com',
      'https://ready.trycloudflare.com:444',
      'https://ready.trycloudflare.com/path',
      'https://ready.trycloudflare.com?token=secret',
      'https://ready.trycloudflare.com#token=secret',
    ])
      await expect(waitForQuickTunnel(url, new AbortController().signal)).rejects.toThrow(
        'invalid Quick Tunnel URL',
      );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels and releases a body that does not finish before the request deadline', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const hanging = { status: 401, headers: new Headers(), body } as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hanging));
    const controller = new AbortController();
    const pending = waitForQuickTunnel(TUNNEL, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(cancelled).toBe(true);
    controller.abort();
    await rejected;
  });
});
