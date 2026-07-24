import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { api, ApiError } from '../lib/api';
import {
  Button, IconButton, Input, Card, Badge, EmptyState, Skeleton, Spinner, fmtDate, cn,
} from '../components/ui';
import { Dialog, DropdownMenu, MenuItem, toast } from '../components/overlays';
import {
  Plus, History, FileText, ChevronRight, RotateCcw, Folder, FolderOpen,
  MoreHorizontal, Pencil, Globe, EyeOff, BookOpen, FileQuestion,
} from 'lucide-react';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'kb.rename': 'Rename',
    'kb.renamePage': 'Rename page',
    'kb.renameFailed': 'Could not rename the page',
    'kb.publish': 'Publish',
    'kb.unpublish': 'Unpublish',
    'kb.published': 'Published',
    'kb.publishFailed': 'Could not update the publish status',
    'kb.newSubpage': 'New subpage',
    'kb.createSpaceFailed': 'Could not create the space',
    'kb.createPageFailed': 'Could not create the page',
    'kb.restoreFailed': 'Could not restore this version',
    'kb.restored': 'Version restored',
    'kb.renamed': 'Page renamed',
    'kb.saved': 'Page saved',
    'kb.unsavedChanges': 'Unsaved changes',
    'kb.conflict': 'This page changed elsewhere — refreshed with the latest version',
    'kb.newSpaceHint': 'Spaces group related pages together.',
  },
  uk: {
    'kb.rename': 'Перейменувати',
    'kb.renamePage': 'Перейменувати сторінку',
    'kb.renameFailed': 'Не вдалося перейменувати сторінку',
    'kb.publish': 'Опублікувати',
    'kb.unpublish': 'Зняти з публікації',
    'kb.published': 'Опубліковано',
    'kb.publishFailed': 'Не вдалося змінити статус публікації',
    'kb.newSubpage': 'Нова підсторінка',
    'kb.createSpaceFailed': 'Не вдалося створити простір',
    'kb.createPageFailed': 'Не вдалося створити сторінку',
    'kb.restoreFailed': 'Не вдалося відновити цю версію',
    'kb.restored': 'Версію відновлено',
    'kb.renamed': 'Сторінку перейменовано',
    'kb.saved': 'Сторінку збережено',
    'kb.unsavedChanges': 'Є незбережені зміни',
    'kb.conflict': 'Сторінку змінили деінде — оновлено до останньої версії',
    'kb.newSpaceHint': 'Простори групують пов’язані сторінки.',
  },
});

