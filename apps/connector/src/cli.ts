#!/usr/bin/env node
import { Command } from 'commander';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { feedbackStatuses, shareConfigSchema, SurfletClient } from '@surflet/core';
import { getClient, saveCredentials, startShare, workspaceClient } from './index.js';

const PUBLIC_SERVER = 'https://surflet.app';
const defaultServer = () => process.env.SURFLET_SERVER_URL ?? PUBLIC_SERVER;
const defaultConfigDir = () => process.env.SURFLET_CONFIG_DIR;
type ShareConfig = ReturnType<typeof shareConfigSchema.parse>;

async function shareConfig(file?: string): Promise<{ value: ShareConfig; root?: string }> {
  if (!file) return { value: {} };
  const path = resolve(file);
  const descriptor = await open(path, 'r');
  let value: ShareConfig;
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error('Config must be a regular file no larger than 64 KiB');
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error('Config changed while reading');
    value = shareConfigSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await descriptor.close();
  }
  const root = dirname(path);
  if (value.projectDir && !isAbsolute(value.projectDir))
    value.projectDir = resolve(root, value.projectDir);
  value.logFiles = value.logFiles?.map((entry) => ({
    ...entry,
    path: isAbsolute(entry.path) ? entry.path : resolve(root, entry.path),
  }));
  return { value, root };
}

function route(value: string) {
  const match = /^(\/[^=]+)=(\d+)$/.exec(value);
  if (!match) throw new Error('--route must be PATH=PORT (for example /api=8000)');
  return { path: match[1], port: Number(match[2]), stripPrefix: true };
}

function serverOptions(command: Command) {
  return command
    .option('--server <url>', 'Surflet service URL', defaultServer())
    .option('--config-dir <path>', 'private Surflet credential directory', defaultConfigDir());
}

function dashboardUrl(server: string, token: string) {
  return `${server.replace(/\/$/, '')}/#key=${encodeURIComponent(token)}`;
}

function ownerClient(options: { server: string; configDir?: string }) {
  return getClient({ server: options.server, configDir: options.configDir });
}

function compactPreview(preview: {
  id: string;
  name: string;
  status: string;
  revision: string;
  feedbackCount: number;
  expiresAt: string;
  lastSeenAt: string | null;
}) {
  return {
    id: preview.id,
    name: preview.name,
    status: preview.status,
    revision: preview.revision,
    feedbackCount: preview.feedbackCount,
    expiresAt: preview.expiresAt,
    lastSeenAt: preview.lastSeenAt,
  };
}

function compactFeedback(feedback: {
  id: string;
  status: string;
  message: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  hasScreenshot?: boolean;
  consoleErrorCount?: number;
  networkErrorCount?: number;
  backendErrorCount?: number;
  stepCount?: number;
}) {
  return {
    id: feedback.id,
    status: feedback.status,
    message: feedback.message,
    revision: feedback.revision,
    hasScreenshot: Boolean(feedback.hasScreenshot),
    consoleErrorCount: feedback.consoleErrorCount ?? 0,
    networkErrorCount: feedback.networkErrorCount ?? 0,
    backendErrorCount: feedback.backendErrorCount ?? 0,
    stepCount: feedback.stepCount ?? 0,
    createdAt: feedback.createdAt,
    updatedAt: feedback.updatedAt,
  };
}

