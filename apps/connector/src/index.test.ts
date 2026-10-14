import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { detectRevision, loadCredentials, saveCredentials, startShare } from './index.js';
import * as publicReadiness from './public-ready.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const close of closers.splice(0)) await close();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

async function command(directory: string, ...args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', directory, ...args], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args[0]} failed`)),
    );
  });
}

async function fixtureService() {
  const calls: string[] = [];
  const feedbackBodies: Array<Record<string, unknown>> = [];
  let target = '';
  const preview = {
    id: 'preview-1',
    workspaceId: 'workspace-1',
    name: 'fixture',
    port: 0,
    revision: 'test',
    mode: 'local',
    status: 'starting',
    targetUrl: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastSeenAt: null,
    feedbackCount: 0,
  };
  const server = createServer(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    let body = '';
    for await (const chunk of request) body += chunk;
    const send = (value: unknown, code = 200) => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/api/workspaces' && request.method === 'POST')
      return send(
        {
          workspace: { id: 'workspace-1', name: 'test', createdAt: preview.createdAt },
          token: 'owner',
        },
        201,
      );
    if (request.url === '/api/previews' && request.method === 'POST')
      return send(
        {
          preview,
          connectorToken: 'connector',
          shareToken: 'viewer',
          shareUrl: 'http://portal.test/p/preview-1#token=viewer',
        },
        201,
      );
    if (request.url === '/api/previews/preview-1/access') {
      if (!['Bearer viewer', 'Bearer owner'].includes(request.headers.authorization ?? ''))
        return send({ error: 'unauthorized' }, 401);
      return send({
        targetUrl: `${target}/trial?from=portal&__surflet_access=abcdefghijklmnopqrstuvwxyz`,
      });
    }
    if (request.url === '/api/previews/preview-1/exchange') {
      if (
        request.headers.authorization !== 'Bearer connector' ||
        JSON.parse(body).ticket !== 'abcdefghijklmnopqrstuvwxyz'
      )
        return send({ error: 'unauthorized' }, 401);
      return send({ authorized: true });
    }
    if (request.url === '/api/previews/preview-1/feedback' && request.method === 'POST') {
      const feedback = JSON.parse(body) as Record<string, unknown>;
      feedbackBodies.push(feedback);
      return send({ feedback: { id: 'feedback-1', status: 'open', ...feedback } }, 201);
    }
    if (request.url === '/api/previews/preview-1/tunnel') {
      target = JSON.parse(body).targetUrl;
      return send({ preview });
    }
    if (
      request.url === '/api/previews/preview-1/heartbeat' ||
      request.url === '/api/previews/preview-1/stop'
    )
      return send({ preview });
    return send({ error: 'not found' }, 404);
  });
  return { base: await listen(server), calls, feedbackBodies };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function heartbeatFixture(
  respond: (count: number, signal: AbortSignal) => Response | Promise<Response>,
  options: { automaticRevision?: boolean; expiresIn?: number } = {},
) {
  const app = createServer((_request, response) => response.end('app ok'));
  const appUrl = await listen(app);
  const directory = await mkdtemp(join(tmpdir(), 'surflet-heartbeat-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  // Keep real I/O running; only the connector's clock and scheduling are controlled.
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  // Node's native AbortSignal.timeout bypasses fake timers. Preserve its abort contract.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      milliseconds,
    ).unref();
    return controller.signal;
  });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const revisions: string[] = [];
  let active = 0;
  let maxActive = 0;
  let createdRevision: string | undefined;
  const preview = {
    id: 'preview-1',
    workspaceId: 'workspace-1',
    name: 'fixture',
    port: 0,
    revision: 'test',
    mode: 'local',
    status: 'starting',
    targetUrl: null,
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    feedbackCount: 0,
    expiresAt: new Date(Date.now() + (options.expiresIn ?? 120_000)).toISOString(),
  };
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://control.test') return realFetch(input, init);
    calls.push(url.pathname);
    if (url.pathname === '/api/workspaces')
      return Response.json({
        workspace: { id: 'workspace-1', name: 'test', createdAt: preview.createdAt },
        token: 'owner',
      });
    if (url.pathname === '/api/previews') {
      createdRevision = JSON.parse(String(init?.body)).revision;
      return Response.json({
        preview: { ...preview, revision: createdRevision },
        connectorToken: 'connector',
        shareToken: 'viewer',
        shareUrl: 'http://portal.test/p/preview-1#token=viewer',
      });
    }
    if (url.pathname.endsWith('/heartbeat')) {
      revisions.push(JSON.parse(String(init?.body)).revision);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await respond(revisions.length, init?.signal as AbortSignal);
      } finally {
        active--;
      }
    }
    if (url.pathname.endsWith('/exchange')) return Response.json({ authorized: true });
    if (url.pathname.endsWith('/tunnel') || url.pathname.endsWith('/stop'))
      return Response.json({ preview });
    throw new Error(`Unexpected control request: ${url.pathname}`);
  });
  const handle = await startShare({
    server: 'http://control.test',
    port: Number(new URL(appUrl).port),
    mode: 'local',
    configDir: directory,
    reporterScript: '',
    ...(options.automaticRevision ? {} : { revision: 'fixed-revision' }),
  });
  closers.unshift(() => handle.close());
  const exchange = await proxyRequest(
    `${handle.connectorUrl}/?__surflet_access=abcdefghijklmnopqrstuvwxyz`,
  );
  expect(exchange.status).toBe(302);
  const cookie = exchange.cookies.map((value) => value.split(';', 1)[0]).join('; ');
  return {
    handle,
    calls,
    revisions,
    createdRevision,
    get maxActive() {
      return maxActive;
    },
    probe: (path = '/') => proxyRequest(`${handle.connectorUrl}${path}`, cookie),
  };
}

