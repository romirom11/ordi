import { type ReactNode, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { api } from '../lib/api';
import { Button, Input, Textarea, Card, PageHeader, EmptyState, Skeleton, fmtDate, cn } from '../components/ui';
import { Plus, History, Pencil, FileText, ChevronRight, RotateCcw } from 'lucide-react';

interface Space { id: string; name: string; icon?: string | null }
interface FlatPage { id: string; title: string; parentId: string | null; position?: number }
interface PageNode extends FlatPage { children: PageNode[] }
interface PageDetail { id: string; title: string; body: unknown; spaceId: string; updatedAt?: string }
interface Version { id?: string; versionNo: number; title: string; authorId?: string | null; createdAt: string }

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

function textToDoc(text: string): unknown {
  const paras = text.split('\n\n').map((block) => ({
    type: 'paragraph',
    content: block ? [{ type: 'text', text: block }] : [],
  }));
  return { type: 'doc', content: paras.length ? paras : [{ type: 'paragraph' }] };
}

function docToText(doc: any): string {
  if (!doc || !Array.isArray(doc.content)) return '';
  const blocks: string[] = [];
  const walk = (nodes: any[]): string =>
    nodes
      .map((n) => {
        if (n?.type === 'text') return n.text ?? '';
        if (Array.isArray(n?.content)) return walk(n.content);
        return '';
      })
      .join('');
  for (const node of doc.content) {
    if (Array.isArray(node?.content)) blocks.push(walk(node.content));
    else blocks.push('');
  }
  return blocks.join('\n\n');
}

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

function renderInline(content: any, keyPrefix: string): ReactNode {
  if (!Array.isArray(content)) return null;
  return content.map((n: any, i: number) => {
    if (n?.type !== 'text') return null;
    let el: ReactNode = n.text ?? '';
    const marks: string[] = Array.isArray(n.marks) ? n.marks.map((m: any) => m?.type) : [];
    if (marks.includes('code')) el = <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{el}</code>;
    if (marks.includes('bold')) el = <strong>{el}</strong>;
    if (marks.includes('italic')) el = <em>{el}</em>;
    return <span key={keyPrefix + i}>{el}</span>;
  });
}

function RenderNode({ node, k }: { node: any; k: string }): ReactNode {
  if (!node) return null;
  switch (node.type) {
    case 'heading': {
      const level = Number(node.attrs?.level ?? 2);
      const cls = level <= 1 ? 'text-2xl font-semibold' : level === 2 ? 'text-xl font-semibold' : 'text-lg font-medium';
      return <p className={cn('mt-4 mb-1', cls)}>{renderInline(node.content, k)}</p>;
    }
    case 'paragraph':
      return <p className="my-2 leading-relaxed">{renderInline(node.content, k)}</p>;
    case 'bulletList':
      return (
        <ul className="my-2 list-disc pl-6">
          {(node.content ?? []).map((li: any, i: number) => (
            <li key={k + i}>{(li.content ?? []).map((c: any, j: number) => <RenderNode key={k + i + '-' + j} node={c} k={k + i + '-' + j} />)}</li>
          ))}
        </ul>
      );
    case 'orderedList':
      return (
        <ol className="my-2 list-decimal pl-6">
          {(node.content ?? []).map((li: any, i: number) => (
            <li key={k + i}>{(li.content ?? []).map((c: any, j: number) => <RenderNode key={k + i + '-' + j} node={c} k={k + i + '-' + j} />)}</li>
          ))}
        </ol>
      );
    case 'codeBlock':
      return <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs"><code>{docToText({ content: [node] })}</code></pre>;
    default:
      if (Array.isArray(node.content)) return <>{node.content.map((c: any, i: number) => <RenderNode key={k + i} node={c} k={k + i} />)}</>;
      return null;
  }
}

function RenderDoc({ doc }: { doc: unknown }): ReactNode {
  const d = doc as any;
  if (!d || !Array.isArray(d.content) || d.content.length === 0) {
    return <p className="text-sm text-muted-foreground">This page is empty.</p>;
  }
  return <div className="text-sm">{d.content.map((n: any, i: number) => <RenderNode key={String(i)} node={n} k={String(i)} />)}</div>;
}

function PageTree({ nodes, spaceId, activeId, depth }: { nodes: PageNode[]; spaceId: string; activeId?: string; depth: number }) {
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
              <span className="truncate">{n.title || 'Untitled'}</span>
            </span>
          </Link>
          {n.children.length > 0 && <PageTree nodes={n.children} spaceId={spaceId} activeId={activeId} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}

export function KbPage({ spaceId, pageId }: { spaceId?: string; pageId?: string }) {
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
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Spaces</span>
          {canManageSpaces && (
            <button className="rounded p-1 hover:bg-muted" onClick={() => setAddingSpace((v) => !v)} title="New space">
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
            <Input autoFocus value={newSpace} onChange={(e) => setNewSpace(e.target.value)} placeholder="Space name" className="h-7 text-xs" />
            <Button size="sm" type="submit" disabled={createSpace.isPending}>Add</Button>
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
          {spaces.data && spaces.data.data.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No spaces yet.</p>}
        </div>

        {spaceId && (
          <div className="mt-2 flex-1 overflow-auto border-t border-border pt-2">
            <div className="flex items-center justify-between px-3 pb-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pages</span>
              {canWrite && (
                <button className="rounded p-1 hover:bg-muted" onClick={() => setAddingPage((v) => !v)} title="New page">
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
                <Input autoFocus value={newPage} onChange={(e) => setNewPage(e.target.value)} placeholder="Page title" className="h-7 text-xs" />
                <Button size="sm" type="submit" disabled={createPage.isPending}>Add</Button>
              </form>
            )}
            <div className="px-2">
              {pages.isLoading && <Skeleton className="mx-1 h-6" />}
              {pages.data && tree.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No pages.</p>}
              <PageTree nodes={tree} spaceId={spaceId} activeId={pageId} depth={0} />
            </div>
          </div>
        )}
      </aside>

      {/* Right: page detail */}
      <div className="flex-1 overflow-auto">
        {!spaceId && (
          <EmptyState title="Knowledge base" hint="Pick a space on the left to browse its pages, or create a new space to start documenting." />
        )}
        {spaceId && !pageId && (
          <EmptyState title="Select a page" hint="Choose a page from the tree, or create a new one to capture briefs, processes and specs." />
        )}
        {spaceId && pageId && <PageDetailView pageId={pageId} canWrite={canWrite} />}
      </div>
    </div>
  );
}

function PageDetailView({ pageId, canWrite }: { pageId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [showVersions, setShowVersions] = useState(false);

  const page = useQuery({ queryKey: ['page', pageId], queryFn: () => api.get<PageDetail>(`/pages/${pageId}`) });

  useEffect(() => {
    setEditing(false);
    setShowVersions(false);
  }, [pageId]);

  useEffect(() => {
    if (page.data) {
      setTitle(page.data.title ?? '');
      setBody(docToText(page.data.body));
    }
  }, [page.data]);

  const save = useMutation({
    mutationFn: () => api.patch(`/pages/${pageId}`, { title, body: textToDoc(body) }),
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
  if (page.isError || !page.data) return <div className="p-8 text-sm text-muted-foreground">Page not found.</div>;

  return (
    <div>
      <PageHeader
        title={editing ? 'Editing page' : page.data.title || 'Untitled'}
        subtitle={page.data.updatedAt ? `Updated ${fmtDate(page.data.updatedAt)}` : undefined}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setShowVersions((v) => !v)}>
              <History size={14} /> History
            </Button>
            {canWrite && !editing && (
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit
              </Button>
            )}
            {editing && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
                <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
              </>
            )}
          </>
        }
      />
      <div className="flex">
        <div className="mx-auto max-w-3xl flex-1 p-8">
          {save.isError && <p className="mb-3 text-sm text-destructive">Failed to save. Try again.</p>}
          {editing ? (
            <div className="space-y-3">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="text-lg font-semibold" />
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={18} placeholder="Write the page body… (blank line = new paragraph)" className="font-mono text-xs" />
            </div>
          ) : (
            <RenderDoc doc={page.data.body} />
          )}
        </div>
        {showVersions && <VersionsPanel pageId={pageId} />}
      </div>
    </div>
  );
}

function VersionsPanel({ pageId }: { pageId: string }) {
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
      <div className="border-b border-border px-3 py-2 text-sm font-medium">Version history</div>
      <div className="max-h-[70vh] overflow-auto p-2">
        {versions.isLoading && <Skeleton className="h-6" />}
        {versions.data && versions.data.data.length === 0 && <p className="p-2 text-xs text-muted-foreground">No versions yet.</p>}
        {versions.data?.data.map((v) => (
          <div key={String(v.versionNo)} className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted/60">
            <div>
              <div className="font-medium">v{v.versionNo}</div>
              <div className="text-xs text-muted-foreground">{fmtDate(v.createdAt)}</div>
            </div>
            <button className="rounded p-1 text-muted-foreground hover:bg-muted" title="Restore" onClick={() => restore.mutate(v.versionNo)} disabled={restore.isPending}>
              <RotateCcw size={14} />
            </button>
          </div>
        ))}
      </div>
    </Card>
  );
}