function installSignalCancellation(controller: AbortController) {
  const cancel = () => controller.abort(new Error('Share startup cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  return () => {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  };
}

export function createProgram() {
  const program = new Command()
    .name('surflet')
    .description('Share a selected local prototype for feedback.');
  serverOptions(
    program
      .command('login')
      .option('--name <name>', 'workspace name', 'Local workspace')
      .option('--token <token>', 'restore an existing owner token'),
  ).action(async (options) => {
    let client: SurfletClient;
    if (options.token) {
      client = new SurfletClient(options.server, options.token);
      const me = await client.request<{ workspace: { id: string; name: string } }>('/api/me');
      await saveCredentials(
        {
          token: options.token,
          workspaceId: me.workspace.id,
          name: me.workspace.name,
          server: options.server,
        },
        options.configDir,
      );
    } else {
      client = await workspaceClient(options.server, options.configDir, options.name);
      await client.request('/api/me');
    }
    console.error(
      'Dashboard link contains your private owner key. Keep it out of shared logs and messages.',
    );
    console.log(
      `Surflet workspace is ready. Dashboard: ${dashboardUrl(options.server, client.token!)}`,
    );
  });

  serverOptions(
    program
      .command('share')
      .option('--port <port>', 'local application port (overrides config)', Number)
      .option(
        '--route <path=port>',
        'route prefix and local port; may be repeated',
        (value: string, all: ReturnType<typeof route>[] = []) => [...all, route(value)],
        [],
      )
      .option('--config <path>', 'JSON share configuration file')
      .option(
        '--log-file <service=path>',
        'opt-in log file; may be repeated',
        (value: string, all: string[]) => [...all, value],
        [],
      )
      .option('--name <name>')
      .option('--project-dir <path>', 'application repository used for revision tracking')
      .option('--revision <revision>', 'explicit source revision')
      .option('--ttl <minutes>', 'lease duration in minutes', Number)
      .option('--mode <mode>', 'quick, named, or local'),
  ).action(async (options) => {
    const config = await shareConfig(options.config);
    const settings = config.value;
    const mode = options.mode ?? settings.mode ?? 'quick';
    const port = options.port ?? settings.port;
    if (!port) throw new Error('Specify --port or config.port');
    if (!['quick', 'named', 'local'].includes(mode))
      throw new Error('--mode must be quick, named, or local');
    const logFiles = options.logFile.map((value: string) => {
      const index = value.indexOf('=');
      if (index < 1) throw new Error('--log-file must be SERVICE=PATH');
      const path = value.slice(index + 1);
      return {
        service: value.slice(0, index),
        path: isAbsolute(path) ? path : resolve(config.root ?? process.cwd(), path),
      };
    });
    const controller = new AbortController();
    const removeSignals = installSignalCancellation(controller);
    let handle: Awaited<ReturnType<typeof startShare>>;
    try {
      console.error(`Starting ${mode} preview through ${options.server}…`);
      if (mode === 'quick')
        console.error('Waiting for the public Quick Tunnel to become reachable…');
      handle = await startShare({
        server: options.server,
        configDir: options.configDir,
        port,
        routes: options.route.length ? options.route : settings.routes,
        logFiles: [...(settings.logFiles ?? []), ...logFiles],
        name: options.name ?? settings.name,
        ttlMinutes: options.ttl ?? settings.ttlMinutes,
        mode,
        projectDir: options.projectDir ?? settings.projectDir,
        revision: options.revision ?? settings.revision,
        signal: controller.signal,
      });
    } finally {
      removeSignals();
    }
    console.error('Preview is ready. Press Ctrl-C to stop it.');
    console.error(
      'Dashboard link contains your private owner key. Keep it out of shared logs and messages.',
    );
    console.log(`Preview: ${handle.shareUrl}`);
    console.log(`Dashboard: ${dashboardUrl(options.server, handle.client.token!)}`);
    console.log(`Connector: ${handle.connectorUrl}`);
    if (mode === 'quick')
      console.log('Quick Tunnel does not support SSE. Use --mode named for SSE applications.');
    const done = async () => {
      await handle.close();
      process.exitCode = 0;
    };
    process.once('SIGINT', () => void done());
    process.once('SIGTERM', () => void done());
  });

  serverOptions(program.command('list')).action(async (options) => {
    console.table((await (await ownerClient(options)).listPreviews()).previews.map(compactPreview));
  });
  const feedback = program.command('feedback');
  serverOptions(
    feedback
      .command('list <previewId>')
      .option('--status <status>', `one of: ${feedbackStatuses.join(', ')}`)
      .option('--limit <count>', 'maximum reports to display (1-200)', Number)
      .option('--cursor <cursor>', 'next cursor returned by a previous list'),
  ).action(async (previewId, options) => {
    if (options.status && !feedbackStatuses.includes(options.status))
      throw new Error(`--status must be one of: ${feedbackStatuses.join(', ')}`);
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)
    )
      throw new Error('--limit must be an integer between 1 and 200');
    const result = await (
      await ownerClient(options)
    ).listFeedback(previewId, {
      includeScreenshots: false,
      includeEvidence: false,
      status: options.status,
      limit: options.limit,
      cursor: options.cursor,
    });
    console.table(result.feedback.map(compactFeedback));
    console.error(`Showing ${result.feedback.length} of ${result.total} feedback reports.`);
    if (result.nextCursor) console.error(`Next page: --cursor ${result.nextCursor}`);
  });
  serverOptions(
    feedback
      .command('resolve <previewId> <feedbackId>')
      .option('--status <status>', 'in_progress or fixed', 'in_progress')
      .option('--resolution <text>', 'resolution text', '')
      .option('--tested-revision <revision>', 'revision that was tested'),
  ).action(async (previewId, feedbackId, options) => {
    if (!['in_progress', 'fixed'].includes(options.status))
      throw new Error('--status must be in_progress or fixed; only a tester can verify a fix');
    const { feedback: updated } = await (
      await ownerClient(options)
    ).updateFeedback(
      previewId,
      feedbackId,
      options.status,
      options.resolution,
      options.testedRevision,
    );
    console.log(
      JSON.stringify({
        feedback: {
          id: updated.id,
          status: updated.status,
          resolution: updated.resolution,
          testedRevision: updated.testedRevision,
          updatedAt: updated.updatedAt,
        },
      }),
    );
  });
  serverOptions(program.command('stop <previewId>')).action(async (previewId, options) => {
    const { preview } = await (await ownerClient(options)).stopPreview(previewId);
    console.log(JSON.stringify({ preview: { id: preview.id, status: preview.status } }));
  });
  return program;
}

export async function run(argv = process.argv) {
  await createProgram().parseAsync(argv);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      /cloudflared.*(?:ENOENT|not found)/i.test(message)
        ? `${message}\nInstall cloudflared, then retry: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`
        : message,
    );
    process.exitCode = 1;
  });
}