interface Space { id: string; name: string; icon?: string | null }
interface FlatPage { id: string; title: string; parentId: string | null; position?: number; published?: boolean; version?: number }
interface PageNode extends FlatPage { children: PageNode[] }
interface PageDetail { id: string; title: string; body: unknown; spaceId: string; updatedAt?: string; version?: number; published?: boolean }
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
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 200ms var(--ease-smooth-out)' }}
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
        return (
          <div key={n.id}>
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
              <FileText size={13} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate">{n.title || t('kb.untitled')}</span>
              {n.published && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title={t('kb.published')} />}
              {canWrite && (
                <DropdownMenu
                  align="end"
                  trigger={
                    <IconButton size="sm" className="opacity-0 transition-opacity duration-150 group-hover:opacity-100" title={t('common.edit')}>
                      <MoreHorizontal size={13} />
                    </IconButton>
                  }
                >
                  <MenuItem icon={<Plus size={13} />} onSelect={() => actions.onCreateChild(spaceId, n.id)}>{t('kb.newSubpage')}</MenuItem>
                  <MenuItem icon={<Pencil size={13} />} onSelect={() => actions.onRename(spaceId, n)}>{t('kb.rename')}</MenuItem>
                  <MenuItem icon={n.published ? <EyeOff size={13} /> : <Globe size={13} />} onSelect={() => actions.onTogglePublish(spaceId, n)}>
                    {n.published ? t('kb.unpublish') : t('kb.publish')}
                  </MenuItem>
                </DropdownMenu>
              )}
            </div>
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

function SpaceSection({ space, active, activePageId, expanded, onToggle, onSelect, canWrite, onNewPage, actions }: {
  space: Space; active: boolean; activePageId?: string; expanded: boolean; onToggle: () => void; onSelect: () => void;
  canWrite: boolean; onNewPage: (spaceId: string) => void; actions: TreeActions;
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

  return (
    <div className="mb-0.5">
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
        {canWrite && (
          <IconButton
            size="sm"
            className="opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            title={t('kb.newPage')}
            onClick={(e) => { e.stopPropagation(); onNewPage(space.id); }}
          >
            <Plus size={13} />
          </IconButton>
        )}
      </div>
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

function NameDialog({ open, onClose, onSubmit, title, label, placeholder, initial, pending }: {
  open: boolean; onClose: () => void; onSubmit: (value: string) => void; title: string; label: string;
  placeholder?: string; initial?: string; pending?: boolean;
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
          <Button type="submit" size="sm" disabled={pending || !value.trim()}>{pending ? <Spinner /> : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function KbPage({ spaceId, pageId }: { spaceId?: string; pageId?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const canWrite = can('kb.write');
  const canManageSpaces = can('kb.manage_spaces');

  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<{ data: Space[] }>('/spaces') });

  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(() => new Set(spaceId ? [spaceId] : []));
  useEffect(() => {
    if (spaceId) setExpandedSpaces((prev) => (prev.has(spaceId) ? prev : new Set(prev).add(spaceId)));
  }, [spaceId]);

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
    mutationFn: (vars: { spaceId: string; parentId: string | null; title: string }) =>
      api.post<{ id: string }>('/pages', { spaceId: vars.spaceId, title: vars.title, parentId: vars.parentId, body: EMPTY_DOC }),
    onSuccess: (p, vars) => {
      setNewPageCtx(null);
      qc.invalidateQueries({ queryKey: ['spacePages', vars.spaceId] });
      if (p?.id) navigate(`/kb/${vars.spaceId}/${p.id}`);
    },
    onError: () => toast.error(t('kb.createPageFailed')),
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

  const treeActions: TreeActions = {
    onNavigate: (sid, pid) => navigate(`/kb/${sid}/${pid}`),
    onCreateChild: (sid, parentId) => setNewPageCtx({ spaceId: sid, parentId }),
    onRename: (sid, page) => setRenameCtx({ spaceId: sid, page }),
    onTogglePublish: (sid, page) => togglePublish.mutate({ id: page.id, version: page.version, published: !page.published }),
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
      <NameDialog
        open={!!newPageCtx}
        onClose={() => setNewPageCtx(null)}
        onSubmit={(title) => newPageCtx && createPage.mutate({ ...newPageCtx, title })}
        title={newPageCtx?.parentId ? t('kb.newSubpage') : t('kb.newPage')}
        label={t('kb.pageTitle')}
        placeholder={t('kb.pageTitle')}
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
      />
    </div>
  );
}

function PageDetailView({ pageId, spaceId, canWrite }: { pageId: string; spaceId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [bodyDoc, setBodyDoc] = useState<any>(EMPTY_DOC);
  const [showVersions, setShowVersions] = useState(false);

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
        <nav className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">{spaceName ?? '—'}</span>
          {ancestors.map((a) => (
            <span key={a.id} className="flex items-center gap-1 truncate">
              <ChevronRight size={11} className="shrink-0 text-faint" />
              <span className="truncate">{a.title || t('kb.untitled')}</span>
            </span>
          ))}
          <span className="flex items-center gap-1 truncate">
            <ChevronRight size={11} className="shrink-0 text-faint" />
            <span className="truncate font-medium text-foreground">{title || t('kb.untitled')}</span>
          </span>
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          {page.data.published && <Badge className="bg-success/15 text-success">{t('kb.published')}</Badge>}
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
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('kb.untitled')}
            readOnly={!canWrite}
            className="w-full truncate bg-transparent text-[28px] font-bold leading-tight text-foreground outline-none placeholder:text-faint"
          />
          <p className="mb-5 mt-1 text-xs text-faint">
            {page.data.updatedAt ? `${t('kb.updated')} ${fmtDate(page.data.updatedAt)}` : ' '}
          </p>
          <RichEditor
            value={bodyDoc}
            onChange={setBodyDoc}
            editable={canWrite}
            compact={false}
            placeholder={t('kb.bodyPlaceholder')}
            onSubmit={() => { if (!save.isPending) save.mutate(); }}
          />
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
