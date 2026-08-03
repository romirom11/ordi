/** S3-compatible storage (PRD §14.5): presigned uploads, 25MB cap, blocked exts. */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

function makeClient(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: env.s3.region,
    credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
    forcePathStyle: true,
  });
}

let client: S3Client | null = null;
function getClient(): S3Client | null {
  if (!env.s3.endpoint) return null;
  if (!client) client = makeClient(env.s3.endpoint);
  return client;
}

/**
 * Presigned URLs are fetched by the browser, and the signature covers the
 * Host header – the URL cannot be rewritten after signing. So they are signed
 * against S3_PUBLIC_ENDPOINT when it differs from the internal one (MinIO on
 * a docker network), and against the ordinary endpoint otherwise.
 */
let publicClient: S3Client | null = null;
function getPresignClient(): S3Client | null {
  // Storage is configured by S3_ENDPOINT; a public endpoint alone enables nothing.
  if (!env.s3.endpoint || !env.s3.publicEndpoint) return getClient();
  if (!publicClient) publicClient = makeClient(env.s3.publicEndpoint);
  return publicClient;
}

export async function presignUpload(key: string, mime: string): Promise<string> {
  const c = getPresignClient();
  if (!c) return `local://${key}`; // dev fallback
  return getSignedUrl(c, new PutObjectCommand({ Bucket: env.s3.bucket, Key: key, ContentType: mime }), { expiresIn: 900 });
}

export async function presignDownload(key: string): Promise<string> {
  const c = getPresignClient();
  if (!c) return `local://${key}`;
  return getSignedUrl(c, new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }), { expiresIn: 900 });
}
