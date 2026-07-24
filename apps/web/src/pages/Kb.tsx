import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { api } from '../lib/api';
import { Button, Input, Card, PageHeader, EmptyState, Skeleton, fmtDate, cn } from '../components/ui';
import { Plus, History, Pencil, FileText, ChevronRight, RotateCcw } from 'lucide-react';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { RichText, docIsEmpty } from '../components/richtext/RichText';
import { useT } from '../lib/i18n';

interface Space { id: string; name: string; icon?: string | null }
interface FlatPage { id: string; title: string; parentId: string | null; position?: number }
interface PageNode extends FlatPage { children: PageNode[] }
interface PageDetail { id: string; title: string; body: unknown; spaceId: string; updatedAt?: string; version?: number }
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

function PageTree({ nodes, spaceId, activeId, depth }: { nodes: PageNode[]; spaceId: string; activeId?: string; depth: number }) {
  const t = useT();
  return (
    <div className="space-y-0.5">
      {nodes.map((n) => (
        <div key={n.id}>
          <Link
            to={`/kb/${spaceId}/${n.id}`}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1 text-sm',
              n.id === activeId ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
            )}
          >
            <span style={{ paddingLeft: depth * 12 }} className="flex items-center gap-1.5">
              {n.children.length > 0 ? <ChevronRight size={13} /> : <FileText size={13} />}
              <span className="truncate">{n.title || t('kb.untitled')}</span>
            </span>
          </Link>
          {n.children.length > 0 && <PageTree nodes={n.children} spaceId={spaceId} activeId={activeId} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}

export function KbPage({ spaceId, pageId }: { spaceId?: string; pageId?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const canWrite = can('kb.write');
  const canManageSpaces = can('kb.manage_spaces');

  const [newSpace, setNewSpace] = useState('');
  const [addingSpace, setAddingSpace] = useState(false);
  const [newPage, setNewPage] = useState('');
  const [addingPage, setAddingPage] = useState(false);

  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<{ data: Space[] }>('/spaces') });
  const pages = useQuery({
    queryKey: ['spacePages', spaceId],
    queryFn: () => api.get<{ data: FlatPage[] }>(`/spaces/${spaceId}/pages`),
    enabled: !!spaceId,
  });

  const createSpace = useMutation({
    mutationFn: (name: string) => api.post<Space>('/spaces', { name }),
    onSuccess: (s) => {
      setNewSpace('');
      setAddingSpace(false);
      qc.invalidateQueries({ queryKey: ['spaces'] });
      if (s?.id) navigate(`/kb/${s.id}`);
    },
  });
  const createPage = useMutation({
    mutationFn: (title: string) => api.post<{ id: string }>('/pages', { spaceId, title, parentId: null, body: EMPTY_DOC }),
    onSuccess: (p) => {
      setNewPage('');
      setAddingPage(false);
      qc.invalidateQueries({ queryKey: ['spacePages', spaceId] });
      if (p?.id && spaceId) navigate(`/kb/${spaceId}/${p.id}`);
    },
  });

  const tree = pages.data ? buildTree(pages.data.data) : [];

  return (
    <div className="flex h-full">
      {/* Left: spaces + page tree */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('kb.spaces')}</span>
          {canManageSpaces && (
            <button className="rounded p-1 hover:bg-muted" onClick={() => setAddingSpace((v) => !v)} title={t('kb.newSpace')}>
              <Plus size={15} />
            </button>
          )}
        </div>
        {addingSpace && (
          <form
            className="flex gap-1 px-3 pb-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newSpace.trim()) createSpace.mutate(newSpace.trim());
            }}
          >
            <Input autoFocus value={newSpace} onChange={(e) => setNewSpace(e.target.value)} placeholder={t('kb.spaceName')} className="h-7 text-xs" />
            <Button size="sm" type="submit" disabled={createSpace.isPending}>{t('common.add')}</Button>
          </form>
        )}
        <div className="px-2">
          {spaces.isLoading && <Skeleton className="mx-1 h-7" />}
          {spaces.data?.data.map((s) => (
            <Link
              key={s.id}
              to={`/kb/${s.id}`}
              className={cn('flex items-center gap-2 rounded px-2 py-1.5 text-sm', s.id === spaceId ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}
            >
              <span>{s.icon ?? '📁'}</span>
              <span className="truncate">{s.name}</span>
            </Link>
          ))}
          {spaces.data && spaces.data.data.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{t('kb.noSpaces')}</p>}
        </div>

        {spaceId && (
          <div className="mt-2 flex-1 overflow-auto border-t border-border pt-2">
            <div className="flex items-center justify-between px-3 pb-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('kb.pages')}</span>
              {canWrite && (
                <button className="rounded p-1 hover:bg-muted" onClick={() => setAddingPage((v) => !v)} title={t('kb.newPage')}>
                  <Plus size={15} />
                </button>
              )}
            </div>
            {addingPage && (
              <form
                className="flex gap-1 px-3 pb-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newPage.trim()) createPage.mutate(newPage.trim());
                }}
              >
                <Input autoFocus value={newPage} onChange={(e) => setNewPage(e.target.value)} placeholder={t('kb.pageTitle')} className="h-7 text-xs" />
                <Button size="sm" type="submit" disabled={createPage.isPending}>{t('common.add')}</Button>
              </form>
            )}
            <div className="px-2">
              {pages.isLoading && <Skeleton className="mx-1 h-6" />}
              {pages.data && tree.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">{t('kb.noPages')}</p>}
              <PageTree nodes={tree} spaceId={spaceId} activeId={pageId} depth={0} />
            </div>
          </div>
        )}
      </aside>

      {/* Right: page detail */}
      <div className="flex-1 overflow-auto">
        {!spaceId && (
          <EmptyState title={t('kb.title')} hint={t('kb.pickSpaceHint')} />
        )}
        {spaceId && !pageId && (
          <EmptyState title={t('kb.selectPage')} hint={t('kb.selectPageHint')} />
        )}
        {spaceId && pageId && <PageDetailView pageId={pageId} canWrite={canWrite} />}
      </div>
    </div>
  );
}

