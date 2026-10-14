import { z } from 'zod';

export const HEARTBEAT_INTERVAL_MS = 10000;
export const OFFLINE_AFTER_MS = 35000;
export const MAX_SCREENSHOT_LENGTH = 1500000;
export const MAX_FEEDBACK_BODY_BYTES = MAX_SCREENSHOT_LENGTH + 550000;
export const feedbackStatuses = ['open', 'in_progress', 'fixed', 'verified'] as const;
export const tunnelModes = ['quick', 'named', 'local'] as const;
export const localRouteSchema = z
  .object({
    path: z
      .string()
      .max(200)
      .regex(/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
      .refine(
        (path) => path !== '/__surflet' && !path.startsWith('/__surflet/'),
        'Surflet routes are reserved',
      ),
    port: z.number().int().min(1).max(65535),
    stripPrefix: z.boolean().default(true),
  })
  .strict();
export const localRoutesSchema = z
  .array(localRouteSchema)
  .max(8)
  .default([])
  .refine(
    (routes) => new Set(routes.map((route) => route.path)).size === routes.length,
    'Duplicate route prefixes',
  );
export type LocalRoute = z.output<typeof localRouteSchema>;
export const logFileSchema = z
  .object({
    service: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/),
    path: z.string().min(1).max(4096),
  })
  .strict();
export type LogFile = z.infer<typeof logFileSchema>;
export const logFilesSchema = z.array(logFileSchema).max(5).default([]);

export const createPreviewSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    port: z.number().int().min(1).max(65535),
    ttlMinutes: z.number().int().min(5).max(1440).default(120),
    revision: z.string().max(120).default('unknown'),
    mode: z.enum(tunnelModes).default('quick'),
    routes: localRoutesSchema,
  })
  .strict();
export type CreatePreview = z.input<typeof createPreviewSchema>;
export const shareConfigSchema = createPreviewSchema.partial().extend({
  projectDir: z.string().min(1).max(4096).optional(),
  logFiles: logFilesSchema.optional(),
});
export const heartbeatSchema = z.object({ revision: z.string().max(120).optional() }).strict();
export const attachTunnelSchema = z.object({ targetUrl: z.string().url().max(2048) }).strict();
export const provisionTunnelSchema = z
  .object({ proxyPort: z.number().int().min(1).max(65535) })
  .strict();
export const exchangeAccessSchema = z.object({ ticket: z.string().min(20).max(200) }).strict();
export const accessInputSchema = z
  .object({ feedbackId: z.string().min(1).max(100).optional() })
  .strict();
export const consoleErrorSchema = z
  .object({ message: z.string().max(1500), timestamp: z.string().max(40) })
  .strict();
export const networkErrorSchema = z
  .object({
    url: z.string().max(2048),
    method: z.string().max(16),
    status: z.number().int().min(0).max(599),
    requestId: z.string().max(100).optional(),
  })
  .strict();
export const backendErrorSchema = z
  .object({
    service: z.string().max(100),
    source: z.enum(['proxy', 'log']),
    message: z.string().max(1500),
    timestamp: z.string().max(40),
    revision: z.string().max(120),
    requestId: z.string().max(100).optional(),
    path: z.string().max(2048).optional(),
    status: z.number().int().min(0).max(599).optional(),
  })
  .strict();
export type BackendError = z.infer<typeof backendErrorSchema>;
export const feedbackInputSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    pageUrl: z.string().max(2048).default(''),
    revision: z.string().max(120).default('unknown'),
    reporter: z.string().trim().max(80).default(''),
    environment: z
      .object({
        userAgent: z.string().max(500),
        width: z.number().int().min(0).max(20000),
        height: z.number().int().min(0).max(20000),
      })
      .strict()
      .optional(),
    consoleErrors: z.array(consoleErrorSchema).max(20).default([]),
    networkErrors: z.array(networkErrorSchema).max(20).default([]),
    steps: z.array(z.string().max(300)).max(20).default([]),
    backendErrors: z.array(backendErrorSchema).max(20).default([]),
    screenshot: z
      .string()
      .max(MAX_SCREENSHOT_LENGTH)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .optional(),
  })
  .strict();
export type FeedbackInput = z.input<typeof feedbackInputSchema>;
export type FeedbackPayload = z.output<typeof feedbackInputSchema>;
export const updateFeedbackSchema = z
  .object({
    status: z.enum(feedbackStatuses),
    resolution: z.string().max(4000).optional(),
    testedRevision: z.string().min(1).max(120).optional(),
  })
  .strict();
export const retestSchema = z
  .object({
    outcome: z.enum(['verified', 'reopen']),
    message: z.string().max(2000).default(''),
    revision: z.string().min(1).max(120).optional(),
  })
  .strict();

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}
export interface Preview {
  id: string;
  workspaceId: string;
  name: string;
  port: number;
  revision: string;
  mode: (typeof tunnelModes)[number];
  status: 'starting' | 'online' | 'offline' | 'stopped' | 'expired';
  targetUrl: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  feedbackCount: number;
  routes: LocalRoute[];
}
export interface Feedback extends FeedbackPayload {
  id: string;
  previewId: string;
  status: (typeof feedbackStatuses)[number];
  resolution: string;
  createdAt: string;
  updatedAt: string;
  retestMessage: string;
  testedRevision: string;
  retestRevision: string;
  hasScreenshot?: boolean;
}
export interface CreatedPreview {
  preview: Preview;
  shareToken: string;
  connectorToken: string;
  shareUrl: string;
}
export interface NamedTunnel {
  tunnelId: string;
  hostname: string;
  targetUrl: string;
  token: string;
}
export interface CreatedWorkspace {
  workspace: Workspace;
  token: string;
}

