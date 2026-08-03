/**
 * Presigned URLs must be reachable by a browser: signed against
 * S3_PUBLIC_ENDPOINT when set (MinIO behind a docker network), against the
 * ordinary endpoint otherwise. The signature covers the Host header, so this
 * is decided at signing time, not by rewriting the URL after.
 */
import { describe, it, expect, vi } from 'vitest';

async function loadS3(vars: Record<string, string | undefined>) {
  vi.resetModules();
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await import('../lib/s3');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const BASE = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'test-secret',
  S3_BUCKET: 'ordi',
};

describe('presigned URL endpoints', () => {
  it('signs against the public endpoint when one is set', async () => {
    const s3 = await loadS3({ ...BASE, S3_PUBLIC_ENDPOINT: 'https://files.example.com' });
    const up = await s3.presignUpload('uploads/x/report.pdf', 'application/pdf');
    const down = await s3.presignDownload('uploads/x/report.pdf');
    expect(up.startsWith('https://files.example.com/')).toBe(true);
    expect(down.startsWith('https://files.example.com/')).toBe(true);
    expect(up).toContain('X-Amz-Signature=');
  });

  it('falls back to the internal endpoint without a public one', async () => {
    const s3 = await loadS3({ ...BASE, S3_PUBLIC_ENDPOINT: undefined });
    const url = await s3.presignUpload('uploads/x/report.pdf', 'application/pdf');
    expect(url.startsWith('http://minio:9000/')).toBe(true);
  });

  it('a public endpoint alone does not enable storage', async () => {
    const s3 = await loadS3({
      ...BASE,
      S3_ENDPOINT: undefined,
      S3_PUBLIC_ENDPOINT: 'https://files.example.com',
    });
    expect(await s3.presignUpload('uploads/x/report.pdf', 'application/pdf')).toBe('local://uploads/x/report.pdf');
  });
});
