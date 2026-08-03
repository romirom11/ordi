/**
 * In-memory stand-in for lib/s3, so upload flows run without MinIO:
 * `vi.mock('../lib/s3', () => import('./s3-mock'))`.
 */
const store = new Map<string, { body: Uint8Array; mime: string }>();

export function isStorageConfigured(): boolean {
  return true;
}

export async function putObject(key: string, body: Uint8Array, mime: string): Promise<boolean> {
  store.set(key, { body, mime });
  return true;
}

export async function getObject(key: string) {
  const obj = store.get(key);
  if (!obj) throw new Error(`missing object ${key}`);
  return {
    body: new Blob([obj.body]).stream(),
    contentType: obj.mime,
    contentLength: obj.body.length,
  };
}