function proxyRequest(url: string, cookie = '') {
  return new Promise<{ status: number; body: string; cookies: string[] }>((resolve, reject) => {
    const request = httpRequest(url, { headers: { cookie }, agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body,
          cookies: response.headers['set-cookie'] ?? [],
        }),
      );
    });
    request.once('error', reject);
    request.end();
  });
}

const heartbeatOk = () => Response.json({ preview: {} });
const stopPath = '/api/previews/preview-1/stop';

describe('local connector', () => {
  it('keeps owner credentials scoped to their service URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'surflet-connector-'));
    await saveCredentials({ token: 'one', server: 'http://one.test' }, dir);
    await saveCredentials({ token: 'two', server: 'http://two.test' }, dir);
    expect((await loadCredentials(dir, 'http://one.test'))?.token).toBe('one');
    expect((await loadCredentials(dir, 'http://two.test'))?.token).toBe('two');
  });

  it('hashes changing dirty content and returns unknown when untracked content exceeds capture limits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'surflet-revision-'));
    await command(directory, 'init');
    await writeFile(join(directory, 'app.js'), 'one');
    await command(directory, 'add', 'app.js');
    await command(
      directory,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'initial',
    );
    await writeFile(join(directory, 'app.js'), 'two');
    const first = await detectRevision(directory);
    await writeFile(join(directory, 'app.js'), 'three');
    expect(await detectRevision(directory)).not.toBe(first);
    await writeFile(join(directory, 'a'), 'bc');
    const beforeRename = await detectRevision(directory);
    await rm(join(directory, 'a'));
    await writeFile(join(directory, 'ab'), 'c');
    expect(await detectRevision(directory)).not.toBe(beforeRename);
    await writeFile(join(directory, 'too-large.js'), Buffer.alloc(64 * 1024 + 1));
    expect(await detectRevision(directory)).toBe('unknown');
  });

  it('requires an exchange before proxying, injects HTML, streams SSE, and forwards CSRF-protected feedback', async () => {
    const app = createServer((request, response) => {
      if (request.url === '/gzip') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.once('end', () =>
          response.end(
            `${request.headers['content-encoding']}:${Buffer.concat(chunks).toString('base64')}`,
          ),
        );
        return;
      }
      if (request.url === '/hold') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: connected\n\n');
        const timer = setInterval(() => response.write('data: tick\n\n'), 20);
        request.once('close', () => clearInterval(timer));
        return;
      }
      if (request.url === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: one\n\n');
        setTimeout(() => response.end('data: two\n\n'), 5);
        return;
      }
      if (request.url === '/bin') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(Buffer.from([0, 255, 1]));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><head><title>x</title></head><body>ok</body></html>');
    });
    const appSockets = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => (protocols.has('surflet-v2') ? 'surflet-v2' : false),
    });
    app.on('upgrade', (request, socket, head) =>
      appSockets.handleUpgrade(request, socket, head, (client) =>
        client.on('message', (message, isBinary) => client.send(message, { binary: isBinary })),
      ),
    );
    const appUrl = await listen(app);
    const service = await fixtureService();
    const dir = await mkdtemp(join(tmpdir(), 'surflet-connector-'));
    const handle = await startShare({
      server: service.base,
      port: Number(new URL(appUrl).port),
      mode: 'local',
      configDir: dir,
      reporterScript: 'window.__surfletReporter=true;',
    });
    expect((await fetch(`${handle.connectorUrl}/`, { redirect: 'manual' })).status).toBe(401);
    const access = await handle.client.getAccess(handle.preview.id);
    const exchanged = await fetch(access.targetUrl, { redirect: 'manual' });
    expect(exchanged.status).toBe(302);
    expect(exchanged.headers.get('location')).toBe('/trial?from=portal');
    const setCookie = exchanged.headers.getSetCookie();
    expect(setCookie[0]).toMatch(/^surflet_session_preview1=/);
    const cookie = setCookie.map((value) => value.split(';', 1)[0]).join('; ');
    const csrf = /surflet_csrf_preview-1=([^;]+)/.exec(setCookie.join(';'))?.[1];
    expect(csrf).toBeTruthy();
    const html = await (await fetch(`${handle.connectorUrl}/`, { headers: { cookie } })).text();
    expect(html).toContain('/__surflet/client.js');
    const binary = new Uint8Array(
      await (await fetch(`${handle.connectorUrl}/bin`, { headers: { cookie } })).arrayBuffer(),
    );
    expect([...binary]).toEqual([0, 255, 1]);
    const compressed = gzipSync('request bytes');
    const gzip = await (
      await fetch(`${handle.connectorUrl}/gzip`, {
        method: 'POST',
        headers: { cookie, origin: handle.connectorUrl, 'content-encoding': 'gzip' },
        body: compressed,
      })
    ).text();
    expect(gzip).toBe(`gzip:${compressed.toString('base64')}`);
    expect(
      (
        await fetch(`${handle.connectorUrl}/gzip`, {
          method: 'POST',
          headers: { cookie },
          body: compressed,
        })
      ).status,
    ).toBe(403);
    expect(
      await (await fetch(`${handle.connectorUrl}/events`, { headers: { cookie } })).text(),
    ).toContain('data: two');
    const echoed = await new Promise<{ text: string; binary: number[] }>((resolve, reject) => {
      const socket = new WebSocket(
        `${handle.connectorUrl.replace('http', 'ws')}/socket`,
        ['surflet-v1', 'surflet-v2'],
        { headers: { cookie, origin: handle.connectorUrl } },
      );
      let text = '';
      socket.once('open', () => {
        expect(socket.protocol).toBe('surflet-v2');
        socket.send('hello');
      });
      socket.on('message', (message, isBinary) => {
        if (!isBinary) {
          text = message.toString();
          socket.send(Buffer.from([0, 255, 1]));
          return;
        }
        socket.close();
        if (!Buffer.isBuffer(message)) return reject(new Error('Expected a Node Buffer frame'));
        resolve({ text, binary: [...message] });
      });
      socket.once('error', reject);
    });
    expect(echoed).toEqual({ text: 'hello', binary: [0, 255, 1] });
    const feedback = await fetch(`${handle.connectorUrl}/__surflet/feedback`, {
      method: 'POST',
      headers: {
        cookie,
        origin: handle.connectorUrl,
        'x-surflet-csrf': csrf!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'token=secret',
        pageUrl: 'http://example.test/a?secret=no',
        revision: 'test',
      }),
    });
    expect(feedback.status).toBe(201);
    expect(await feedback.json()).toEqual({ feedback: { id: 'feedback-1', status: 'open' } });
    const held = await fetch(`${handle.connectorUrl}/hold`, { headers: { cookie } });
    expect((await held.body!.getReader().read()).value).toBeTruthy();
    expect(
      await Promise.race([
        handle.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]),
    ).toBe(true);
    expect(service.calls).toContain('POST /api/previews/preview-1/stop');
  });

  it('keeps log evidence private, skips symlink logs, and bounds correlated proxy errors', async () => {
    const app = createServer((request, response) => {
      if (request.url?.startsWith('/error/')) return response.writeHead(500).end('failed');
      response.end('ok');
    });
    const appUrl = await listen(app);
    const service = await fixtureService();
    const dir = await mkdtemp(join(tmpdir(), 'surflet-evidence-'));
    const secret = join(dir, 'secret.log');
    const linked = join(dir, 'linked.log');
    await writeFile(secret, 'FATAL token=do-not-leak');
    await symlink(secret, linked);
    const handle = await startShare({
      server: service.base,
      port: Number(new URL(appUrl).port),
      mode: 'local',
      configDir: dir,
      reporterScript: '',
      logFiles: [{ service: 'app', path: linked }],
    });
    const access = await handle.client.getAccess(handle.preview.id);
    const exchange = await fetch(access.targetUrl, { redirect: 'manual' });
    const cookies = exchange.headers.getSetCookie();
    const cookie = cookies.map((value) => value.split(';', 1)[0]).join('; ');
    const csrf = /surflet_csrf_preview-1=([^;]+)/.exec(cookies.join(';'))?.[1];
    const failed = await fetch(`${handle.connectorUrl}/error/${'x'.repeat(2100)}`, {
      headers: { cookie },
    });
    const requestId = failed.headers.get('x-surflet-request-id');
    expect(failed.status).toBe(500);
    const feedback = await fetch(`${handle.connectorUrl}/__surflet/feedback`, {
      method: 'POST',
      headers: {
        cookie,
        origin: handle.connectorUrl,
        'x-surflet-csrf': csrf!,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'report',
        networkErrors: [{ url: 'http://app.test/error', method: 'GET', status: 500, requestId }],
      }),
    });
    expect(await feedback.text()).not.toContain('do-not-leak');
    const evidence = service.feedbackBodies[0]?.backendErrors as Array<{
      path?: string;
      requestId?: string;
      message: string;
    }>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.requestId).toBe(requestId);
    expect(evidence[0]?.path?.length).toBeLessThanOrEqual(2048);
    expect(evidence[0]?.message).not.toContain('do-not-leak');
    await handle.close();
  });

  it('stops the preview when a ready Quick Tunnel exits', async () => {
    vi.spyOn(publicReadiness, 'waitForQuickTunnel').mockResolvedValue();
    const app = createServer((_request, response) => response.end('ok'));
    const appUrl = await listen(app);
    const service = await fixtureService();
    const dir = await mkdtemp(join(tmpdir(), 'surflet-connector-'));
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let killed = false;
    Object.assign(child, {
      stdout,
      stderr,
      get killed() {
        return killed;
      },
      kill: () => {
        killed = true;
        queueMicrotask(() => child.emit('close', 0, 'SIGTERM'));
        return true;
      },
    });
    const spawnProcess = (() => {
      queueMicrotask(() => stderr.write('INF https://ready.trycloudflare.com'));
      return child;
    }) as typeof spawn;
    const handle = await startShare({
      server: service.base,
      port: Number(new URL(appUrl).port),
      mode: 'quick',
      configDir: dir,
      reporterScript: '',
      spawnProcess,
    });
    child.emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      service.calls.filter((call) => call === 'POST /api/previews/preview-1/stop'),
    ).toHaveLength(1);
    expect(killed).toBe(true);
    await handle.close();
  });

  it('waits for public readiness before publishing a Quick share and cancels pending startup', async () => {
    const service = await fixtureService();
    const dir = await mkdtemp(join(tmpdir(), 'surflet-startup-'));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    const child = new EventEmitter() as ChildProcess;
    const stderr = new PassThrough();
    const kill = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0, 'SIGTERM'));
      return true;
    });
    Object.assign(child, { stdout: new PassThrough(), stderr, kill });
    const spawnProcess = (() => {
      queueMicrotask(() => stderr.write('INF https://startup.trycloudflare.com'));
      return child;
    }) as typeof spawn;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let readinessSignal: AbortSignal | undefined;
    vi.spyOn(publicReadiness, 'waitForQuickTunnel').mockImplementation(async (_url, signal) => {
      readinessSignal = signal;
      entered();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const caller = new AbortController();
    let published = false;
    const sharing = startShare({
      server: service.base,
      port: 3000,
      mode: 'quick',
      revision: 'startup',
      configDir: dir,
      reporterScript: '',
      spawnProcess,
      signal: caller.signal,
    });
    void sharing.then(
      () => {
        published = true;
      },
      () => {},
    );
    try {
      await waiting;
      expect(published).toBe(false);
      expect(service.calls).toContain('POST /api/previews/preview-1/heartbeat');
      caller.abort();
      await expect(sharing).rejects.toThrow();
      expect(readinessSignal?.aborted).toBe(true);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(service.calls.filter((call) => call.endsWith('/stop'))).toHaveLength(1);
    } finally {
      caller.abort();
      await sharing.catch(() => undefined);
    }
  });

  it('terminates a Quick Tunnel when its caller cancels before the URL is produced', async () => {
    const service = await fixtureService();
    const dir = await mkdtemp(join(tmpdir(), 'surflet-cancel-quick-'));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    const child = new EventEmitter() as ChildProcess;
    const kill = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('exit', 0, 'SIGTERM');
        child.emit('close', 0, 'SIGTERM');
      });
      return true;
    });
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill });
    let spawned!: () => void;
    const started = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const spawnProcess = (() => {
      spawned();
      return child;
    }) as typeof spawn;
    const caller = new AbortController();
    const sharing = startShare({
      server: service.base,
      port: 3000,
      mode: 'quick',
      revision: 'startup',
      configDir: dir,
      reporterScript: '',
      spawnProcess,
      signal: caller.signal,
    });
    void sharing.catch(() => undefined);
    try {
      await started;
      caller.abort();
      await expect(sharing).rejects.toThrow('cancelled');
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(service.calls.filter((call) => call.endsWith('/stop'))).toHaveLength(1);
    } finally {
      caller.abort();
      await sharing.catch(() => undefined);
    }
  });

  it('waits for an owned tunnel process and escalates when it ignores SIGTERM', async () => {
    const service = await fixtureService();
    const dir = await mkdtemp(join(tmpdir(), 'surflet-terminate-'));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    vi.spyOn(publicReadiness, 'waitForQuickTunnel').mockResolvedValue();
    let child: ChildProcess | undefined;
    let closed = false;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM',()=>{});process.stderr.write('https://ignore-term.trycloudflare.com\\n');setInterval(()=>{},1000)",
        ],
        options,
      );
      child.once('close', () => {
        closed = true;
      });
      return child;
    }) as typeof spawn;
    let handle: Awaited<ReturnType<typeof startShare>> | undefined;
    try {
      handle = await startShare({
        server: service.base,
        port: 3000,
        mode: 'quick',
        revision: 'test',
        configDir: dir,
        reporterScript: '',
        spawnProcess,
      });
      await handle.close();
      expect(closed).toBe(true);
      expect(child?.signalCode).toBe('SIGKILL');
      expect(() => process.kill(child!.pid!, 0)).toThrow();
      expect(service.calls.filter((call) => call.endsWith('/stop'))).toHaveLength(1);
    } finally {
      await handle?.close();
      if (child && !closed) {
        const done = once(child, 'close');
        child.kill('SIGKILL');
        await done;
      }
    }
  });

  it('routes the longest matching prefix to its selected loopback service', async () => {
    const root = createServer((_request, response) => response.end('root'));
    const api = createServer((request, response) => response.end(`api:${request.url}`));
    const rootUrl = await listen(root);
    const apiUrl = await listen(api);
    const service = await fixtureService();
    const handle = await startShare({
      server: service.base,
      port: Number(new URL(rootUrl).port),
      routes: [{ path: '/api', port: Number(new URL(apiUrl).port), stripPrefix: true }],
      mode: 'local',
      configDir: await mkdtemp(join(tmpdir(), 'surflet-connector-')),
      reporterScript: '',
    });
    const access = await handle.client.getAccess(handle.preview.id);
    const exchange = await fetch(access.targetUrl, { redirect: 'manual' });
    const cookie = exchange.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    const routed = await fetch(`${handle.connectorUrl}/api/health`, { headers: { cookie } });
    expect(await routed.text()).toBe('api:/health');
    expect(routed.headers.get('x-surflet-request-id')).toMatch(/^[a-f0-9]{24}$/);
    const query = await fetch(`${handle.connectorUrl}/search?q=https%3A%2F%2Fexample.com`, {
      headers: { cookie },
    });
    expect(query.status).toBe(200);
    const connector = new URL(handle.connectorUrl);
    const rawStatus = (path: string, headers: Record<string, string> = { cookie }) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: connector.hostname,
            port: connector.port,
            path,
            headers,
          },
          (response) => resolve(response.statusCode ?? 0),
        );
        request.once('error', reject);
        request.end();
      });
    expect(await rawStatus('/api/%2e%2e/secret')).toBe(400);
    expect(await rawStatus('/api/../secret')).toBe(400);
    expect(await rawStatus('/api\\secret')).toBe(400);
    expect(await rawStatus('//[', { cookie: '' })).toBe(400);
    expect(await rawStatus('/', { cookie: '', host: '[' })).toBe(400);
    await handle.close();
  });

  it('rolls back the proxy and preview when Quick Tunnel exits before producing a URL', async () => {
    const app = createServer((_request, response) => response.end('ok'));
    const appUrl = await listen(app);
    const service = await fixtureService();
    const dir = await mkdtemp(join(tmpdir(), 'surflet-connector-'));
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: () => {
        queueMicrotask(() => child.emit('close', 0, 'SIGTERM'));
        return true;
      },
    });
    const spawnProcess = (() => {
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    }) as typeof spawn;
    await expect(
      startShare({
        server: service.base,
        port: Number(new URL(appUrl).port),
        mode: 'quick',
        configDir: dir,
        reporterScript: '',
        spawnProcess,
      }),
    ).rejects.toThrow('cloudflared exited');
    expect(
      service.calls.filter((call) => call === 'POST /api/previews/preview-1/stop'),
    ).toHaveLength(1);
  });

  it.each([500, 503, 429, 408, 'reset', 'timeout'] as const)(
    'recovers from one transient %s heartbeat failure inside the original lease',
    async (failure) => {
      const fixture = await heartbeatFixture((count, signal) => {
        if (count !== 2) return heartbeatOk();
        if (failure === 'reset') throw new TypeError('fetch failed: ECONNRESET');
        if (failure === 'timeout')
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        return Response.json({ error: 'temporary failure' }, { status: failure });
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.revisions).toHaveLength(2);
      expect((await fixture.probe()).body).toBe('app ok');
      await vi.advanceTimersByTimeAsync(failure === 'timeout' ? 20_000 : 10_000);
      expect(fixture.revisions).toHaveLength(3);
      expect(fixture.calls).not.toContain(stopPath);
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await fixture.probe()).body).toBe('app ok');
      expect(fixture.maxActive).toBe(1);
      expect(fixture.calls.filter((path) => path === '/api/previews')).toHaveLength(1);
    },
  );

  it('closes exactly at the original 35s lease when all later heartbeats fail', async () => {
    const fixture = await heartbeatFixture((count) =>
      count === 1 ? heartbeatOk() : Response.json({ error: 'unavailable' }, { status: 503 }),
    );
    await vi.advanceTimersByTimeAsync(34_999);
    expect(fixture.revisions).toHaveLength(4);
    expect((await fixture.probe()).status).toBe(200);
    expect(fixture.calls).not.toContain(stopPath);
    await vi.advanceTimersByTimeAsync(1);
    await expect(fixture.probe()).rejects.toThrow();
    await new Promise(setImmediate);
    expect(fixture.calls.filter((path) => path === stopPath)).toHaveLength(1);
  });

  it.each([401, 403, 404, 409])('fails closed immediately on heartbeat HTTP %s', async (status) => {
    const fixture = await heartbeatFixture((count) =>
      count === 1 ? heartbeatOk() : Response.json({ error: 'revoked or expired' }, { status }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(fixture.probe()).rejects.toThrow();
    await new Promise(setImmediate);
    expect(fixture.calls.filter((path) => path === stopPath)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.revisions).toHaveLength(2);
  });

  it('serializes a slow heartbeat and aborts its timeout before retrying', async () => {
    let pendingSignal: AbortSignal | undefined;
    const fixture = await heartbeatFixture((count, signal) => {
      if (count !== 2) return heartbeatOk();
      pendingSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(fixture.revisions).toHaveLength(2);
    expect(pendingSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pendingSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.revisions).toHaveLength(3);
    expect(fixture.maxActive).toBe(1);
    expect((await fixture.probe()).body).toBe('app ok');
  });

  it('shares concurrent close completion, aborts in-flight work and ignores late success', async () => {
    const late = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fixture = await heartbeatFixture((count, requestSignal) => {
      if (count !== 2) return heartbeatOk();
      signal = requestSignal;
      return late.promise;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    let finished = false;
    const first = fixture.handle.close();
    first.then(() => {
      finished = true;
    });
    expect(fixture.handle.close()).toBe(first);
    expect(signal?.aborted).toBe(true);
    await expect(fixture.probe()).rejects.toThrow();
    expect(finished).toBe(false);
    late.resolve(heartbeatOk());
    await first;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(fixture.probe()).rejects.toThrow();
    expect(fixture.revisions).toHaveLength(2);
    expect(fixture.calls.filter((path) => path === stopPath)).toHaveLength(1);
  });

  it('bounds a pending request by the remaining lease and never accepts success at expiry', async () => {
    const late = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fixture = await heartbeatFixture((count, requestSignal) => {
      if (count === 1) return heartbeatOk();
      if (count < 4) return Response.json({ error: 'unavailable' }, { status: 503 });
      signal = requestSignal;
      return late.promise;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal?.aborted).toBe(true);
    await expect(fixture.probe()).rejects.toThrow();
    late.resolve(heartbeatOk());
    await fixture.handle.close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.revisions).toHaveLength(4);
    expect(fixture.calls.filter((path) => path === stopPath)).toHaveLength(1);
  });

  it('enforces fixed preview expiry even with successful heartbeats', async () => {
    const fixture = await heartbeatFixture(heartbeatOk, { expiresIn: 25_000 });
    await vi.advanceTimersByTimeAsync(24_999);
    expect((await fixture.probe()).status).toBe(200);
    await vi.advanceTimersByTimeAsync(1);
    await expect(fixture.probe()).rejects.toThrow();
    await new Promise(setImmediate);
    expect(fixture.calls).toContain(stopPath);
  });

  it('uses unknown when initial revision capture rejects before its internal catch', async () => {
    vi.spyOn(process, 'cwd').mockImplementationOnce(() => {
      throw new Error('cwd unavailable');
    });
    const fixture = await heartbeatFixture(heartbeatOk, { automaticRevision: true });
    expect(fixture.createdRevision).toBe('unknown');
    expect(fixture.revisions).toEqual(['unknown']);
    expect((await fixture.probe()).status).toBe(200);
  });

  it('replaces a known revision with unknown when recurring capture rejects', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'surflet-heartbeat-revision-'));
    closers.push(() => rm(repository, { recursive: true, force: true }));
    await command(repository, 'init');
    await command(
      repository,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repository);
    const fixture = await heartbeatFixture(heartbeatOk, { automaticRevision: true });
    expect(fixture.createdRevision).toMatch(/^[a-f0-9]{40}$/);
    cwd.mockImplementationOnce(() => {
      throw new Error('cwd unavailable');
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.revisions).toHaveLength(2);
    expect(fixture.revisions[1]).toBe('unknown');
    expect(JSON.parse((await fixture.probe('/__surflet/context')).body).revision).toBe('unknown');
    expect(fixture.calls).not.toContain(stopPath);
  });
});
