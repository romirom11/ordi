/**
 * Attachment upload for MCP: lets an agent put bytes into ordi storage and
 * get back the signed `src` that task/comment/KB bodies embed as
 * `![alt](src)`. Two uses:
 *
 * - inline in a body: upload with no entityType → src → `![alt](src)` line at
 *   whatever position the agent wants inside `text` (interleaved with prose),
 *   then create_task / update_task with that text.
 * - Files section: upload with entityType + entityId → shows in the record's
 *   Files, not inline.
 *
 * Mirrors POST /attachments (apps/api/src/domains/core/attachments.routes.ts):
 * multipart/form-data, S3-backed, HMAC-signed src.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BLOCKED_FILE_EXTENSIONS, MAX_UPLOAD_BYTES } from '@ordi/shared';
import type { OrdiClient } from './client';
import { wrap } from './format';

const ALLOWED_ENTITY_TYPES = ['task', 'project', 'company', 'lead', 'deal', 'employee', 'intake_item'] as const;

/** Strip a possible `data:image/png;base64,` prefix – agents often paste data URIs verbatim. */
function stripDataUriPrefix(input: string): { clean: string; mimeFromPrefix: string | null } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(input.trim());
  if (m) return { clean: m[2]!, mimeFromPrefix: m[1]! };
  return { clean: input.trim(), mimeFromPrefix: null };
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : '';
}

function mimeFromExt(ext: string): string | null {
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
    pdf: 'application/pdf',
  };
  return map[ext] ?? null;
}

export function registerAttachmentTools(server: McpServer, client: OrdiClient): void {
  server.tool(
    'upload_attachment',
    'Upload a file to ordi storage and get back its signed src/url. '
      + 'For images that should appear inline in a task description, upload once per image (no entityType), then embed each returned src exactly where you want it in the task text as `![alt](src)` – that lets you interleave multiple images with prose at arbitrary positions (e.g. Step 1, screenshot, Step 2, screenshot). '
      + 'With entityType + entityId the file appears in that record\'s Files section instead. '
      + 'Typical flow for a bug report with two screenshots at different steps: '
      + '1) upload_attachment {filename:"step1.png", data:"<base64>"} → {src}, '
      + '2) upload_attachment {filename:"step2.png", data:"<base64>"} → {src}, '
      + '3) create_task {text: "Step 1…\\n\\n![step1](SRC1)\\n\\nStep 2…\\n\\n![step2](SRC2)"}. '
      + 'On update, get_task first, keep existing ![…](…) lines, insert new ones where needed, and send expectedVersion.',
    {
      filename: z.string().min(1).describe('Original filename with extension, e.g. screenshot.png'),
      data: z.string().min(1).optional().describe('Base64-encoded file bytes (without data: prefix, or with – both work). One of data or url is required.'),
      url: z.string().url().optional().describe('Public URL to fetch and upload server-side (alternative to data).'),
      mimeType: z.string().optional().describe('MIME type, e.g. image/png. Auto-detected from filename when omitted.'),
      entityType: z.enum(ALLOWED_ENTITY_TYPES).optional().describe('Attach to a record instead of embedding inline. Requires entityId.'),
      entityId: z.string().optional().describe('Id of the record to attach to (taskId, projectId …). Only with entityType.'),
    },
    ({ filename, data, url, mimeType, entityType, entityId }) =>
      wrap(async () => {
        if (!data && !url) throw new Error('One of data (base64) or url is required.');
        if (data && url) throw new Error('Provide either data or url, not both.');
        if (entityType && !entityId) throw new Error('entityId is required when entityType is set.');
        if (entityId && !entityType) throw new Error('entityType is required when entityId is set.');

        const ext = extOf(filename);
        if (ext && BLOCKED_FILE_EXTENSIONS.includes(ext)) {
          throw new Error(`File type .${ext} is not allowed (blocked: ${BLOCKED_FILE_EXTENSIONS.join(', ')}).`);
        }

        let bytes: Uint8Array;
        let mime: string;

        if (data) {
          const { clean, mimeFromPrefix } = stripDataUriPrefix(data);
          // Validate base64 shape early – Buffer.from silently ignores garbage.
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean.replace(/\s/g, ''))) {
            throw new Error('data is not valid base64.');
          }
          const buf = Buffer.from(clean, 'base64');
          if (!buf.length) throw new Error('Decoded file is empty.');
          if (buf.length > MAX_UPLOAD_BYTES) {
            throw new Error(`File is ${buf.length} bytes, exceeds the ${MAX_UPLOAD_BYTES} byte cap (${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`);
          }
          bytes = new Uint8Array(buf);
          mime = mimeType?.trim() || mimeFromPrefix || mimeFromExt(ext) || 'application/octet-stream';
        } else {
          // Fetch server-side (agent has a URL but no bytes).
          const res = await fetch(url!);
          if (!res.ok) throw new Error(`Fetching url failed: ${res.status} ${res.statusText}`);
          const len = res.headers.get('content-length');
          if (len && Number(len) > MAX_UPLOAD_BYTES) {
            throw new Error(`Remote file is ${len} bytes, exceeds the ${MAX_UPLOAD_BYTES} byte cap.`);
          }
          const ab = await res.arrayBuffer();
          if (ab.byteLength > MAX_UPLOAD_BYTES) {
            throw new Error(`Remote file is ${ab.byteLength} bytes, exceeds the cap.`);
          }
          if (!ab.byteLength) throw new Error('Remote file is empty.');
          bytes = new Uint8Array(ab);
          const headerMime = res.headers.get('content-type')?.split(';')[0]?.trim();
          mime = mimeType?.trim() || headerMime || mimeFromExt(ext) || 'application/octet-stream';
        }

        // Build multipart the way POST /attachments expects.
        const blob = new Blob([bytes], { type: mime });
        const form = new FormData();
        // FormData.append with Blob+filename creates a File-like part that Hono parses as File.
        form.append('file', blob, filename);
        if (entityType) form.append('entityType', entityType);
        if (entityId) form.append('entityId', entityId);

        const uploaded = await client.postForm<{ id: string; src: string }>('/attachments', form);
        const origin = client.publicUrl;
        const absolute = uploaded.src.startsWith('/') ? `${origin}${uploaded.src}` : uploaded.src;

        return {
          id: uploaded.id,
          src: uploaded.src,
          url: absolute,
          filename,
          mime,
          size: bytes.length,
          hint: uploaded.src.startsWith('/api/v1/files/')
            ? `Embed inline with: ![${filename}](${absolute}) – or with the relative src inside text: ![${filename}](${uploaded.src}). The agent-facing text uses absolute URLs; stored docs keep the relative form.`
            : undefined,
        };
      }),
  );
}
