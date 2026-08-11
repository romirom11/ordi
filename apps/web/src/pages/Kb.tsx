import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '../lib/router';
import { useTabs } from '../lib/tabs';
import { useCan } from '../lib/auth';
import { appOrigin, api, ApiError } from '../lib/api';
import {
  Button, IconButton, Input, Card, Badge, Breadcrumbs, EmptyState, Skeleton, Spinner, fmtDate, cn,
  type BreadcrumbItem,
} from '../components/ui';
import {
  ConfirmDialog, ContextMenu, Dialog, DropdownMenu, MenuItem, MenuSeparator, toast,
  type ContextMenuEntry,
} from '../components/overlays';
import {
  Plus, History, FileText, ChevronRight, RotateCcw, Folder, FolderOpen,
  MoreHorizontal, Pencil, Globe, EyeOff, BookOpen, FileQuestion, Lock,
  Link2, ExternalLink, Trash2, File as FileIcon, Upload,
} from 'lucide-react';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { SpaceAccessDialog, type AccessSpace } from '../components/kb/SpaceAccessDialog';
import { uploadPdf, resolveFileSrc, uploadErrorKey, UploadError } from '../lib/uploads';
import { openExternal } from '../lib/desktop';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'kb.rename': 'Rename',
    'kb.renamePage': 'Rename page',
    'kb.renameFailed': 'Could not rename the page',
    'kb.publish': 'Publish',
    'kb.unpublish': 'Unpublish',
    'kb.published': 'Published',
    'kb.draft': 'Draft',
    'kb.draftHint': 'Only space editors can see this page',
    'kb.publishFailed': 'Could not update the publish status',
    'kb.newSubpage': 'New subpage',
    'kb.createSpaceFailed': 'Could not create the space',
    'kb.createPageFailed': 'Could not create the page',
    'kb.restoreFailed': 'Could not restore this version',
    'kb.restored': 'Version restored',
    'kb.renamed': 'Page renamed',
    'kb.saved': 'Page saved',
    'kb.unsavedChanges': 'Unsaved changes',
    'kb.conflict': 'This page changed elsewhere – refreshed with the latest version',
    'kb.newSpaceHint': 'Spaces group related pages together.',
    'kb.copyLink': 'Copy link',
    'kb.linkCopied': 'Link copied',
    'kb.openNewTab': 'Open in new tab',
    'kb.deletePage': 'Delete',
    'kb.deletePageTitle': 'Delete page?',
    'kb.deletePageBody': 'The page and its subpages will be removed. This cannot be undone.',
    'kb.pageDeleted': 'Page deleted',
    'kb.deletePageFailed': 'Could not delete the page',
    'kb.renameSpace': 'Rename space',
    'kb.spaceRenamed': 'Space renamed',
    'kb.renameSpaceFailed': 'Could not rename the space',
    'kb.deleteSpace': 'Delete',
    'kb.deleteSpaceTitle': 'Delete space?',
    'kb.deleteSpaceBody': 'The space and all of its pages will be removed. This cannot be undone.',
    'kb.spaceDeleted': 'Space deleted',
    'kb.deleteSpaceFailed': 'Could not delete the space',
    'kb.pageType': 'Type',
    'kb.typeArticle': 'Article',
    'kb.typeArticleHint': 'A page you write and edit',
    'kb.typePdf': 'PDF',
    'kb.typePdfHint': 'An uploaded document, viewed inline',
    'kb.pdfFile': 'PDF file',
    'kb.choosePdf': 'Choose a PDF…',
    'kb.replacePdf': 'Replace file',
    'kb.pdfReplaced': 'File replaced',
    'kb.pdfMissing': 'The file behind this page is gone',
    'kb.pdfMissingHint': 'It may have been deleted from storage. Upload a replacement to restore the page.',
    'uploads.notPdf': 'Only a PDF file can go here',
  },
  uk: {
    'kb.rename': 'Перейменувати',
    'kb.renamePage': 'Перейменувати сторінку',
    'kb.renameFailed': 'Не вдалося перейменувати сторінку',
    'kb.publish': 'Опублікувати',
    'kb.unpublish': 'Зняти з публікації',
    'kb.published': 'Опубліковано',
    'kb.draft': 'Чернетка',
    'kb.draftHint': 'Цю сторінку бачать лише редактори простору',
    'kb.publishFailed': 'Не вдалося змінити статус публікації',
    'kb.newSubpage': 'Нова підсторінка',
    'kb.createSpaceFailed': 'Не вдалося створити простір',
    'kb.createPageFailed': 'Не вдалося створити сторінку',
    'kb.restoreFailed': 'Не вдалося відновити цю версію',
    'kb.restored': 'Версію відновлено',
    'kb.renamed': 'Сторінку перейменовано',
    'kb.saved': 'Сторінку збережено',
    'kb.unsavedChanges': 'Є незбережені зміни',
    'kb.conflict': 'Сторінку змінили деінде – оновлено до останньої версії',
    'kb.newSpaceHint': 'Простори групують пов’язані сторінки.',
    'kb.copyLink': 'Копіювати посилання',
    'kb.linkCopied': 'Посилання скопійовано',
    'kb.openNewTab': 'Відкрити в новій вкладці',
    'kb.deletePage': 'Видалити',
    'kb.deletePageTitle': 'Видалити сторінку?',
    'kb.deletePageBody': 'Сторінку та її підсторінки буде видалено. Цю дію не можна скасувати.',
    'kb.pageDeleted': 'Сторінку видалено',
    'kb.deletePageFailed': 'Не вдалося видалити сторінку',
    'kb.renameSpace': 'Перейменувати простір',
    'kb.spaceRenamed': 'Простір перейменовано',
    'kb.renameSpaceFailed': 'Не вдалося перейменувати простір',
    'kb.deleteSpace': 'Видалити',
    'kb.deleteSpaceTitle': 'Видалити простір?',
    'kb.deleteSpaceBody': 'Простір і всі його сторінки буде видалено. Цю дію не можна скасувати.',
    'kb.spaceDeleted': 'Простір видалено',
    'kb.deleteSpaceFailed': 'Не вдалося видалити простір',
    'kb.pageType': 'Тип',
    'kb.typeArticle': 'Стаття',
    'kb.typeArticleHint': 'Сторінка, яку ви пишете та редагуєте',
    'kb.typePdf': 'PDF',
    'kb.typePdfHint': 'Завантажений документ, який переглядають тут же',
    'kb.pdfFile': 'PDF-файл',
    'kb.choosePdf': 'Обрати PDF…',
    'kb.replacePdf': 'Замінити файл',
    'kb.pdfReplaced': 'Файл замінено',
    'kb.pdfMissing': 'Файл цієї сторінки зник',
    'kb.pdfMissingHint': 'Можливо, його видалили зі сховища. Завантажте новий, щоб відновити сторінку.',
    'uploads.notPdf': 'Сюди можна додати лише PDF-файл',
  },
});

