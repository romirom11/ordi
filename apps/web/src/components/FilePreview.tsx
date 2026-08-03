/**
 * In-app preview for an attachment, using only what a browser renders
 * natively: images, PDF (the built-in viewer), video, audio and text-ish
 * files. Anything else states plainly that there is no preview and offers
 * the download – a silent empty frame would read as a broken file.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileQuestion } from 'lucide-react';
import { markdownToDoc } from '@ordi/shared';
import { api } from '../lib/api';
import { openExternal } from '../lib/desktop';
import { resolveFileSrc } from '../lib/uploads';
import { Button, EmptyState, Skeleton, Spinner } from './ui';
import { Dialog } from './overlays';
import { RichText } from './richtext/RichText';
import { useT, extendDict } from '../lib/i18n';
import type { FileRow } from './FilesSection';

extendDict({
  en: {
    'files.noPreview': 'No preview for this file type',
    'files.noPreviewHint': 'Download it to open in the right app.',
    'files.previewTooLarge': 'Too large to preview as text – download it instead.',
    'files.previewFailed': 'Could not load the preview.',
  },
  uk: {
    'files.noPreview': 'Для цього типу файлів попереднього перегляду немає',
    'files.noPreviewHint': 'Завантажте файл, щоб відкрити його у відповідній програмі.',
    'files.previewTooLarge': 'Завеликий для текстового перегляду – завантажте файл.',
    'files.previewFailed': 'Не вдалося завантажити перегляд.',
  },
});

type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'markdown' | 'text' | 'none';

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|sql))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|sh|sql|env|ini|toml|conf)$/i;
const MD = /\.(md|markdown)$/i;
/** Reading a whole file into a <pre> stops making sense long before 25MB. */
const TEXT_PREVIEW_CAP = 1024 * 1024;

function kindOf(file: FileRow): PreviewKind {
  const mime = file.mime ?? '';
  if (/^image\//i.test(mime)) return 'image';
  if (/^application\/pdf$/i.test(mime)) return 'pdf';
  if (/^video\//i.test(mime)) return 'video';
  if (/^audio\//i.test(mime)) return 'audio';
  if (MD.test(file.filename) || /^text\/markdown$/i.test(mime)) return 'markdown';
  if (TEXT_MIME.test(mime) || TEXT_EXT.test(file.filename)) return 'text';
  return 'none';
}

function TextPreview({ url, markdown }: { url: string; markdown?: boolean }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((body) => { if (alive) setText(body); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [url]);
  if (failed) return <p className="p-4 text-[13px] text-destructive">{t('files.previewFailed')}</p>;
  if (text === null) return <div className="grid h-40 place-items-center"><Spinner /></div>;
  if (markdown) {
    // Rendered through the same read-only renderer as notes and KB pages –
    // the markdown becomes a JSON tree first, so no raw HTML reaches the page.
    return (
      <div className="max-h-[65vh] overflow-auto rounded-md border border-border p-4">
        <RichText doc={markdownToDoc(text)} />
      </div>
    );
  }
  return (
    <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-4 font-mono text-xs leading-relaxed">
      {text}
    </pre>
  );
}

export function FilePreviewDialog({ file, onClose }: { file: FileRow; onClose: () => void }) {
  const t = useT();
  const kind = kindOf(file);

  // The signed path comes from the record, not the list, so ask for it once.
  const urlQ = useQuery({
    queryKey: ['attachment-url', file.id],
    queryFn: () => api.get<{ url: string }>(`/attachments/${file.id}/url`),
    staleTime: 5 * 60_000,
  });
  const href = urlQ.data ? resolveFileSrc(urlQ.data.url) : null;

  const isTextual = kind === 'text' || kind === 'markdown';
  const textTooLarge = isTextual && (file.size ?? 0) > TEXT_PREVIEW_CAP;

  return (
    <Dialog open onClose={onClose} title={file.filename} width={kind === 'pdf' || kind === 'video' ? 860 : 680}>
      <div className="space-y-3 px-4 pb-4 pt-1">
        {!href ? (
          urlQ.isError
            ? <p className="text-[13px] text-destructive">{t('files.previewFailed')}</p>
            : <Skeleton className="h-48" />
        ) : kind === 'image' ? (
          <div className="grid place-items-center">
            <img src={href} alt={file.filename} className="max-h-[70vh] max-w-full rounded-md object-contain" />
          </div>
        ) : kind === 'pdf' ? (
          <iframe src={href} title={file.filename} className="h-[70vh] w-full rounded-md border border-border" />
        ) : kind === 'video' ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={href} controls className="max-h-[70vh] w-full rounded-md bg-black" />
        ) : kind === 'audio' ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio src={href} controls className="w-full" />
        ) : isTextual && !textTooLarge ? (
          <TextPreview url={href} markdown={kind === 'markdown'} />
        ) : (
          <EmptyState
            icon={<FileQuestion size={20} />}
            title={textTooLarge ? t('files.previewTooLarge') : t('files.noPreview')}
            hint={textTooLarge ? undefined : t('files.noPreviewHint')}
          />
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="outline" disabled={!href} onClick={() => href && openExternal(href)}>
            <Download size={13} /> {t('crm.downloadFile')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
