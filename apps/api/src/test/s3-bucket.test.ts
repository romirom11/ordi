/**
 * The API creates its own attachments bucket on boot (what the minio/mc init
 * container used to do): a missing bucket is created, an existing one is left
 * alone, and a storage that is still starting is retried instead of failing
 * the boot. Nothing here reaches a real server – the S3 client is a stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Behaviour = { head: 'ok' | 'notfound' | 'denied' | 'refused-then-ok'; created: string[]; heads: number };
const state: Behaviour = { head: 'ok', created: [], heads: 0 };

vi.mock('@aws-sdk/client-s3', () => {
  class HeadBucketCommand { constructor(public input: { Bucket: string }) {} }
  class CreateBucketCommand { constructor(public input: { Bucket: string }) {} }
  class S3Client {
    async send(cmd: HeadBucketCommand | CreateBucketCommand): Promise<unknown> {
      if (cmd instanceof CreateBucketCommand) { state.created.push(cmd.input.Bucket); return {}; }
      state.heads += 1;
      if (state.head === 'ok') return {};
      if (state.head === 'notfound') { const e = new Error('UnknownError'); e.name = 'NotFound'; (e as any).$metadata = { httpStatusCode: 404 }; throw e; }
      if (state.head === 'denied') { const e = new Error('Access Denied'); e.name = 'AccessDenied'; (e as any).$metadata = { httpStatusCode: 403 }; throw e; }
      // refused-then-ok: the container is not up yet on the first two probes
      if (state.heads <= 2) { const e = new Error('connect ECONNREFUSED 10.0.0.9:9000'); e.name = 'Error'; (e as any).code = 'ECONNREFUSED'; throw e; }
      return {};
    }
  }
  return { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand: class {}, GetObjectCommand: class {} };
});

async function loadS3() {
  vi.resetModules();
  const saved = { endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET };
  process.env.S3_ENDPOINT = 'http://ordi-s3:9000';
  process.env.S3_BUCKET = 'ordi';
  try {
    return await import('../lib/s3');
  } finally {
    if (saved.endpoint === undefined) delete process.env.S3_ENDPOINT; else process.env.S3_ENDPOINT = saved.endpoint;
    if (saved.bucket === undefined) delete process.env.S3_BUCKET; else process.env.S3_BUCKET = saved.bucket;
  }
}

beforeEach(() => { state.head = 'ok'; state.created = []; state.heads = 0; });

describe('ensureBucket', () => {
  it('leaves an existing bucket alone', async () => {
    const s3 = await loadS3();
    expect(await s3.ensureBucket()).toBe('exists');
    expect(state.created).toEqual([]);
  });

  it('creates the bucket when HeadBucket says it is missing', async () => {
    state.head = 'notfound';
    const s3 = await loadS3();
    expect(await s3.ensureBucket()).toBe('created');
    expect(state.created).toEqual(['ordi']);
  });

  it('does not mistake a refusal for a missing bucket', async () => {
    state.head = 'denied';
    const s3 = await loadS3();
    await expect(s3.ensureBucket()).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(state.created).toEqual([]);
  });
});

describe('ensureBucketAtBoot', () => {
  it('waits for a storage container that is still starting', async () => {
    state.head = 'refused-then-ok';
    const s3 = await loadS3();
    expect(await s3.ensureBucketAtBoot({ attempts: 5, delayMs: 1 })).toBe('exists');
    expect(state.heads).toBe(3);
  });

  it('gives up quietly on a real refusal instead of crashing the boot', async () => {
    state.head = 'denied';
    const s3 = await loadS3();
    expect(await s3.ensureBucketAtBoot({ attempts: 5, delayMs: 1 })).toBe('unavailable');
    expect(state.heads).toBe(1);
  });

  it('is a no-op without S3_ENDPOINT', async () => {
    vi.resetModules();
    const saved = process.env.S3_ENDPOINT;
    delete process.env.S3_ENDPOINT;
    try {
      const s3 = await import('../lib/s3');
      expect(await s3.ensureBucketAtBoot({ attempts: 1, delayMs: 1 })).toBe('unconfigured');
    } finally {
      if (saved !== undefined) process.env.S3_ENDPOINT = saved;
    }
  });
});