function PageDetailView({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [bodyDoc, setBodyDoc] = useState<any>(EMPTY_DOC);
  const [showVersions, setShowVersions] = useState(false);

  const page = useQuery({ queryKey: ['page', pageId], queryFn: () => api.get<PageDetail>(`/pages/${pageId}`) });

  useEffect(() => {
    setEditing(false);
    setShowVersions(false);
  }, [pageId]);

  useEffect(() => {
    if (page.data) {
      setTitle(page.data.title ?? '');
      setBodyDoc(page.data.body ?? EMPTY_DOC);
    }
  }, [page.data]);

  const save = useMutation({
    mutationFn: () => api.patch(`/pages/${pageId}`, { title, body: bodyDoc, version: page.data?.version }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['page', pageId] });
      qc.invalidateQueries({ queryKey: ['spacePages'] });
    },
  });

  if (page.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-8">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (page.isError || !page.data) return <div className="p-8 text-sm text-muted-foreground">{t('kb.pageNotFound')}</div>;

  return (
    <div>
      <PageHeader
        title={editing ? t('kb.editingPage') : page.data.title || t('kb.untitled')}
        subtitle={page.data.updatedAt ? `${t('kb.updated')} ${fmtDate(page.data.updatedAt)}` : undefined}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setShowVersions((v) => !v)}>
              <History size={14} /> {t('kb.history')}
            </Button>
            {canWrite && !editing && (
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil size={14} /> {t('common.edit')}
              </Button>
            )}
            {editing && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>
                <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>{t('common.save')}</Button>
              </>
            )}
          </>
        }
      />
      <div className="flex">
        <div className="mx-auto max-w-3xl flex-1 p-8">
          {save.isError && <p className="mb-3 text-sm text-destructive">{t('kb.saveFailed')}</p>}
          {editing ? (
            <div className="space-y-3">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('common.title')} className="text-lg font-semibold" />
              <RichEditor value={bodyDoc} onChange={setBodyDoc} placeholder={t('kb.bodyPlaceholder')} onSubmit={() => { if (!save.isPending) save.mutate(); }} />
            </div>
          ) : docIsEmpty(page.data.body) ? (
            <p className="text-sm text-muted-foreground">{t('kb.emptyPage')}</p>
          ) : (
            <RichText doc={page.data.body} className="text-sm" />
          )}
        </div>
        {showVersions && <VersionsPanel pageId={pageId} />}
      </div>
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
    },
  });
  return (
    <Card className="m-4 w-72 shrink-0 self-start">
      <div className="border-b border-border px-3 py-2 text-sm font-medium">{t('kb.versions')}</div>
      <div className="max-h-[70vh] overflow-auto p-2">
        {versions.isLoading && <Skeleton className="h-6" />}
        {versions.data && versions.data.data.length === 0 && <p className="p-2 text-xs text-muted-foreground">{t('kb.noVersions')}</p>}
        {versions.data?.data.map((v) => (
          <div key={String(v.versionNo)} className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted/60">
            <div>
              <div className="font-medium">v{v.versionNo}</div>
              <div className="text-xs text-muted-foreground">{fmtDate(v.createdAt)}</div>
            </div>
            <button className="rounded p-1 text-muted-foreground hover:bg-muted" title={t('kb.restore')} onClick={() => restore.mutate(v.versionNo)} disabled={restore.isPending}>
              <RotateCcw size={14} />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}