interface Space { id: string; name: string; icon?: string | null; visibility?: string; version?: number }
interface FlatPage { id: string; title: string; parentId: string | null; position?: number; published?: boolean; version?: number; type?: string }
interface PageNode extends FlatPage { children: PageNode[] }
interface PageFile { id: string; src: string; filename: string; size: number; mime: string }
interface PageDetail {
  id: string; title: string; body: unknown; spaceId: string; updatedAt?: string; version?: number; published?: boolean;
  type?: string; file?: PageFile;
}

function fmtSize(bytes?: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
interface Version { id?: string; versionNo: number; title: string; authorId?: string | null; createdAt: string }

function buildTree(pages: FlatPage[]): PageNode[] {
  const map = new Map<string, PageNode>();
  const roots: PageNode[] = [];
  for (const p of pages) map.set(p.id, { ...p, children: [] });
  for (const p of pages) {
    const node = map.get(p.id)!;
    const parent = p.parentId ? map.get(p.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Rotating chevron used for every expand/collapse affordance in the tree (transitions.dev accordion). */
function Caret({ open, visible = true }: { open: boolean; visible?: boolean }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {visible && (
        <ChevronRight
          size={12}
          className="text-faint"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform var(--duration-fast) var(--ease-smooth-out)' }}
        />
      )}
    </span>
  );
}

/** Height + fade panel per transitions.dev №21 (grid-template-rows 0fr↔1fr, no JS measuring). */
function AccordionPanel({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows 250ms var(--ease-smooth-out)' }}>
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

interface TreeActions {
  onNavigate: (spaceId: string, pageId: string) => void;
  onCreateChild: (spaceId: string, parentId: string) => void;
  onRename: (spaceId: string, page: FlatPage) => void;
  onTogglePublish: (spaceId: string, page: FlatPage) => void;
  onCopyLink: (spaceId: string, pageId: string) => void;
  onOpenNewTab: (spaceId: string, pageId: string) => void;
  onDelete: (spaceId: string, page: FlatPage) => void;
}

function PageTree({ nodes, spaceId, activeId, depth, canWrite, expandedPages, onTogglePage, actions }: {
  nodes: PageNode[]; spaceId: string; activeId?: string; depth: number; canWrite: boolean;
  expandedPages: Set<string>; onTogglePage: (id: string) => void; actions: TreeActions;
}) {
  const t = useT();
  return (
    <div>
      {nodes.map((n) => {
        const hasChildren = n.children.length > 0;
        const isOpen = expandedPages.has(n.id);
        const isActive = n.id === activeId;
        // Right-click menu mirrors the "…" dropdown (both must work).
        const ctxItems: ContextMenuEntry[] = [
          ...(canWrite
            ? [
                { key: 'newSub', label: t('kb.newSubpage'), icon: <Plus size={13} />, onSelect: () => actions.onCreateChild(spaceId, n.id) },
                { key: 'rename', label: t('kb.rename'), icon: <Pencil size={13} />, onSelect: () => actions.onRename(spaceId, n) },
                {
                  key: 'publish',
                  label: n.published ? t('kb.unpublish') : t('kb.publish'),
                  icon: n.published ? <EyeOff size={13} /> : <Globe size={13} />,
                  onSelect: () => actions.onTogglePublish(spaceId, n),
                },
                { type: 'separator' } as ContextMenuEntry,
              ]
            : []),
          { key: 'copyLink', label: t('kb.copyLink'), icon: <Link2 size={13} />, onSelect: () => actions.onCopyLink(spaceId, n.id) },
          { key: 'newTab', label: t('kb.openNewTab'), icon: <ExternalLink size={13} />, onSelect: () => actions.onOpenNewTab(spaceId, n.id) },
          ...(canWrite
            ? [
                { type: 'separator' } as ContextMenuEntry,
                { key: 'delete', label: t('kb.deletePage'), icon: <Trash2 size={13} />, danger: true, onSelect: () => actions.onDelete(spaceId, n) },
              ]
            : []),
        ];
        return (
          <div key={n.id}>
            <ContextMenu items={ctxItems}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => actions.onNavigate(spaceId, n.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') actions.onNavigate(spaceId, n.id); }}
              style={{ paddingLeft: 6 + depth * 14 }}
              className={cn(
                'group flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1 text-[13px] transition-colors duration-150',
                isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <span onClick={(e) => { e.stopPropagation(); if (hasChildren) onTogglePage(n.id); }}>
                <Caret open={isOpen} visible={hasChildren} />
              </span>
              {n.type === 'pdf'
                ? <FileIcon size={13} className="shrink-0 text-faint" />
                : <FileText size={13} className="shrink-0 text-faint" />}
              <span className="min-w-0 flex-1 truncate">{n.title || t('kb.untitled')}</span>
              {/* Published is the norm now – mark the exception. Viewers never receive drafts, so this only shows to editors. */}
              {!n.published && <span className="shrink-0 text-faint" title={t('kb.draftHint')}><EyeOff size={11} /></span>}
              {canWrite && (
                <span onClick={(e) => e.stopPropagation()} className="flex shrink-0 items-center">
                <DropdownMenu
                  align="end"
                  trigger={
                    <IconButton size="sm" className="opacity-0 transition-opacity duration-150 group-hover:opacity-100" title={t('common.actions')}>
                      <MoreHorizontal size={13} />
                    </IconButton>
                  }
                >
                  <MenuItem icon={<Plus size={13} />} onSelect={() => actions.onCreateChild(spaceId, n.id)}>{t('kb.newSubpage')}</MenuItem>
                  <MenuItem icon={<Pencil size={13} />} onSelect={() => actions.onRename(spaceId, n)}>{t('kb.rename')}</MenuItem>
                  <MenuItem icon={n.published ? <EyeOff size={13} /> : <Globe size={13} />} onSelect={() => actions.onTogglePublish(spaceId, n)}>
                    {n.published ? t('kb.unpublish') : t('kb.publish')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Link2 size={13} />} onSelect={() => actions.onCopyLink(spaceId, n.id)}>{t('kb.copyLink')}</MenuItem>
                  <MenuItem icon={<ExternalLink size={13} />} onSelect={() => actions.onOpenNewTab(spaceId, n.id)}>{t('kb.openNewTab')}</MenuItem>
                  <MenuSeparator />
                  <MenuItem danger icon={<Trash2 size={13} />} onSelect={() => actions.onDelete(spaceId, n)}>{t('kb.deletePage')}</MenuItem>
                </DropdownMenu>
                </span>
              )}
            </div>
            </ContextMenu>
            {hasChildren && (
              <AccordionPanel open={isOpen}>
                <PageTree
                  nodes={n.children} spaceId={spaceId} activeId={activeId} depth={depth + 1} canWrite={canWrite}
                  expandedPages={expandedPages} onTogglePage={onTogglePage} actions={actions}
                />
              </AccordionPanel>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SpaceSection({ space, active, activePageId, expanded, onToggle, onSelect, canWrite, onNewPage, onAccess, onRenameSpace, onDeleteSpace, actions }: {
  space: Space; active: boolean; activePageId?: string; expanded: boolean; onToggle: () => void; onSelect: () => void;
  canWrite: boolean; onNewPage: (spaceId: string) => void; onAccess: (space: Space) => void;
  onRenameSpace: (space: Space) => void; onDeleteSpace: (space: Space) => void; actions: TreeActions;
}) {
  const t = useT();
  const pagesQ = useQuery({
    queryKey: ['spacePages', space.id],
    queryFn: () => api.get<{ data: FlatPage[] }>(`/spaces/${space.id}/pages`),
    enabled: expanded,
  });
  const tree = useMemo(() => (pagesQ.data ? buildTree(pagesQ.data.data) : []), [pagesQ.data]);
  const [expandedPages, setExpandedPages] = useState<Set<string>>(() => new Set());

  // Auto-expand the ancestor chain of the active page once its siblings load.
  useEffect(() => {
    if (!activePageId || !pagesQ.data) return;
    const byId = new Map(pagesQ.data.data.map((p) => [p.id, p]));
    const toOpen = new Set<string>();
    let cur = byId.get(activePageId);
    while (cur?.parentId) { toOpen.add(cur.parentId); cur = byId.get(cur.parentId); }
    if (toOpen.size) setExpandedPages((prev) => new Set([...prev, ...toOpen]));
  }, [activePageId, pagesQ.data]);

  const togglePage = (id: string) => setExpandedPages((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Right-click menu mirrors the "…" dropdown (both must work). Spaces have
  // no publish toggle (n/a) – only page rows do.
  const spaceCtxItems: ContextMenuEntry[] = [
    { key: 'newPage', label: t('kb.newPage'), icon: <Plus size={13} />, onSelect: () => onNewPage(space.id) },
    { key: 'access', label: t('kb.access'), icon: <Lock size={13} />, onSelect: () => onAccess(space) },
    { key: 'rename', label: t('kb.rename'), icon: <Pencil size={13} />, onSelect: () => onRenameSpace(space) },
    { type: 'separator' },
    { key: 'delete', label: t('kb.deleteSpace'), icon: <Trash2 size={13} />, danger: true, onSelect: () => onDeleteSpace(space) },
  ];

  return (
    <div className="mb-0.5">
      <ContextMenu items={spaceCtxItems} disabled={!canWrite}>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === 'Enter') onSelect(); }}
        className={cn(
          'group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[13px] transition-colors duration-150',
          active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <span onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          <Caret open={expanded} />
        </span>
        {expanded ? <FolderOpen size={14} className="shrink-0 text-faint" /> : <Folder size={14} className="shrink-0 text-faint" />}
        <span className="min-w-0 flex-1 truncate">{space.name}</span>
        {space.visibility === 'private' && (
          <span className="shrink-0 text-faint" title={t('kb.visPrivate')}><Lock size={11} /></span>
        )}
        {canWrite && (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
            <IconButton size="sm" title={t('kb.newPage')} onClick={(e) => { e.stopPropagation(); onNewPage(space.id); }}>
              <Plus size={13} />
            </IconButton>
            <DropdownMenu
              align="end"
              trigger={<IconButton size="sm" title={t('common.actions')}><MoreHorizontal size={13} /></IconButton>}
            >
              <MenuItem icon={<Plus size={13} />} onSelect={() => onNewPage(space.id)}>{t('kb.newPage')}</MenuItem>
              <MenuItem icon={<Lock size={13} />} onSelect={() => onAccess(space)}>{t('kb.access')}</MenuItem>
              <MenuItem icon={<Pencil size={13} />} onSelect={() => onRenameSpace(space)}>{t('kb.rename')}</MenuItem>
              <MenuSeparator />
              <MenuItem danger icon={<Trash2 size={13} />} onSelect={() => onDeleteSpace(space)}>{t('kb.deleteSpace')}</MenuItem>
            </DropdownMenu>
          </span>
        )}
      </div>
      </ContextMenu>
      <AccordionPanel open={expanded}>
        <div className="py-0.5">
          {pagesQ.isLoading && <Skeleton className="mx-2 my-1 h-6" />}
          {pagesQ.data && tree.length === 0 && <p className="px-3 py-1.5 text-xs text-faint">{t('kb.noPages')}</p>}
          <PageTree
            nodes={tree} spaceId={space.id} activeId={activePageId} depth={0} canWrite={canWrite}
            expandedPages={expandedPages} onTogglePage={togglePage} actions={actions}
          />
        </div>
      </AccordionPanel>
    </div>
  );
}

function NameDialog({ open, onClose, onSubmit, title, label, placeholder, initial, pending, submitLabel }: {
  open: boolean; onClose: () => void; onSubmit: (value: string) => void; title: string; label: string;
  placeholder?: string; initial?: string; pending?: boolean; submitLabel?: string;
}) {
  const t = useT();
  const [value, setValue] = useState(initial ?? '');
  useEffect(() => { if (open) setValue(initial ?? ''); }, [open, initial]);
  return (
    <Dialog open={open} onClose={onClose} title={title} width={380}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}
      >
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{label}</label>
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={pending || !value.trim()}>{pending ? <Spinner /> : (submitLabel ?? t('common.create'))}</Button>
        </div>
      </form>
    </Dialog>
  );
}

type NewPageValue = { title: string; type: 'article' | 'pdf'; file: File | null };

/** Create-page dialog: name it, pick what it is, and – for a pdf – hand over the file. */
function NewPageDialog({ open, onClose, onSubmit, title, pending }: {
  open: boolean; onClose: () => void; onSubmit: (value: NewPageValue) => void; title: string; pending?: boolean;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [type, setType] = useState<'article' | 'pdf'>('article');
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setName(''); setType('article'); setFile(null); } }, [open]);

  const canSubmit = !!name.trim() && (type === 'article' || !!file);
  const typeOptions = [
    { key: 'article' as const, icon: <FileText size={15} />, label: t('kb.typeArticle'), hint: t('kb.typeArticleHint') },
    { key: 'pdf' as const, icon: <FileIcon size={15} />, label: t('kb.typePdf'), hint: t('kb.typePdfHint') },
  ];

  return (
    <Dialog open={open} onClose={onClose} title={title} width={420}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(e) => { e.preventDefault(); if (canSubmit) onSubmit({ title: name.trim(), type, file }); }}
      >
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('kb.pageTitle')}</label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('kb.pageTitle')} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('kb.pageType')}</label>
          <div className="grid grid-cols-2 gap-2">
            {typeOptions.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setType(o.key)}
                className={cn(
                  'flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                  type === o.key ? 'border-primary bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/60',
                )}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium">{o.icon}{o.label}</span>
                <span className="text-xs text-faint">{o.hint}</span>
              </button>
            ))}
          </div>
        </div>
        {type === 'pdf' && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('kb.pdfFile')}</label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
            />
            <Button type="button" variant="outline" size="sm" className="w-full justify-start gap-2" onClick={() => fileRef.current?.click()}>
              <Upload size={13} />
              <span className="min-w-0 truncate">{file ? `${file.name} · ${fmtSize(file.size)}` : t('kb.choosePdf')}</span>
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={pending || !canSubmit}>{pending ? <Spinner /> : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function KbPage({ spaceId, pageId }: { spaceId?: string; pageId?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tabs = useTabs();
  const can = useCan();
  const canWrite = can('kb.write');
  const canManageSpaces = can('kb.manage_spaces');

  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<{ data: Space[] }>('/spaces') });

  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(() => new Set(spaceId ? [spaceId] : []));
  useEffect(() => {
    if (spaceId) setExpandedSpaces((prev) => (prev.has(spaceId) ? prev : new Set(prev).add(spaceId)));
  }, [spaceId]);

  const [accessSpace, setAccessSpace] = useState<Space | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const createSpace = useMutation({
    mutationFn: (name: string) => api.post<Space>('/spaces', { name }),
    onSuccess: (s) => {
      setNewSpaceOpen(false);
      qc.invalidateQueries({ queryKey: ['spaces'] });
      if (s?.id) navigate(`/kb/${s.id}`);
    },
    onError: () => toast.error(t('kb.createSpaceFailed')),
  });

  const [newPageCtx, setNewPageCtx] = useState<{ spaceId: string; parentId: string | null } | null>(null);
  const createPage = useMutation({
    mutationFn: async (vars: { spaceId: string; parentId: string | null } & NewPageValue) => {
      // The file goes up first – the page only exists once its document does.
      const fileId = vars.type === 'pdf' && vars.file ? (await uploadPdf(vars.file)).id : undefined;
      return api.post<{ id: string }>('/pages', {
        spaceId: vars.spaceId, title: vars.title, parentId: vars.parentId,
        type: vars.type, fileId, body: EMPTY_DOC,
      });
    },
    onSuccess: (p, vars) => {
      setNewPageCtx(null);
      qc.invalidateQueries({ queryKey: ['spacePages', vars.spaceId] });
      if (p?.id) navigate(`/kb/${vars.spaceId}/${p.id}`);
    },
    onError: (e) => toast.error(e instanceof UploadError ? t(uploadErrorKey(e)) : t('kb.createPageFailed')),
  });

  const [renameCtx, setRenameCtx] = useState<{ spaceId: string; page: FlatPage } | null>(null);
  const renamePage = useMutation({
    mutationFn: (vars: { id: string; title: string; version?: number }) =>
      api.patch(`/pages/${vars.id}`, { title: vars.title, version: vars.version }),
    onSuccess: (_r, vars) => {
      setRenameCtx(null);
      qc.invalidateQueries({ queryKey: ['spacePages'] });
      qc.invalidateQueries({ queryKey: ['page', vars.id] });
      toast(t('kb.renamed'));
    },
    onError: () => toast.error(t('kb.renameFailed')),
  });

  const togglePublish = useMutation({
    mutationFn: (vars: { id: string; version?: number; published: boolean }) =>
      api.patch(`/pages/${vars.id}`, { published: vars.published, version: vars.version }),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['spacePages'] });
      qc.invalidateQueries({ queryKey: ['page', vars.id] });
      toast(vars.published ? t('kb.publish') : t('kb.unpublish'));
    },
    onError: () => toast.error(t('kb.publishFailed')),
  });

  /* ── Space rename / delete ── */
  const [renameSpaceCtx, setRenameSpaceCtx] = useState<Space | null>(null);
  const renameSpace = useMutation({
    mutationFn: (vars: { id: string; name: string; version?: number }) =>
      api.patch(`/spaces/${vars.id}`, { name: vars.name, version: vars.version }),
    onSuccess: () => {
      setRenameSpaceCtx(null);
      qc.invalidateQueries({ queryKey: ['spaces'] });
      toast(t('kb.spaceRenamed'));
    },
    onError: () => toast.error(t('kb.renameSpaceFailed')),
  });

  const [deleteSpaceCtx, setDeleteSpaceCtx] = useState<Space | null>(null);
  const deleteSpace = useMutation({
    mutationFn: (id: string) => api.del(`/spaces/${id}`),
    onSuccess: (_r, id) => {
      setDeleteSpaceCtx(null);
      qc.invalidateQueries({ queryKey: ['spaces'] });
      toast(t('kb.spaceDeleted'));
      if (id === spaceId) navigate('/kb');
    },
    onError: () => toast.error(t('kb.deleteSpaceFailed')),
  });

  /* ── Page delete / link helpers ── */
  const [deletePageCtx, setDeletePageCtx] = useState<{ spaceId: string; page: FlatPage } | null>(null);
  const deletePage = useMutation({
    mutationFn: (vars: { spaceId: string; id: string }) => api.del(`/pages/${vars.id}`),
    onSuccess: (_r, vars) => {
      setDeletePageCtx(null);
      qc.invalidateQueries({ queryKey: ['spacePages', vars.spaceId] });
      toast(t('kb.pageDeleted'));
      if (vars.id === pageId) navigate(`/kb/${vars.spaceId}`);
    },
    onError: () => toast.error(t('kb.deletePageFailed')),
  });

  const copyPageLink = async (sid: string, pid: string) => {
    try {
      await navigator.clipboard.writeText(`${appOrigin()}/kb/${sid}/${pid}`);
      toast(t('kb.linkCopied'));
    } catch {
      toast.error(t('common.error'));
    }
  };

  const treeActions: TreeActions = {
    onNavigate: (sid, pid) => navigate(`/kb/${sid}/${pid}`),
    onCreateChild: (sid, parentId) => setNewPageCtx({ spaceId: sid, parentId }),
    onRename: (sid, page) => setRenameCtx({ spaceId: sid, page }),
    onTogglePublish: (sid, page) => togglePublish.mutate({ id: page.id, version: page.version, published: !page.published }),
    onCopyLink: (sid, pid) => { void copyPageLink(sid, pid); },
    onOpenNewTab: (sid, pid) => {
      if (tabs) tabs.openInNewTab(`/kb/${sid}/${pid}`);
      else navigate(`/kb/${sid}/${pid}`);
    },
    onDelete: (sid, page) => setDeletePageCtx({ spaceId: sid, page }),
  };

  return (
    <div className="flex h-full">
      {/* Left: spaces + page tree */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">{t('kb.spaces')}</span>
          {canManageSpaces && (
            <IconButton size="sm" onClick={() => setNewSpaceOpen(true)} title={t('kb.newSpace')}>
              <Plus size={14} />
            </IconButton>
          )}
        </div>
        <div className="flex-1 overflow-auto px-2 pb-3">
          {spaces.isLoading && (
            <div className="space-y-1 px-1">
              <Skeleton className="h-7" />
              <Skeleton className="h-7" />
              <Skeleton className="h-7" />
            </div>
          )}
          {spaces.data?.data.length === 0 && (
            <EmptyState icon={<BookOpen size={18} />} title={t('kb.noSpaces')} hint={canManageSpaces ? t('kb.newSpaceHint') : undefined} />
          )}
          {spaces.data?.data.map((s) => (
            <SpaceSection
              key={s.id}
              space={s}
              active={s.id === spaceId}
              activePageId={s.id === spaceId ? pageId : undefined}
              expanded={expandedSpaces.has(s.id)}
              onToggle={() => setExpandedSpaces((prev) => {
                const next = new Set(prev);
                if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                return next;
              })}
              onSelect={() => navigate(`/kb/${s.id}`)}
              canWrite={canWrite}
              onNewPage={(sid) => setNewPageCtx({ spaceId: sid, parentId: null })}
              onAccess={setAccessSpace}
              onRenameSpace={setRenameSpaceCtx}
              onDeleteSpace={setDeleteSpaceCtx}
              actions={treeActions}
            />
          ))}
        </div>
      </aside>

      {/* Right: page detail */}
      <div className="flex-1 overflow-auto">
        {!spaceId && (
          <EmptyState icon={<BookOpen size={20} />} title={t('kb.title')} hint={t('kb.pickSpaceHint')} />
        )}
        {spaceId && !pageId && (
          <EmptyState icon={<FileQuestion size={20} />} title={t('kb.selectPage')} hint={t('kb.selectPageHint')} />
        )}
        {spaceId && pageId && <PageDetailView pageId={pageId} spaceId={spaceId} canWrite={canWrite} />}
      </div>

      <NameDialog
        open={newSpaceOpen}
        onClose={() => setNewSpaceOpen(false)}
        onSubmit={(name) => createSpace.mutate(name)}
        title={t('kb.newSpace')}
        label={t('kb.spaceName')}
        placeholder={t('kb.spaceName')}
        pending={createSpace.isPending}
      />
      <NewPageDialog
        open={!!newPageCtx}
        onClose={() => setNewPageCtx(null)}
        onSubmit={(value) => newPageCtx && createPage.mutate({ ...newPageCtx, ...value })}
        title={newPageCtx?.parentId ? t('kb.newSubpage') : t('kb.newPage')}
        pending={createPage.isPending}
      />
      <NameDialog
        open={!!renameCtx}
        onClose={() => setRenameCtx(null)}
        onSubmit={(title) => renameCtx && renamePage.mutate({ id: renameCtx.page.id, title, version: renameCtx.page.version })}
        title={t('kb.renamePage')}
        label={t('kb.pageTitle')}
        initial={renameCtx?.page.title}
        pending={renamePage.isPending}
        submitLabel={t('common.save')}
      />
      <NameDialog
        open={!!renameSpaceCtx}
        onClose={() => setRenameSpaceCtx(null)}
        onSubmit={(name) => renameSpaceCtx && renameSpace.mutate({ id: renameSpaceCtx.id, name, version: renameSpaceCtx.version })}
        title={t('kb.renameSpace')}
        label={t('kb.spaceName')}
        initial={renameSpaceCtx?.name}
        pending={renameSpace.isPending}
        submitLabel={t('common.save')}
      />
      <ConfirmDialog
        open={!!deleteSpaceCtx}
        onClose={() => setDeleteSpaceCtx(null)}
        onConfirm={() => deleteSpaceCtx && deleteSpace.mutate(deleteSpaceCtx.id)}
        title={t('kb.deleteSpaceTitle')}
        body={t('kb.deleteSpaceBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={deleteSpace.isPending}
      />
      <ConfirmDialog
        open={!!deletePageCtx}
        onClose={() => setDeletePageCtx(null)}
        onConfirm={() => deletePageCtx && deletePage.mutate({ spaceId: deletePageCtx.spaceId, id: deletePageCtx.page.id })}
        title={t('kb.deletePageTitle')}
        body={t('kb.deletePageBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={deletePage.isPending}
      />
      {accessSpace && (
        <SpaceAccessDialog
          open
          onClose={() => setAccessSpace(null)}
          space={(spaces.data?.data.find((s) => s.id === accessSpace.id) ?? accessSpace) as AccessSpace}
        />
      )}
    </div>
  );
}

function PageDetailView({ pageId, spaceId, canWrite }: { pageId: string; spaceId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [bodyDoc, setBodyDoc] = useState<any>(EMPTY_DOC);
  const [showVersions, setShowVersions] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const page = useQuery({ queryKey: ['page', pageId], queryFn: () => api.get<PageDetail>(`/pages/${pageId}`) });
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<{ data: Space[] }>('/spaces') });
  const flat = useQuery({
    queryKey: ['spacePages', spaceId],
    queryFn: () => api.get<{ data: FlatPage[] }>(`/spaces/${spaceId}/pages`),
    enabled: !!spaceId,
  });

  useEffect(() => { setShowVersions(false); }, [pageId]);

  useEffect(() => {
    if (page.data) {
      setTitle(page.data.title ?? '');
      setBodyDoc(page.data.body ?? EMPTY_DOC);
    }
  }, [page.data]);

  /* Grow the title box to fit, so long titles wrap instead of being clipped. */
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const fit = () => { el.style.height = '0px'; el.style.height = `${el.scrollHeight}px`; };
    fit();
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return; // ignore our own height changes
      lastWidth = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [title]);

  const dirty = !!page.data && (
    title !== (page.data.title ?? '') || JSON.stringify(bodyDoc) !== JSON.stringify(page.data.body ?? EMPTY_DOC)
  );

  const save = useMutation({
    mutationFn: () => api.patch(`/pages/${pageId}`, { title, body: bodyDoc, version: page.data?.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['page', pageId] });
      qc.invalidateQueries({ queryKey: ['spacePages'] });
      toast(t('kb.saved'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        qc.invalidateQueries({ queryKey: ['page', pageId] });
        toast.error(t('kb.conflict'));
      } else {
        toast.error(t('kb.saveFailed'));
      }
    },
  });

  const discard = () => {
    if (!page.data) return;
    setTitle(page.data.title ?? '');
    setBodyDoc(page.data.body ?? EMPTY_DOC);
  };

  const publish = useMutation({
    mutationFn: () => api.patch(`/pages/${pageId}`, { published: true, version: page.data?.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['page', pageId] });
      qc.invalidateQueries({ queryKey: ['spacePages'] });
      toast(t('kb.published'));
    },
    onError: () => toast.error(t('kb.publishFailed')),
  });

  const ancestors = useMemo(() => {
    if (!flat.data) return [] as FlatPage[];
    const byId = new Map(flat.data.data.map((p) => [p.id, p]));
    const chain: FlatPage[] = [];
    let cur = byId.get(pageId);
    cur = cur?.parentId ? byId.get(cur.parentId) : undefined;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }, [flat.data, pageId]);

  const spaceName = spaces.data?.data.find((s) => s.id === spaceId)?.name;

  if (page.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-8">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (page.isError || !page.data) {
    return <EmptyState icon={<FileQuestion size={20} />} title={t('kb.pageNotFound')} />;
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Breadcrumbs
          items={[
            { label: t('nav.knowledge'), to: '/kb', icon: <BookOpen size={13} /> },
            { label: spaceName ?? '–', to: `/kb/${spaceId}` },
            ...ancestors.map((a): BreadcrumbItem => ({ label: a.title || t('kb.untitled'), to: `/kb/${spaceId}/${a.id}` })),
            { label: title || t('kb.untitled') },
          ]}
        />
        <div className="flex shrink-0 items-center gap-2">
          {!page.data.published && (
            <>
              <span title={t('kb.draftHint')}><Badge className="bg-warning/15 text-warning">{t('kb.draft')}</Badge></span>
              {canWrite && (
                <Button size="sm" variant="ghost" onClick={() => publish.mutate()} disabled={publish.isPending}>
                  {publish.isPending ? <Spinner /> : t('kb.publish')}
                </Button>
              )}
            </>
          )}
          <IconButton
            size="sm"
            onClick={() => setShowVersions((v) => !v)}
            title={t('kb.history')}
            className={cn(showVersions && 'bg-muted text-foreground')}
          >
            <History size={14} />
          </IconButton>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="min-w-0 flex-1 pb-24">
          <textarea
            ref={titleRef}
            rows={1}
            value={title}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
            }}
            placeholder={t('kb.untitled')}
            readOnly={!canWrite}
            className="w-full resize-none overflow-hidden break-words bg-transparent text-[28px] font-bold leading-tight text-foreground outline-none placeholder:text-faint focus-visible:outline-none"
          />
          <p className="mb-5 mt-1 text-xs text-faint">
            {page.data.updatedAt ? `${t('kb.updated')} ${fmtDate(page.data.updatedAt)}` : ' '}
          </p>
          {page.data.type === 'pdf' ? (
            <PdfPageView page={page.data} pageId={pageId} canWrite={canWrite} />
          ) : (
            <RichEditor
              value={bodyDoc}
              onChange={setBodyDoc}
              editable={canWrite}
              compact={false}
              placeholder={t('kb.bodyPlaceholder')}
              onSubmit={() => { if (!save.isPending) save.mutate(); }}
            />
          )}
        </div>
        {showVersions && <VersionsPanel pageId={pageId} />}
      </div>

      {canWrite && dirty && (
        <div className="sticky bottom-4 z-10 flex justify-center">
          <div className="anim-pop-in flex items-center gap-3 rounded-lg border border-border bg-elevated px-3 py-2 shadow-pop">
            <span className="text-xs text-muted-foreground">{t('kb.unsavedChanges')}</span>
            <Button variant="ghost" size="sm" onClick={discard}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? <Spinner /> : t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline viewer for a pdf page: the browser's native viewer in a frame, like FilePreview. */
function PdfPageView({ page, pageId, canWrite }: { page: PageDetail; pageId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const replaceRef = useRef<HTMLInputElement>(null);

  const replace = useMutation({
    mutationFn: async (file: File) => {
      const up = await uploadPdf(file);
      return api.patch(`/pages/${pageId}`, { fileId: up.id, version: page.version });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['page', pageId] });
      toast(t('kb.pdfReplaced'));
    },
    onError: (e) => {
      if (e instanceof UploadError) toast.error(t(uploadErrorKey(e)));
      else if (e instanceof ApiError && e.status === 409) {
        qc.invalidateQueries({ queryKey: ['page', pageId] });
        toast.error(t('kb.conflict'));
      } else toast.error(t('kb.saveFailed'));
    },
  });

  const replaceInput = canWrite && (
    <input
      ref={replaceRef}
      type="file"
      accept="application/pdf,.pdf"
      className="hidden"
      onChange={(e) => { const f = e.target.files?.[0]; if (f) replace.mutate(f); e.target.value = ''; }}
    />
  );

  if (!page.file) {
    return (
      <div>
        {replaceInput}
        <EmptyState
          icon={<FileQuestion size={20} />}
          title={t('kb.pdfMissing')}
          hint={canWrite ? t('kb.pdfMissingHint') : undefined}
          action={canWrite ? (
            <Button size="sm" variant="outline" onClick={() => replaceRef.current?.click()} disabled={replace.isPending}>
              {replace.isPending ? <Spinner /> : t('kb.replacePdf')}
            </Button>
          ) : undefined}
        />
      </div>
    );
  }

  const href = resolveFileSrc(page.file.src);
  return (
    <div className="space-y-2">
      {replaceInput}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileIcon size={13} className="shrink-0 text-faint" />
        <span className="min-w-0 truncate">{page.file.filename}</span>
        <span className="shrink-0 text-faint">{fmtSize(page.file.size)}</span>
        <span className="flex-1" />
        {canWrite && (
          <Button size="sm" variant="ghost" onClick={() => replaceRef.current?.click()} disabled={replace.isPending}>
            {replace.isPending ? <Spinner /> : (<><Upload size={13} className="mr-1" />{t('kb.replacePdf')}</>)}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openExternal(href)}>
          <ExternalLink size={13} className="mr-1" />{t('kb.openNewTab')}
        </Button>
      </div>
      <iframe
        src={href}
        title={page.file.filename}
        className="h-[75vh] w-full rounded-lg border border-border bg-muted/30"
      />
    </div>
  );
}

function VersionsPanel({ pageId }: { pageId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const versions = useQuery({ queryKey: ['pageVersions', pageId], queryFn: () => api.get<{ data: Version[] }>(`/pages/${pageId}/versions`) });
  const restore = useMutation({
    mutationFn: (versionNo: number) => api.post(`/pages/${pageId}/restore`, { versionNo }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['page', pageId] });
      qc.invalidateQueries({ queryKey: ['pageVersions', pageId] });
      toast(t('kb.restored'));
    },
    onError: () => toast.error(t('kb.restoreFailed')),
  });
  return (
    <Card className="w-64 shrink-0 self-start anim-pop-in">
      <div className="border-b border-border px-3 py-2 text-[13px] font-medium">{t('kb.versions')}</div>
      <div className="max-h-[70vh] overflow-auto p-1.5">
        {versions.isLoading && <Skeleton className="h-6" />}
        {versions.data && versions.data.data.length === 0 && <p className="p-2 text-xs text-faint">{t('kb.noVersions')}</p>}
        {versions.data?.data.map((v) => (
          <div key={String(v.versionNo)} className="flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] hover:bg-muted/60">
            <div className="min-w-0">
              <div className="truncate font-medium">v{v.versionNo}</div>
              <div className="text-xs text-faint">{fmtDate(v.createdAt)}</div>
            </div>
            <IconButton size="sm" title={t('kb.restore')} onClick={() => restore.mutate(v.versionNo)} disabled={restore.isPending}>
              <RotateCcw size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    </Card>
  );
}
