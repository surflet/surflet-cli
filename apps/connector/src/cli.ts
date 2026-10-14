#!/usr/bin/env node
import { Command } from 'commander';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { shareConfigSchema } from '@surflet/core';
import { startShare, workspaceClient } from './index.js';

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

const program = new Command()
  .name('surflet')
  .description('Share a selected local prototype for feedback.');
function dashboardUrl(server: string, token?: string) {
  return `${server.replace(/\/$/, '')}/#key=${encodeURIComponent(token ?? '')}`;
}
program
  .command('login')
  .option('--server <url>', 'Surflet service URL', 'http://127.0.0.1:4504')
  .option('--name <name>', 'workspace name', 'Local workspace')
  .action(async (options) => {
    const client = await workspaceClient(options.server, undefined, options.name);
    console.log(
      `Surflet workspace is ready. Dashboard: ${dashboardUrl(options.server, client.token)}`,
    );
  });
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
  .option('--server <url>', 'Surflet service URL', 'http://127.0.0.1:4504')
  .option('--name <name>')
  .option('--project-dir <path>', 'application repository used for revision tracking')
  .option('--revision <revision>', 'explicit source revision')
  .option('--ttl <minutes>', 'lease duration in minutes', Number)
  .option('--mode <mode>', 'quick, named, or local')
  .action(async (options) => {
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
    const handle = await startShare({
      server: options.server,
      port,
      routes: options.route.length ? options.route : settings.routes,
      logFiles: [...(settings.logFiles ?? []), ...logFiles],
      name: options.name ?? settings.name,
      ttlMinutes: options.ttl ?? settings.ttlMinutes,
      mode,
      projectDir: options.projectDir ?? settings.projectDir,
      revision: options.revision ?? settings.revision,
    });
    console.log(`Preview: ${handle.shareUrl}`);
    console.log(`Dashboard: ${dashboardUrl(options.server, handle.client.token)}`);
    console.log(`Connector: ${handle.connectorUrl}`);
    if (mode === 'quick')
      console.log('Quick Tunnel does not support SSE. Use --mode named for SSE applications.');
    const done = async () => {
      await handle.close();
      process.exitCode = 0;
    };
    process.once('SIGINT', () => {
      void done();
    });
    process.once('SIGTERM', () => {
      void done();
    });
  });
program
  .command('list')
  .option('--server <url>', 'Surflet service URL', 'http://127.0.0.1:4504')
  .action(async (options) => {
    const client = await workspaceClient(options.server);
    console.table((await client.listPreviews()).previews);
  });
const feedback = program.command('feedback');
feedback
  .command('list <previewId>')
  .option('--server <url>', 'Surflet service URL', 'http://127.0.0.1:4504')
  .action(async (previewId, options) => {
    const client = await workspaceClient(options.server);
    console.table((await client.listFeedback(previewId)).feedback);
  });
feedback
  .command('resolve <previewId> <feedbackId>')
  .option('--status <status>', 'in_progress or fixed', 'in_progress')
  .option('--resolution <text>', 'resolution text', '')
  .option('--tested-revision <revision>', 'revision that was tested')
  .option('--server <url>', 'Surflet service URL', 'http://127.0.0.1:4504')
  .action(async (previewId, feedbackId, options) => {
    if (!['in_progress', 'fixed'].includes(options.status))
      throw new Error('--status must be in_progress or fixed; only a tester can verify a fix');
    const client = await workspaceClient(options.server);
    console.log(
      JSON.stringify(
        await client.updateFeedback(
          previewId,
          feedbackId,
          options.status,
          options.resolution,
          options.testedRevision,
        ),
      ),
    );
  });
program
  .command('stop <previewId>')
  .option('--server <url>', 'Surflet service URL', 'http://127.0.0.1:4504')
  .action(async (previewId, options) =>
    console.log(
      JSON.stringify(
        await workspaceClient(options.server).then((client) => client.stopPreview(previewId)),
      ),
    ),
  );
program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
