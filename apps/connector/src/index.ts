import { createRequire } from 'node:module';
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_FEEDBACK_BODY_BYTES,
  OFFLINE_AFTER_MS,
  SurfletClient,
  ApiError,
  type CreatedPreview,
  type Preview,
  redactText,
  type BackendError,
  type FeedbackInput,
  type LocalRoute,
  type LogFile,
  localRoutesSchema,
  logFilesSchema,
} from '@surflet/core';

const require = createRequire(import.meta.url);
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 100;
const DEFAULT_SERVER = 'http://127.0.0.1:4504';

import { waitForPublicTunnel, waitForQuickTunnel } from './public-ready.js';

function requestUrl(raw: string) {
  const path = raw.split(/[?#]/, 1)[0] ?? '/';
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /(?:%2e|%2f|%5c)/i.test(path) ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  )
    return;
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return;
  }
}

export type TunnelMode = 'quick' | 'named' | 'local';
export interface ShareOptions {
  server: string;
  port: number;
  routes?: LocalRoute[];
  logFiles?: LogFile[];
  name?: string;
  ttlMinutes?: number;
  mode?: TunnelMode;
  configDir?: string;
  projectDir?: string;
  revision?: string;
  cloudflaredPath?: string;
  reporterScript?: string;
  spawnProcess?: typeof spawn;
  signal?: AbortSignal;
}
export interface ShareHandle {
  preview: Preview;
  shareUrl: string;
  connectorUrl: string;
  client: SurfletClient;
  portalUrl: string;
  close(): Promise<void>;
}
interface Credentials {
  token: string;
  workspaceId?: string;
  name?: string;
  server?: string;
}
interface Session {
  value: string;
  csrf: string;
  expiresAt: number;
}

