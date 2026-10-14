import { describe, expect, it } from 'vitest';
import {
  createPreviewSchema,
  localRoutesSchema,
  feedbackInputSchema,
  redactText,
  redactUrl,
  sanitizeFeedback,
} from './index.js';

describe('public wire boundaries', () => {
  it('rejects non-loopback-origin settings and unexpected fields at the contract boundary', () => {
    expect(
      createPreviewSchema.safeParse({ name: 'Demo', port: 3000, origin: 'http://169.254.169.254' })
        .success,
    ).toBe(false);
    expect(createPreviewSchema.safeParse({ name: 'Demo', port: 0 }).success).toBe(false);
    expect(
      createPreviewSchema.safeParse({ name: 'Demo', port: 3000, ttlMinutes: 1441 }).success,
    ).toBe(false);
  });
  it('bounds evidence and disallows executable screenshot types', () => {
    expect(
      feedbackInputSchema.safeParse({
        message: 'Issue',
        screenshot: 'data:image/svg+xml;base64,PHN2Zz4=',
      }).success,
    ).toBe(false);
    expect(
      feedbackInputSchema.safeParse({
        message: 'Issue',
        consoleErrors: Array.from({ length: 21 }, () => ({ message: 'error', timestamp: 'now' })),
      }).success,
    ).toBe(false);
    expect(feedbackInputSchema.safeParse({ message: ' ', password: 'private' }).success).toBe(
      false,
    );
  });
  it('accepts only distinct explicit local route prefixes', () => {
    expect(localRoutesSchema.parse([{ path: '/api', port: 8000 }])).toEqual([
      { path: '/api', port: 8000, stripPrefix: true },
    ]);
    for (const path of [
      '/',
      '/__surflet',
      '/__surflet/api',
      '/api/../admin',
      '/api%2fadmin',
      '//api',
      '/api?port=1',
    ]) {
      expect(localRoutesSchema.safeParse([{ path, port: 8000 }]).success).toBe(false);
    }
    expect(
      localRoutesSchema.safeParse([
        { path: '/api', port: 8000 },
        { path: '/api', port: 9000 },
      ]).success,
    ).toBe(false);
    expect(localRoutesSchema.safeParse([{ path: '/api', port: 0 }]).success).toBe(false);
  });
});
describe('feedback redaction', () => {
  it('removes credentials, query parameters and URL fragments', () => {
    expect(redactUrl('https://alice:secret@example.com/form?token=private#auth=private')).toBe(
      'https://example.com/form',
    );
    expect(
      redactText('Bearer abcdefghi token=secret api_key="value" sk-abcdefghijklmnop'),
    ).not.toContain('abcdefghi');
    expect(
      redactText('Bearer abcdefghi token=secret api_key="value" sk-abcdefghijklmnop'),
    ).not.toContain('value');
  });
  it('sanitizes all captured browser fields while preserving useful status context', () => {
    const result = sanitizeFeedback(
      feedbackInputSchema.parse({
        message: 'Failed password=private',
        reporter: 'Jane',
        pageUrl: 'https://app.example/?key=secret',
        consoleErrors: [{ message: 'Authorization: Bearer secret-value', timestamp: 'now' }],
        networkErrors: [
          { url: 'https://api.example/orders?api_key=private', method: 'POST', status: 500 },
        ],
        steps: ['Click token=private'],
      }),
    );
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result.networkErrors[0]).toEqual({
      url: 'https://api.example/orders',
      method: 'POST',
      status: 500,
    });
  });
});
