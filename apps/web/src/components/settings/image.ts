/**
 * Client-side logo processing: downscale an uploaded image to a small square
 * data URL suitable for storing inline in workspace settings. Keeps the app
 * dependency-free (no server-side image pipeline) and the payload tiny.
 */

export interface DownscaleResult { dataUrl: string; bytes: number; type: string }

const MAX_DIM = 128;

function estimateBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.round((b64.length * 3) / 4);
}

export async function downscaleImage(file: File): Promise<DownscaleResult> {
  const src = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('read_failed'));
    fr.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('decode_failed'));
    el.src = src;
  });

  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no_canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  // Prefer webp (smaller); fall back to png where unsupported.
  let type = 'image/webp';
  let dataUrl = canvas.toDataURL(type, 0.9);
  if (!dataUrl.startsWith('data:image/webp')) {
    type = 'image/png';
    dataUrl = canvas.toDataURL(type);
  }
  return { dataUrl, bytes: estimateBytes(dataUrl), type };
}