export function redactText(input: string): string {
  return input
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\b(sk|pk|ghp|github_pat)[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(
      /\b(password|passwd|token|secret|api[-_]?key|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1=[redacted]',
    );
}
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return redactText(input.split(/[?#]/, 1)[0] ?? '').slice(0, 2048);
  }
}
export function sanitizeFeedback(input: FeedbackPayload): FeedbackPayload {
  return {
    ...input,
    message: redactText(input.message),
    reporter: redactText(input.reporter),
    pageUrl: redactUrl(input.pageUrl),
    steps: input.steps.map(redactText),
    consoleErrors: input.consoleErrors.map((e) => ({ ...e, message: redactText(e.message) })),
    networkErrors: input.networkErrors.map((e) => ({ ...e, url: redactUrl(e.url) })),
    backendErrors: input.backendErrors.map((e) => ({
      ...e,
      message: redactText(e.message),
      path: e.path ? redactUrl(e.path) : undefined,
    })),
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export class SurfletClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    readonly token?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  async request<T>(
    path: string,
    options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const token = options.token ?? this.token;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(
        response.status,
        data.error ?? `Surflet request failed (${response.status})`,
      );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  createWorkspace(name: string) {
    return this.request<CreatedWorkspace>('/api/workspaces', { method: 'POST', body: { name } });
  }
  listPreviews() {
    return this.request<{ previews: Preview[] }>('/api/previews');
  }
  createPreview(body: CreatePreview) {
    return this.request<CreatedPreview>('/api/previews', { method: 'POST', body });
  }
  getPreview(id: string) {
    return this.request<{ preview: Preview }>(`/api/previews/${encodeURIComponent(id)}`);
  }
  attachTunnel(id: string, targetUrl: string) {
    return this.request<{ preview: Preview }>(`/api/previews/${encodeURIComponent(id)}/tunnel`, {
      method: 'PUT',
      body: { targetUrl },
    });
  }
  provisionTunnel(id: string, proxyPort: number) {
    return this.request<NamedTunnel>(`/api/previews/${encodeURIComponent(id)}/named-tunnel`, {
      method: 'POST',
      body: { proxyPort },
    });
  }
  heartbeat(id: string, revision?: string) {
    return this.request<{ preview: Preview }>(`/api/previews/${encodeURIComponent(id)}/heartbeat`, {
      method: 'POST',
      body: { revision },
    });
  }
  stopPreview(id: string) {
    return this.request<{ preview: Preview }>(`/api/previews/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    });
  }
  getAccess(id: string, feedbackId?: string) {
    return this.request<{ targetUrl: string }>(`/api/previews/${encodeURIComponent(id)}/access`, {
      method: 'POST',
      body: feedbackId ? { feedbackId } : undefined,
    });
  }
  exchangeAccess(id: string, ticket: string) {
    return this.request<{ authorized: true }>(`/api/previews/${encodeURIComponent(id)}/exchange`, {
      method: 'POST',
      body: { ticket },
    });
  }
  listFeedback(id: string, options?: { includeScreenshots?: boolean }) {
    return this.request<{ feedback: Feedback[] }>(
      `/api/previews/${encodeURIComponent(id)}/feedback${options?.includeScreenshots === false ? '?includeScreenshots=false' : ''}`,
    );
  }
  getFeedback(id: string, feedbackId: string) {
    return this.request<{ feedback: Feedback }>(
      `/api/previews/${encodeURIComponent(id)}/feedback/${encodeURIComponent(feedbackId)}`,
    );
  }
  submitFeedback(id: string, body: FeedbackInput) {
    return this.request<{ feedback: Feedback }>(
      `/api/previews/${encodeURIComponent(id)}/feedback`,
      { method: 'POST', body },
    );
  }
  updateFeedback(
    id: string,
    feedbackId: string,
    status: Feedback['status'],
    resolution?: string,
    testedRevision?: string,
  ) {
    return this.request<{ feedback: Feedback }>(
      `/api/previews/${encodeURIComponent(id)}/feedback/${encodeURIComponent(feedbackId)}`,
      { method: 'PATCH', body: { status, resolution, testedRevision } },
    );
  }
  retestFeedback(
    id: string,
    feedbackId: string,
    outcome: 'verified' | 'reopen',
    message = '',
    revision?: string,
  ) {
    return this.request<{ feedback: Feedback }>(
      `/api/previews/${encodeURIComponent(id)}/feedback/${encodeURIComponent(feedbackId)}/retest`,
      { method: 'POST', body: { outcome, message, revision } },
    );
  }
}
