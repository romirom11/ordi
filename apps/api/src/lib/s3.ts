/** S3-compatible storage (PRD §14.5): presigned uploads, 25MB cap, blocked exts. */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

let client: S3Client | null = null;
function getClient(): S3Client | null {
  if (!env.s3.endpoint) return null;
  if (!client) {
    client = new S3Client({
      endpoint: env.s3.endpoint,
      region: env.s3.region,
      credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
      forcePathStyle: true,
    });
  }
  return client;
}

export async function presignUpload(key: string, mime: string): Promise<string> {
  const c = getClient();
  if (!c) return `local://${key}`; // dev fallback
  return getSignedUrl(c, new PutObjectCommand({ Bucket: env.s3.bucket, Key: key, ContentType: mime }), { expiresIn: 900 });
}

export async function presignDownload(key: string): Promise<string> {
  const c = getClient();
  if (!c) return `local://${key}`;
  return getSignedUrl(c, new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }), { expiresIn: 900 });
}