function configPath(configDir?: string, server = DEFAULT_SERVER) {
  const root =
    configDir ??
    process.env.SURFLET_CONFIG_DIR ??
    join(process.env.HOME ?? process.cwd(), '.config', 'surflet');
  const key = createHash('sha256').update(server.replace(/\/$/, '')).digest('hex').slice(0, 16);
  return join(root, `credentials-${key}.json`);
}
export async function loadCredentials(
  configDir?: string,
  server = DEFAULT_SERVER,
): Promise<Credentials | undefined> {
  try {
    const value = JSON.parse(await readFile(configPath(configDir, server), 'utf8')) as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as Credentials).token !== 'string' ||
      !(value as Credentials).token
    )
      throw new Error('credential file has no token');
    return value as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `Unable to read Surflet credentials at ${configPath(configDir, server)}: ${
        error instanceof Error ? error.message : 'invalid file'
      }. Move the file aside or restore it from a secure backup.`,
    );
  }
}
const enrollments = new Map<string, Promise<SurfletClient>>();
async function credentialLock(file: string) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  const owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex') });
  const candidate = `${lock}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const prepared = await open(candidate, 'wx', 0o600);
  try {
    await prepared.writeFile(owner);
    await prepared.sync();
    await prepared.close();
    for (;;) {
      try {
        // Publish the complete owner record atomically; a killed writer cannot
        // leave an empty lock between exclusive creation and initialization.
        await link(candidate, lock);
        return async () => {
          const current = await readFile(lock, 'utf8').catch(() => undefined);
          if (current === owner) await unlink(lock).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const current = JSON.parse(await readFile(lock, 'utf8')) as { pid?: unknown };
          const pid =
            typeof current.pid === 'number' && Number.isInteger(current.pid)
              ? current.pid
              : undefined;
          let ownerDead = false;
          if (pid) {
            try {
              process.kill(pid, 0);
            } catch (ownerError) {
              ownerDead = (ownerError as NodeJS.ErrnoException).code === 'ESRCH';
            }
          }
          if (ownerDead) {
            await unlink(lock);
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          if (lockError instanceof SyntaxError) {
            const info = await lstat(lock).catch(() => undefined);
            if (info?.isFile() && Date.now() - info.mtimeMs > 60_000) {
              await unlink(lock).catch(() => undefined);
              continue;
            }
          }
        }
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for Surflet credential enrollment lock: ${lock}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } finally {
    await prepared.close().catch(() => undefined);
    await unlink(candidate).catch(() => undefined);
  }
}
export async function saveCredentials(value: Credentials, configDir?: string) {
  const file = configPath(configDir, value.server);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(file, 0o600);
}
export async function workspaceClient(
  server = DEFAULT_SERVER,
  configDir?: string,
  name = 'Local workspace',
) {
  const saved = await loadCredentials(configDir, server);
  if (saved?.token) return new SurfletClient(server, saved.token);
  const file = configPath(configDir, server);
  const existing = enrollments.get(file);
  if (existing) return existing;
  const enrollment = (async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const release = await credentialLock(file);
    try {
      const afterLock = await loadCredentials(configDir, server);
      if (afterLock?.token) return new SurfletClient(server, afterLock.token);
      const anonymous = new SurfletClient(server);
      const created = await anonymous.createWorkspace(name);
      await saveCredentials(
        {
          token: created.token,
          workspaceId: created.workspace.id,
          name: created.workspace.name,
          server,
        },
        configDir,
      );
      return new SurfletClient(server, created.token);
    } finally {
      await release();
    }
  })();
  enrollments.set(file, enrollment);
  try {
    return await enrollment;
  } finally {
    enrollments.delete(file);
  }
}
export async function getClient(options: {
  server: string;
  configDir?: string;
  workspaceName?: string;
}) {
  const saved = await loadCredentials(options.configDir, options.server);
  if (!saved)
    throw new Error(
      'No Surflet credentials found. Start a share or run an explicit workspace enrollment before using read-only tools.',
    );
  return new SurfletClient(options.server, saved.token);
}

function assertPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('port must be between 1 and 65535');
}
function cookieValue(request: IncomingMessage, name: string) {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function isHtml(
  headers: IncomingMessage['headers'] | Record<string, string | string[] | undefined>,
) {
  const contentType = headers['content-type'];
  const encoding = headers['content-encoding'];
  return (
    typeof contentType === 'string' &&
    /(?:^|;)\s*text\/html\b/i.test(contentType) &&
    (!encoding || encoding === 'identity')
  );
}
function compatibleCsp(value: string | string[] | undefined) {
  if (!value) return true;
  const source = Array.isArray(value) ? value.join(';') : value;
  const policy = source
    .split(';')
    .map((v) => v.trim())
    .find((v) => /^(script-src|default-src)\b/i.test(v));
  if (!policy) return true;
  const tokens = policy.split(/\s+/).slice(1);
  return tokens.includes("'self'") || tokens.includes('*');
}
function reporterTag() {
  return '<script src="/__surflet/client.js" defer></script>';
}
function injectReporter(html: string) {
  const tag = reporterTag();
  if (html.includes('/__surflet/client.js')) return html;
  const match = /<\/head\s*>/i.exec(html);
  return match ? `${html.slice(0, match.index)}${tag}${html.slice(match.index)}` : `${html}${tag}`;
}
function contentHeaders(headers: IncomingMessage['headers']) {
  const result: Record<string, string | string[] | undefined> = { ...headers };
  delete result.host;
  delete result.connection;
  delete result['content-length'];
  return result;
}
function localTarget(port: number, request: IncomingMessage, cookieNames: string[]) {
  const headers = contentHeaders(request.headers);
  const rawCookies = request.headers.cookie;
  if (rawCookies) {
    const cookie = rawCookies
      .split(';')
      .map((value) => value.trim())
      .filter((value) => !cookieNames.some((name) => value.startsWith(`${name}=`)))
      .join('; ');
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
  }
  return { hostname: '127.0.0.1', port, path: request.url ?? '/', method: request.method, headers };
}
const MAX_GIT_OUTPUT = 512 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 512 * 1024;

function git(projectDir: string, args: string[], limit = MAX_GIT_OUTPUT) {
  return new Promise<Buffer>((resolveOutput, reject) => {
    const child = spawn('git', ['-C', projectDir, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveOutput(output!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 100).unref();
      finish(new Error('git timed out'));
    }, 5_000);
    child.stdout.on('data', (value: Buffer) => {
      total += value.length;
      if (total > limit) {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 100).unref();
        return;
      }
      chunks.push(value);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (total > limit) finish(new Error('git output exceeded limit'));
      else if (code === 0) finish(undefined, Buffer.concat(chunks));
      else finish(new Error('git command failed'));
    });
  });
}

export async function detectRevision(projectDir = process.cwd()) {
  try {
    const root = resolve(projectDir);
    const [head, diff, untracked] = await Promise.all([
      git(root, ['rev-parse', 'HEAD'], 128),
      git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD'], MAX_GIT_OUTPUT),
      git(root, ['ls-files', '--others', '--exclude-standard', '-z'], MAX_GIT_OUTPUT),
    ]);
    if (!diff.length && !untracked.length) return head.toString('utf8').trim().slice(0, 64);
    const digest = createHash('sha256');
    const hashPart = (part: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(part.length);
      digest.update(length).update(part);
    };
    hashPart(head);
    hashPart(diff);
    let bytes = 0;
    for (const relative of untracked.toString('utf8').split('\0').filter(Boolean).sort()) {
      const file = resolve(root, relative);
      if (!file.startsWith(`${root}/`)) throw new Error('invalid untracked path');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_UNTRACKED_FILE_BYTES)
        throw new Error('untracked content cannot be captured safely');
      bytes += info.size;
      if (bytes > MAX_UNTRACKED_TOTAL_BYTES) throw new Error('untracked content exceeded limit');
      const descriptor = await open(
        file,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      try {
        const opened = await descriptor.stat();
        if (!opened.isFile() || opened.size !== info.size)
          throw new Error('untracked file changed');
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
        const after = await descriptor.stat();
        if (bytesRead !== info.size || after.size !== info.size)
          throw new Error('untracked file changed');
        hashPart(Buffer.from(relative));
        hashPart(buffer.subarray(0, bytesRead));
      } finally {
        await descriptor.close();
      }
    }
    return `${head.toString('utf8').trim().slice(0, 40)}+${digest.digest('hex').slice(0, 20)}`;
  } catch {
    return 'unknown';
  }
}
async function reporterBundle(provided?: string) {
  if (provided !== undefined) return provided;
  try {
    return await readFile(require.resolve('@surflet/reporter/bundle'), 'utf8');
  } catch {
    return 'console.warn("Surflet reporter bundle is unavailable");';
  }
}

class LocalProxy {
  private readonly sessions = new Map<string, Session>();
  private pendingSessions = 0;
  private readonly sockets = new Set<WebSocket>();
  private readonly connections = new Set<import('node:net').Socket>();
  private readonly upstreams = new Set<ClientRequest>();
  private readonly backendErrors: BackendError[] = [];
  private readonly server = createServer(this.handle.bind(this));
  port = 0;
  private listening = false;
  private cookieName: string;
  private publicOrigin?: string;
  constructor(
    private readonly input: {
      preview: Preview;
      client: SurfletClient;
      appPort: number;
      routes: LocalRoute[];
      logFiles: LogFile[];
      reporter: string;
      portalUrl: string;
      active: () => boolean;
    },
  ) {
    this.cookieName = `__Host-surflet-${input.preview.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`;
    this.server.on('upgrade', this.upgrade.bind(this));
    this.server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });
  }
  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.listening = true;
    this.port = (this.server.address() as { port: number }).port;
  }
  setPublicOrigin(value: string) {
    this.publicOrigin = new URL(value).origin;
    this.cookieName =
      new URL(value).protocol === 'https:'
        ? `__Host-surflet-${this.input.preview.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`
        : `surflet_session_${this.input.preview.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`;
  }
  async close() {
    for (const socket of this.sockets) socket.terminate();
    for (const upstream of this.upstreams) upstream.destroy();
    for (const connection of this.connections) connection.destroy();
    this.sessions.clear();
    this.pendingSessions = 0;
    if (!this.listening) return;
    this.listening = false;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private active(request: IncomingMessage) {
    if (
      !this.hostMatches(request) ||
      !this.input.active() ||
      Date.parse(this.input.preview.expiresAt) <= Date.now()
    )
      return false;
    const token = cookieValue(request, this.cookieName);
    const session = token ? this.sessions.get(token) : undefined;
    return Boolean(session && session.expiresAt > Date.now());
  }
  private hostMatches(request: IncomingMessage) {
    return Boolean(
      this.publicOrigin &&
        request.headers.host?.toLowerCase() === new URL(this.publicOrigin).host.toLowerCase(),
    );
  }
  private originMatches(request: IncomingMessage) {
    return request.headers.origin === this.publicOrigin;
  }
  private reject(
    response: ServerResponse,
    code = 401,
    message = 'Surflet access required',
    requestId?: string,
  ) {
    response.writeHead(code, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...(requestId ? { 'x-surflet-request-id': requestId } : {}),
    });
    response.end(JSON.stringify({ error: message }));
  }
  private async exchange(request: IncomingMessage, response: ServerResponse, url: URL) {
    const ticket = url.searchParams.get('__surflet_access') ?? url.searchParams.get('ticket');
    if (!ticket || !this.input.active() || Date.parse(this.input.preview.expiresAt) <= Date.now())
      return this.reject(response);
    this.pruneSessions();
    const existingToken = cookieValue(request, this.cookieName);
    const existing = existingToken ? this.sessions.get(existingToken) : undefined;
    const reuseSession = Boolean(existing && existing.expiresAt > Date.now());
    if (!reuseSession && this.sessions.size + this.pendingSessions >= MAX_SESSIONS)
      return this.reject(response, 429, 'Too many active preview sessions');
    if (!reuseSession) this.pendingSessions += 1;
    try {
      await this.input.client.exchangeAccess(this.input.preview.id, ticket);
    } catch {
      return this.reject(response);
    } finally {
      if (!reuseSession) this.pendingSessions -= 1;
    }
    if (response.destroyed) return;
    if (!this.input.active() || Date.parse(this.input.preview.expiresAt) <= Date.now())
      return this.reject(response, 409, 'Preview is no longer active');
    const path = '/';
    const secure = this.publicOrigin?.startsWith('https:') ? '; Secure' : '';
    url.searchParams.delete('__surflet_access');
    url.searchParams.delete('ticket');
    const location =
      url.pathname === '/__surflet/access' ? '/' : `${url.pathname}${url.search}${url.hash}`;
    if (reuseSession) {
      response.writeHead(302, {
        location,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      response.end();
      return;
    }
    const value = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const maxAge = Math.max(
      1,
      Math.floor((Date.parse(this.input.preview.expiresAt) - Date.now()) / 1000),
    );
    this.sessions.set(value, { value, csrf, expiresAt: Date.now() + maxAge * 1000 });
    response.writeHead(302, {
      location,
      'set-cookie': [
        `${this.cookieName}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
        `surflet_csrf_${this.input.preview.id}=${csrf}; Path=${path}; SameSite=Lax; Max-Age=${maxAge}${secure}`,
      ],
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    response.end();
  }
  private pruneSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(token);
  }
  private csrf(request: IncomingMessage) {
    if (!this.originMatches(request)) return false;
    const sessionToken = cookieValue(request, this.cookieName);
    const session = sessionToken ? this.sessions.get(sessionToken) : undefined;
    return Boolean(
      session &&
        request.headers['x-surflet-csrf'] === session.csrf &&
        cookieValue(request, `surflet_csrf_${this.input.preview.id}`) === session.csrf,
    );
  }
  private async feedback(request: IncomingMessage, response: ServerResponse) {
    try {
      if (!this.csrf(request)) return this.reject(response, 403, 'CSRF validation failed');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_FEEDBACK_BODY_BYTES)
          return this.reject(response, 413, 'Feedback too large');
        chunks.push(bytes);
      }
      const submitted = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FeedbackInput;
      submitted.backendErrors = await this.evidence(
        new Set(
          submitted.networkErrors?.flatMap((error) => (error.requestId ? [error.requestId] : [])),
        ),
      );
      if (typeof submitted.revision !== 'string' || submitted.revision === 'unknown')
        submitted.revision = this.input.preview.revision;
      const created = await this.input.client.submitFeedback(this.input.preview.id, submitted);
      if (response.destroyed) return;
      response.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(
        JSON.stringify({ feedback: { id: created.feedback.id, status: created.feedback.status } }),
      );
    } catch (error) {
      if (request.aborted || response.destroyed || response.writableEnded) return;
      this.reject(
        response,
        error instanceof Error && 'status' in error
          ? Number((error as { status: number }).status)
          : 400,
        error instanceof Error ? error.message : 'Invalid feedback',
      );
    }
  }
  private handle(request: IncomingMessage, response: ServerResponse) {
    if (!this.hostMatches(request)) return this.reject(response, 400, 'Unexpected preview host');
    const url = requestUrl(request.url ?? '/');
    if (!url) return this.reject(response, 400, 'Invalid application route');
    if (
      (url.pathname === '/__surflet/access' || url.searchParams.has('__surflet_access')) &&
      request.method === 'GET'
    )
      return void this.exchange(request, response, url);
    if (!this.active(request)) return this.reject(response);
    if (url.pathname === '/__surflet/client.js' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(this.input.reporter);
      return;
    }
    if (url.pathname === '/__surflet/context' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(
        JSON.stringify({
          previewId: this.input.preview.id,
          name: this.input.preview.name,
          revision: this.input.preview.revision,
          expiresAt: this.input.preview.expiresAt,
          shareUrl: this.input.portalUrl,
        }),
      );
      return;
    }
    if (url.pathname === '/__surflet/feedback' && request.method === 'POST')
      return void this.feedback(request, response);
    if (url.pathname.startsWith('/__surflet/'))
      return this.reject(response, 404, 'Unknown Surflet route');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET') &&
      !this.originMatches(request)
    )
      return this.reject(response, 403, 'Unexpected request origin');
    const route = this.route(request.url ?? '/');
    if (!route) return this.reject(response, 400, 'Invalid application route');
    this.forward(request, response, route);
  }
  private route(raw: string) {
    const url = requestUrl(raw);
    if (!url) return undefined;
    const routes = [
      { path: '/', port: this.input.appPort, stripPrefix: false },
      ...this.input.routes,
    ]
      .filter(
        (route) =>
          route.path === '/' ||
          url.pathname === route.path ||
          url.pathname.startsWith(`${route.path}/`),
      )
      .sort((a, b) => b.path.length - a.path.length);
    const selected = routes[0];
    if (!selected) return undefined;
    const path = selected.stripPrefix
      ? `${url.pathname.slice(selected.path.length) || '/'}${url.search}`
      : `${url.pathname}${url.search}`;
    return { ...selected, requestPath: path };
  }
  private requestId(request: IncomingMessage) {
    const requestId = randomBytes(12).toString('hex');
    delete request.headers['x-surflet-request-id'];
    request.headers['x-surflet-request-id'] = requestId;
    return requestId;
  }
  private record(error: Omit<BackendError, 'source' | 'timestamp' | 'revision'>, revision: string) {
    this.backendErrors.push({
      ...error,
      message: error.message.slice(0, 1500),
      path: error.path?.slice(0, 2048),
      source: 'proxy',
      timestamp: new Date().toISOString(),
      revision,
    });
    if (this.backendErrors.length > 500)
      this.backendErrors.splice(0, this.backendErrors.length - 500);
  }
  private async evidence(requestIds: Set<string>) {
    const logs: BackendError[] = [];
    for (const entry of this.input.logFiles.slice(0, 5)) {
      try {
        const info = await lstat(entry.path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const file = await open(
          entry.path,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
        const size = Math.min(info.size, 64 * 1024);
        const buffer = Buffer.alloc(size);
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.size !== info.size) continue;
          await file.read(buffer, 0, size, Math.max(0, info.size - size));
        } finally {
          await file.close();
        }
        const content = buffer.toString('utf8');
        for (const line of content
          .slice(-64 * 1024)
          .split('\n')
          .filter((line) => /\b(error|exception|fatal|fail)\b/i.test(line))
          .slice(-8))
          logs.push({
            service: entry.service,
            source: 'log',
            message: redactText(line).slice(0, 1500),
            timestamp: new Date().toISOString(),
            revision: this.input.preview.revision,
          });
      } catch {
        /* Opt-in diagnostics must never break feedback. */
      }
    }
    const correlated = this.backendErrors.filter((error) =>
      error.requestId ? requestIds.has(error.requestId) : false,
    );
    const recent = this.backendErrors.filter((error) => !correlated.includes(error)).slice(-20);
    return [...logs, ...recent, ...correlated].slice(-20);
  }
  private forward(
    request: IncomingMessage,
    response: ServerResponse,
    route: { path: string; port: number; requestPath: string },
  ) {
    const requestId = this.requestId(request);
    const revision = this.input.preview.revision;
    const target = localTarget(route.port, request, [
      this.cookieName,
      `surflet_csrf_${this.input.preview.id}`,
      '__surflet_access',
    ]);
    target.path = route.requestPath;
    const upstream = httpRequest(target, (app) => {
      app.once('error', () => response.destroy());
      let htmlTimer: NodeJS.Timeout | undefined;
      const stopHtmlTimer = () => {
        if (htmlTimer) clearTimeout(htmlTimer);
        htmlTimer = undefined;
      };
      response.once('close', () => {
        stopHtmlTimer();
        app.destroy();
      });
      app.once('error', stopHtmlTimer);
      const headers: Record<string, string | string[] | undefined> = Object.fromEntries(
        Object.entries(app.headers).map(([key, value]) => [
          key,
          typeof value === 'number' ? String(value) : value,
        ]),
      );
      headers['x-surflet-request-id'] = requestId;
      if ((app.statusCode ?? 0) >= 500)
        this.record(
          {
            service: route.path ?? 'app',
            message: `Upstream returned ${app.statusCode}`,
            status: app.statusCode,
            path: request.url?.split('?')[0],
            requestId,
          },
          revision,
        );
      const html = isHtml(headers) && compatibleCsp(headers['content-security-policy']);
      if (!html) {
        if (isHtml(headers)) headers['x-surflet-reporter'] = 'portal-fallback';
        response.writeHead(app.statusCode ?? 502, headers);
        app.pipe(response);
        return;
      }
      const length = headers['content-length'];
      const size = typeof length === 'string' ? Number(length) : Number.NaN;
      if (Number.isFinite(size) && (size < 0 || size > MAX_HTML_BYTES)) {
        headers['x-surflet-reporter'] = 'portal-fallback';
        response.writeHead(app.statusCode ?? 502, headers);
        app.pipe(response);
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let fallback = false;
      const streamFallback = () => {
        if (fallback || response.destroyed) return;
        fallback = true;
        stopHtmlTimer();
        headers['x-surflet-reporter'] = 'portal-fallback';
        app.pause();
        response.writeHead(app.statusCode ?? 502, headers);
        if (chunks.length) response.write(Buffer.concat(chunks));
        chunks.length = 0;
        app.pipe(response);
      };
      htmlTimer = setTimeout(streamFallback, 100);
      app.on('data', (chunk) => {
        if (fallback) return;
        total += chunk.length;
        if (total <= MAX_HTML_BYTES) {
          chunks.push(Buffer.from(chunk));
          return;
        }
        chunks.push(Buffer.from(chunk));
        streamFallback();
      });
      app.once('end', () => {
        stopHtmlTimer();
        if (fallback) return;
        if (total > MAX_HTML_BYTES) {
          response.writeHead(502, {
            'content-type': 'text/plain',
            'x-surflet-request-id': requestId,
          });
          response.end('Surflet cannot safely inject reporter into this response');
          return;
        }
        const text = injectReporter(Buffer.concat(chunks).toString('utf8'));
        delete headers['transfer-encoding'];
        headers['content-length'] = Buffer.byteLength(text).toString();
        response.writeHead(app.statusCode ?? 502, headers);
        response.end(text);
      });
    });
    response.once('close', () => upstream.destroy());
    request.once('aborted', () => upstream.destroy());
    this.upstreams.add(upstream);
    const cleanup = () => this.upstreams.delete(upstream);
    upstream.once('close', cleanup);
    upstream.once('error', () => {
      cleanup();
      if (response.destroyed || request.aborted) return;
      this.record(
        {
          service: 'proxy',
          message: 'Local application is unavailable',
          status: 502,
          path: request.url?.split('?')[0],
          requestId,
        },
        revision,
      );
      if (!response.headersSent)
        this.reject(response, 502, 'Local application is unavailable', requestId);
    });
    request.pipe(upstream);
  }
  private upgrade(request: IncomingMessage, socket: import('node:net').Socket, head: Buffer) {
    const route = this.route(request.url ?? '/');
    if (!route || !this.active(request) || !this.originMatches(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const protocols = request.headers['sec-websocket-protocol'];
    const requestedProtocols = Array.isArray(protocols)
      ? protocols
      : protocols?.split(',').map((v) => v.trim());
    if (
      requestedProtocols?.some(
        (protocol) => !protocol || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol),
      )
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    const connection = request.headers.connection;
    const validKey =
      typeof key === 'string' &&
      /^[A-Za-z0-9+/]{22}==$/.test(key) &&
      Buffer.from(key, 'base64').byteLength === 16;
    if (
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      version !== '13' ||
      !validKey ||
      !connection
        ?.toLowerCase()
        .split(',')
        .map((value) => value.trim())
        .includes('upgrade')
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstreamHeaders = localTarget(route.port, request, [
      this.cookieName,
      `surflet_csrf_${this.input.preview.id}`,
      '__surflet_access',
    ]).headers;
    upstreamHeaders['x-surflet-request-id'] = this.requestId(request);
    let upstream: WebSocket | undefined;
    const downstreamGone = () => upstream?.terminate();
    socket.once('close', downstreamGone);
    socket.once('error', downstreamGone);
    try {
      upstream = new WebSocket(
        `ws://127.0.0.1:${route.port}${route.requestPath}`,
        requestedProtocols,
        { headers: upstreamHeaders },
      );
    } catch {
      socket.removeListener('close', downstreamGone);
      socket.removeListener('error', downstreamGone);
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let upgraded = false;
    this.sockets.add(upstream);
    const fail = () => {
      this.sockets.delete(upstream);
      if (!upgraded) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
      upstream?.terminate();
    };
    upstream.once('error', fail);
    upstream.once('open', () => {
      if (
        !this.input.active() ||
        (requestedProtocols?.length &&
          upstream.protocol &&
          !requestedProtocols.includes(upstream.protocol))
      )
        return fail();
      const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: () => upstream.protocol || false,
      });
      try {
        wss.handleUpgrade(request, socket, head, (client) => {
          upgraded = true;
          this.sockets.add(client);
          const close = () => {
            client.terminate();
            upstream?.terminate();
            this.sockets.delete(client);
            this.sockets.delete(upstream!);
          };
          client.on('message', (data, isBinary) => {
            if (upstream?.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
          });
          upstream.on('message', (data, isBinary) => {
            if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
          });
          client.once('close', close);
          upstream.once('close', close);
          client.once('error', close);
          upstream.once('error', close);
        });
      } catch {
        fail();
      }
    });
  }
}

function tunnelUrl(output: string) {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
}
async function startQuick(
  binary: string,
  port: number,
  spawnProcess: typeof spawn,
  signal: AbortSignal,
) {
  const child = trackTunnel(
    spawnProcess(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  let output = '';
  let cancelled: (() => void) | undefined;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for Cloudflare Quick Tunnel')),
        30_000,
      );
      cancelled = () => {
        clearTimeout(timer);
        reject(new DOMException('Quick Tunnel creation cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      const inspect = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-8192);
        const url = tunnelUrl(output);
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      };
      child.stdout?.on('data', inspect);
      child.stderr?.on('data', inspect);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        if (!tunnelUrl(output)) {
          clearTimeout(timer);
          reject(new Error(`cloudflared exited before creating a tunnel (${code ?? 'unknown'})`));
        }
      });
    });
    return { child, url: result };
  } catch (error) {
    await terminate(child);
    throw error;
  } finally {
    if (cancelled) signal.removeEventListener('abort', cancelled);
  }
}
function drainTunnelOutput(child: ChildProcess) {
  child.stdout?.resume();
  child.stderr?.resume();
}
async function waitForNamedTunnel(child: ChildProcess, url: string, signal: AbortSignal) {
  drainTunnelOutput(child);
  let cleanup = () => undefined;
  const exited = new Promise<never>((_resolve, reject) => {
    const failure = (detail: string) =>
      reject(new Error(`cloudflared ${detail} before named tunnel became available`));
    const error = () => failure('failed');
    const exit = (code: number | null) => failure(`exited (${code ?? 'unknown'})`);
    child.once('error', error);
    child.once('exit', exit);
    cleanup = () => {
      child.removeListener('error', error);
      child.removeListener('exit', exit);
    };
  });
  try {
    await Promise.race([waitForPublicTunnel(url, signal), exited]);
  } finally {
    cleanup();
  }
}
const ownedTunnels = new WeakMap<
  ChildProcess,
  {
    closed: Promise<void>;
    done: boolean;
    terminating?: Promise<void>;
  }
>();
function trackTunnel(child: ChildProcess) {
  const state = { closed: Promise.resolve(), done: false } as {
    closed: Promise<void>;
    done: boolean;
    terminating?: Promise<void>;
  };
  state.closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      state.done = true;
      resolve();
    }),
  );
  // A spawn failure can arrive before startup installs its mode-specific handler.
  child.on('error', () => undefined);
  ownedTunnels.set(child, state);
  return child;
}
function terminate(child?: ChildProcess): Promise<void> {
  if (!child) return Promise.resolve();
  const state = ownedTunnels.get(child);
  if (!state) throw new Error('Untracked tunnel process');
  if (state.done) return Promise.resolve();
  state.terminating ??= (async () => {
    const wait = async (milliseconds: number) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          state.closed.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), milliseconds);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    child.kill('SIGTERM');
    if (await wait(500)) return;
    child.kill('SIGKILL');
    if (!(await wait(2000))) throw new Error('Tunnel process did not exit after SIGKILL');
  })();
  return state.terminating;
}

