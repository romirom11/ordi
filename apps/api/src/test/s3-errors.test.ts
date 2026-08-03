/**
 * A storage refusal is an operator problem (wrong credentials, missing
 * bucket) and must reach the user as an actionable message, not as an
 * unhandled 500 whose real cause lives only in the API logs.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(): Promise<never> {
      const cause = new Error('The Access Key Id you provided does not exist in our records.');
      cause.name = 'InvalidAccessKeyId';
      return Promise.reject(cause);
    }
  },
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));

async function loadS3() {
  vi.resetModules();
  const saved = process.env.S3_ENDPOINT;
  process.env.S3_ENDPOINT = 'http://minio:9000';
  try {
    return await import('../lib/s3');
  } finally {
    if (saved === undefined) delete process.env.S3_ENDPOINT;
    else process.env.S3_ENDPOINT = saved;
  }
}

describe('storage error mapping', () => {
  it('maps InvalidAccessKeyId to an actionable domain error, not a 500', async () => {
    const s3 = await loadS3();
    await expect(s3.putObject('uploads/x/a.txt', new Uint8Array(1), 'text/plain'))
      .rejects.toMatchObject({
        code: 'domain_rule',
        message: expect.stringContaining('S3_ACCESS_KEY'),
      });
  });

  it('maps the same refusal on reads', async () => {
    const s3 = await loadS3();
    await expect(s3.getObject('uploads/x/a.txt'))
      .rejects.toMatchObject({ code: 'domain_rule' });
  });
});
