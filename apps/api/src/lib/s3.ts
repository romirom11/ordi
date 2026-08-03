/**
 * S3-compatible storage (PRD §14.5). All file traffic goes through the API:
 * the browser POSTs the file here and we put it in the bucket; the signed
 * /files link streams it back out. Storage is never exposed to the browser,
 * so an internal MinIO on a docker network needs no public endpoint, no CORS
 * and no second https vhost – and an external S3/R2 stays private too.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../env';
import { err } from './errors';

/**
 * A storage refusal is an operator problem, not a server crash: wrong
 * credentials or a missing bucket used to surface as an unhandled 500 with
 * the real reason visible only in the API logs.
 */
function rethrowStorageError(cause: unknown): never {
  const name = (cause as { name?: string })?.name ?? '';
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    throw err.domain(`Storage rejected the API's credentials (${name}) - check S3_ACCESS_KEY / S3_SECRET_KEY`);
  }
  if (name === 'NoSuchBucket') {
    throw err.domain(`Storage bucket "${env.s3.bucket}" does not exist - create it or fix S3_BUCKET`);
  }
  if (name === 'NoSuchKey') throw err.notFound('File is missing from storage');
  if (name === 'AccessDenied') {
    throw err.domain('Storage denied access (AccessDenied) - the S3 credentials lack rights on the bucket');
  }
  throw cause as Error;
}

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

export function isStorageConfigured(): boolean {
  return !!env.s3.endpoint;
}

/** False when storage is not configured – the caller says so to the user. */
export async function putObject(key: string, body: Uint8Array, mime: string): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    await c.send(new PutObjectCommand({ Bucket: env.s3.bucket, Key: key, Body: body, ContentType: mime }));
  } catch (cause) {
    rethrowStorageError(cause);
  }
  return true;
}

export interface StoredObject {
  /** Web stream of the object bytes, handed straight to the response. */
  body: ReadableStream;
  contentType?: string;
  contentLength?: number;
}

/** Null when storage is not configured; throws if the object is missing. */
export async function getObject(key: string): Promise<StoredObject | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const res = await c.send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 object ${key} has no body`);
    return {
      body: res.Body.transformToWebStream(),
      contentType: res.ContentType,
      contentLength: res.ContentLength,
    };
  } catch (cause) {
    rethrowStorageError(cause);
  }
}