function isPermanentHeartbeatError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

async function resolveHeartbeatRevision(
  explicitRevision?: string,
  projectDir?: string,
): Promise<string> {
  if (explicitRevision !== undefined) return explicitRevision;
  try {
    const detected = await detectRevision(projectDir);
    return detected || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function startShare(options: ShareOptions): Promise<ShareHandle> {
  options.signal?.throwIfAborted();
  assertPort(options.port);
  const routes = localRoutesSchema.parse(options.routes);
  const logFiles = logFilesSchema.parse(options.logFiles);
  const server = options.server.replace(/\/$/, '');
  const mode = options.mode ?? 'quick';
  const client = await workspaceClient(server, options.configDir);
  const revision = await resolveHeartbeatRevision(options.revision, options.projectDir);
  options.signal?.throwIfAborted();
  const created: CreatedPreview = await client.createPreview({
    name: options.name ?? `localhost:${options.port}`,
    port: options.port,
    ttlMinutes: options.ttlMinutes ?? 120,
    mode,
    revision,
    routes,
  });
  const connectorClient = new SurfletClient(server, created.connectorToken);
  const heartbeatRequest = (revision: string, signal?: AbortSignal) =>
    connectorClient.request<{ preview: Preview }>(
      `/api/previews/${encodeURIComponent(created.preview.id)}/heartbeat`,
      {
        method: 'POST',
        body: { revision },
        signal,
      },
    );
  let tunnel: ChildProcess | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let lastHeartbeat = Date.now();
  let heartbeat: NodeJS.Timeout | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let inFlightHeartbeat: Promise<void> | undefined;
  const closeController = new AbortController();

  const active = () => !closed && Date.now() - lastHeartbeat < OFFLINE_AFTER_MS;
  const resetLeaseTimer = () => {
    if (leaseTimer) clearTimeout(leaseTimer);
    const remaining = Math.max(0, OFFLINE_AFTER_MS - (Date.now() - lastHeartbeat));
    leaseTimer = setTimeout(() => {
      if (!active()) void close().catch(() => undefined);
    }, remaining);
  };

  const proxy = new LocalProxy({
    preview: created.preview,
    client: connectorClient,
    appPort: options.port,
    routes,
    logFiles,
    reporter: await reporterBundle(options.reporterScript),
    portalUrl: created.shareUrl.split('#', 1)[0] ?? created.shareUrl,
    active,
  });
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      options.signal?.removeEventListener('abort', cancelStartup);
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      if (leaseTimer) clearTimeout(leaseTimer);
      closeController.abort();
      await Promise.all([
        proxy.close(),
        terminate(tunnel),
        connectorClient.stopPreview(created.preview.id).catch(() => undefined),
      ]);
      await inFlightHeartbeat?.catch(() => undefined);
    })();
    return closePromise;
  };
  const cancelStartup = () => {
    void close().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancelStartup, { once: true });
  try {
    options.signal?.throwIfAborted();
    await proxy.listen();
    if (closed) throw new Error('Preview closed during startup');
    let connectorUrl: string;
    if (mode === 'local') connectorUrl = `http://127.0.0.1:${proxy.port}`;
    else if (mode === 'named') {
      const named = await connectorClient.provisionTunnel(created.preview.id, proxy.port);
      if (closed) throw new Error('Preview closed during startup');
      connectorUrl = named.targetUrl;
      tunnel = trackTunnel(
        (options.spawnProcess ?? spawn)(
          options.cloudflaredPath ?? 'cloudflared',
          ['tunnel', 'run'],
          { env: { ...process.env, TUNNEL_TOKEN: named.token }, stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      );
      drainTunnelOutput(tunnel);
    } else {
      const spawnTunnel = ((
        command: string,
        args: readonly string[],
        childOptions: SpawnOptions = {},
      ) => {
        tunnel = (options.spawnProcess ?? spawn)(command, args, childOptions);
        return tunnel;
      }) as typeof spawn;
      const quick = await startQuick(
        options.cloudflaredPath ?? 'cloudflared',
        proxy.port,
        spawnTunnel,
        closeController.signal,
      );
      tunnel = quick.child;
      connectorUrl = quick.url;
    }
    if (tunnel?.exitCode !== null && tunnel?.exitCode !== undefined)
      throw new Error('cloudflared exited before the preview became available');
    tunnel?.once('exit', () => {
      if (!closed) void close().catch(() => undefined);
    });
    tunnel?.once('error', () => {
      if (!closed) void close().catch(() => undefined);
    });
    proxy.setPublicOrigin(connectorUrl);
    await connectorClient.attachTunnel(created.preview.id, connectorUrl);
    if (closed) throw new Error('Preview closed during startup');
    await heartbeatRequest(
      revision,
      AbortSignal.any([closeController.signal, AbortSignal.timeout(15_000)]),
    );
    if (closed) throw new Error('Preview closed during startup');
    lastHeartbeat = Date.now();
    resetLeaseTimer();
    const expires = Date.parse(created.preview.expiresAt) - Date.now();
    expiry = setTimeout(
      () => {
        void close().catch(() => undefined);
      },
      Math.max(0, expires),
    );
    heartbeat = setInterval(() => {
      if (closed || inFlightHeartbeat) return;
      inFlightHeartbeat = (async () => {
        try {
          const elapsed = Date.now() - lastHeartbeat;
          if (closed || elapsed >= OFFLINE_AFTER_MS) {
            void close().catch(() => undefined);
            return;
          }
          const nextRevision = await resolveHeartbeatRevision(options.revision, options.projectDir);
          const remainingLease = OFFLINE_AFTER_MS - (Date.now() - lastHeartbeat);
          if (closed || remainingLease <= 0) {
            if (!closed) void close().catch(() => undefined);
            return;
          }
          const combinedSignal = AbortSignal.any([
            closeController.signal,
            AbortSignal.timeout(Math.min(15_000, remainingLease)),
          ]);

          await heartbeatRequest(nextRevision, combinedSignal);

          if (closed || Date.now() - lastHeartbeat >= OFFLINE_AFTER_MS) {
            if (!closed) void close().catch(() => undefined);
            return;
          }

          created.preview.revision = nextRevision;
          lastHeartbeat = Date.now();
          resetLeaseTimer();
        } catch (error) {
          if (isPermanentHeartbeatError(error) || !active()) void close().catch(() => undefined);
        } finally {
          inFlightHeartbeat = undefined;
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);
    if (mode === 'quick') await waitForQuickTunnel(connectorUrl, closeController.signal);
    if (mode === 'named') await waitForNamedTunnel(tunnel!, connectorUrl, closeController.signal);
    if (!active()) throw new Error('Preview closed during startup');
    return {
      preview: { ...created.preview, targetUrl: connectorUrl, status: 'online' },
      shareUrl: created.shareUrl,
      portalUrl: created.shareUrl.split('#', 1)[0] ?? created.shareUrl,
      connectorUrl,
      client,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function hostConfigurationHint(hostname: string) {
  return `If your Vite dev server rejects this preview host, set VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${hostname} (the exact Surflet hostname only).`;
}
