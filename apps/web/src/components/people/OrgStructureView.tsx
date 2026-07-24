import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button, Input, Skeleton, Spinner, Tooltip, cn } from '../ui';
import { ConfirmDialog, toast } from '../overlays';
import { Plus, Pencil, Trash2, Check, X, Network, Briefcase, CornerDownRight } from 'lucide-react';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'people.departments': 'Departments',
    'people.positions': 'Positions',
    'people.addDepartment': 'Add department',
    'people.addPosition': 'Add position',
    'people.addSubdepartment': 'Add sub-department',
    'people.rename': 'Rename',
    'people.deptName': 'Department name…',
    'people.posName': 'Position title…',
    'people.deptCreated': 'Department created',
    'people.posCreated': 'Position created',
    'people.renamed': 'Renamed',
    'people.deptDeleted': 'Department deleted',
    'people.posDeleted': 'Position deleted',
    'people.deleteDeptTitle': 'Delete department?',
    'people.deleteDeptBody': 'The department will be removed. Employees keep their profiles.',
    'people.deletePosTitle': 'Delete position?',
    'people.deletePosBody': 'The position will be removed from the list.',
    'people.deptInUse': 'The department has employees. Reassign them first.',
    'people.posInUse': 'The position is in use. Reassign employees first.',
    'people.orgFailed': 'Could not update the structure',
    'people.noDepartments': 'No departments yet. Create the first one.',
    'people.noPositions': 'No positions yet. Create the first one.',
    'people.peopleCount': 'people',
  },
  uk: {
    'people.departments': 'Відділи',
    'people.positions': 'Посади',
    'people.addDepartment': 'Додати відділ',
    'people.addPosition': 'Додати посаду',
    'people.addSubdepartment': 'Додати підвідділ',
    'people.rename': 'Перейменувати',
    'people.deptName': 'Назва відділу…',
    'people.posName': 'Назва посади…',
    'people.deptCreated': 'Відділ створено',
    'people.posCreated': 'Посаду створено',
    'people.renamed': 'Перейменовано',
    'people.deptDeleted': 'Відділ видалено',
    'people.posDeleted': 'Посаду видалено',
    'people.deleteDeptTitle': 'Видалити відділ?',
    'people.deleteDeptBody': 'Відділ буде видалено. Профілі співробітників залишаться.',
    'people.deletePosTitle': 'Видалити посаду?',
    'people.deletePosBody': 'Посаду буде прибрано зі списку.',
    'people.deptInUse': 'У відділі є співробітники. Спершу переведіть їх.',
    'people.posInUse': 'Посада використовується. Спершу переведіть співробітників.',
    'people.orgFailed': 'Не вдалося оновити структуру',
    'people.noDepartments': 'Відділів ще немає. Створіть перший.',
    'people.noPositions': 'Посад ще немає. Створіть першу.',
    'people.peopleCount': 'осіб',
  },
});

interface Department { id: string; name: string; parentId?: string | null }
interface Position { id: string; title: string }
interface EmployeeLite { id: string; departmentId?: string | null; positionId?: string | null }

interface DeptNode extends Department { children: DeptNode[]; depth: number }

function buildTree(rows: Department[]): DeptNode[] {
  const byId = new Map<string, DeptNode>();
  for (const d of rows) byId.set(d.id, { ...d, children: [], depth: 0 });
  const roots: DeptNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent && parent.id !== n.id) parent.children.push(n);
    else roots.push(n);
  }
  const out: DeptNode[] = [];
  const walk = (nodes: DeptNode[], depth: number) => {
    for (const n of nodes.sort((a, b) => a.name.localeCompare(b.name))) {
      n.depth = depth;
      out.push(n);
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** Inline name editor: Enter saves, Escape cancels. */
function InlineEdit({ initial, placeholder, pending, onSave, onCancel, autoFocus = true }: {
  initial: string; placeholder: string; pending: boolean;
  onSave: (value: string) => void; onCancel: () => void; autoFocus?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => { const v = value.trim(); if (v) onSave(v); else onCancel(); };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Input
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        className="h-7 flex-1 text-[13px]"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
      <button
        type="button"
        className="shrink-0 rounded-md p-1.5 text-success transition-colors duration-150 hover:bg-success/10 disabled:opacity-50"
        onClick={commit}
        disabled={pending || !value.trim()}
      >{pending ? <Spinner /> : <Check size={14} />}</button>
      <button
        type="button"
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted"
        onClick={onCancel}
      ><X size={14} /></button>
    </div>
  );
}

function RowAction({ label, danger, onClick, children }: {
  label: string; danger?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'rounded-md p-1.5 opacity-0 transition-all duration-150 group-hover:opacity-100 focus-visible:opacity-100',
          danger ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >{children}</button>
    </Tooltip>
  );
}

type PendingDelete = { kind: 'dept' | 'pos'; id: string; name: string } | null;

export function OrgStructureView() {
  const t = useT();
  const qc = useQueryClient();

  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.get<{ data: Department[] }>('/departments') });
  const positions = useQuery({ queryKey: ['positions'], queryFn: () => api.get<{ data: Position[] }>('/positions') });
  const employees = useQuery({ queryKey: ['employees'], queryFn: () => api.get<{ data: EmployeeLite[] }>('/employees') });

  const tree = useMemo(() => buildTree(departments.data?.data ?? []), [departments.data]);
  const posRows = positions.data?.data ?? [];

  const counts = useMemo(() => {
    const dept = new Map<string, number>();
    const pos = new Map<string, number>();
    for (const e of employees.data?.data ?? []) {
      if (e.departmentId) dept.set(e.departmentId, (dept.get(e.departmentId) ?? 0) + 1);
      if (e.positionId) pos.set(e.positionId, (pos.get(e.positionId) ?? 0) + 1);
    }
    return { dept, pos };
  }, [employees.data]);

  // UI state: at most one inline editor open at a time.
  const [addingDeptUnder, setAddingDeptUnder] = useState<string | 'root' | null>(null);
  const [addingPos, setAddingPos] = useState(false);
  const [editing, setEditing] = useState<{ kind: 'dept' | 'pos'; id: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['departments'] });
    qc.invalidateQueries({ queryKey: ['positions'] });
    qc.invalidateQueries({ queryKey: ['peopleDirectory'] });
    qc.invalidateQueries({ queryKey: ['employees'] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('people.orgFailed'));

  const createDept = useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId: string | null }) =>
      api.post('/departments', { name, parentId }),
    onSuccess: () => { invalidate(); setAddingDeptUnder(null); toast(t('people.deptCreated')); },
    onError: fail,
  });
  const renameDept = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch(`/departments/${id}`, { name }),
    onSuccess: () => { invalidate(); setEditing(null); toast(t('people.renamed')); },
    onError: fail,
  });
  const deleteDept = useMutation({
    mutationFn: (id: string) => api.del(`/departments/${id}`),
    onSuccess: () => { invalidate(); setPendingDelete(null); toast(t('people.deptDeleted')); },
    onError: (e) => {
      setPendingDelete(null);
      toast.error(e instanceof ApiError && e.code === 'domain_rule' ? t('people.deptInUse') : t('people.orgFailed'));
    },
  });

  const createPos = useMutation({
    mutationFn: (title: string) => api.post('/positions', { title }),
    onSuccess: () => { invalidate(); setAddingPos(false); toast(t('people.posCreated')); },
    onError: fail,
  });
  const renamePos = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.patch(`/positions/${id}`, { title }),
    onSuccess: () => { invalidate(); setEditing(null); toast(t('people.renamed')); },
    onError: fail,
  });
  const deletePos = useMutation({
    mutationFn: (id: string) => api.del(`/positions/${id}`),
    onSuccess: () => { invalidate(); setPendingDelete(null); toast(t('people.posDeleted')); },
    onError: (e) => {
      setPendingDelete(null);
      toast.error(e instanceof ApiError && e.code === 'domain_rule' ? t('people.posInUse') : t('people.orgFailed'));
    },
  });

  const countBadge = (n: number) => (
    <Tooltip label={`${n} ${t('people.peopleCount')}`}>
      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{n}</span>
    </Tooltip>
  );

  const addRow = (depth: number, parentId: string | null, kind: 'dept' | 'pos') => (
    <div className="flex items-center gap-2 border-t border-border px-3 py-1.5" style={{ paddingLeft: 12 + depth * 18 }}>
      {kind === 'dept' ? (
        <InlineEdit
          initial=""
          placeholder={t('people.deptName')}
          pending={createDept.isPending}
          onSave={(name) => createDept.mutate({ name, parentId })}
          onCancel={() => setAddingDeptUnder(null)}
        />
      ) : (
        <InlineEdit
          initial=""
          placeholder={t('people.posName')}
          pending={createPos.isPending}
          onSave={(title) => createPos.mutate(title)}
          onCancel={() => setAddingPos(false)}
        />
      )}
    </div>
  );

  const loadingSkeleton = (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={cn('flex items-center gap-3 px-3 py-2', i > 0 && 'border-t border-border')}>
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-4 w-40" />
        </div>
      ))}
    </div>
  );

  return (
    <div className="grid gap-6 p-6 lg:grid-cols-2">
      {/* Departments */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
            <Network size={12} />{t('people.departments')}
            <span className="tabular-nums normal-case text-faint">{tree.length}</span>
          </h2>
          <Button size="xs" variant="outline" onClick={() => { setEditing(null); setAddingDeptUnder('root'); }}>
            <Plus size={13} /> {t('people.addDepartment')}
          </Button>
        </div>
        {departments.isLoading ? loadingSkeleton : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {tree.length === 0 && addingDeptUnder === null && (
              <div className="px-4 py-6 text-center text-xs text-faint">{t('people.noDepartments')}</div>
            )}
            {tree.map((d, i) => (
              <div key={d.id}>
                <div
                  style={{ paddingLeft: 12 + d.depth * 18, ['--i' as string]: Math.min(i, 10) } as CSSProperties}
                  className={cn(
                    'row-enter group flex items-center gap-2 py-1.5 pr-2 text-[13px] transition-colors duration-150 hover:bg-muted/60',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  {d.depth > 0
                    ? <CornerDownRight size={13} className="shrink-0 text-faint" />
                    : <Network size={13} className="shrink-0 text-faint" />}
                  {editing?.kind === 'dept' && editing.id === d.id ? (
                    <InlineEdit
                      initial={d.name}
                      placeholder={t('people.deptName')}
                      pending={renameDept.isPending}
                      onSave={(name) => renameDept.mutate({ id: d.id, name })}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{d.name}</span>
                      {countBadge(counts.dept.get(d.id) ?? 0)}
                      <span className="flex shrink-0 items-center">
                        <RowAction label={t('people.addSubdepartment')} onClick={() => { setEditing(null); setAddingDeptUnder(d.id); }}>
                          <Plus size={13} />
                        </RowAction>
                        <RowAction label={t('people.rename')} onClick={() => { setAddingDeptUnder(null); setEditing({ kind: 'dept', id: d.id }); }}>
                          <Pencil size={13} />
                        </RowAction>
                        <RowAction label={t('common.delete')} danger onClick={() => setPendingDelete({ kind: 'dept', id: d.id, name: d.name })}>
                          <Trash2 size={13} />
                        </RowAction>
                      </span>
                    </>
                  )}
                </div>
                {addingDeptUnder === d.id && addRow(d.depth + 1, d.id, 'dept')}
              </div>
            ))}
            {addingDeptUnder === 'root' && addRow(0, null, 'dept')}
          </div>
        )}
      </section>

      {/* Positions */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
            <Briefcase size={12} />{t('people.positions')}
            <span className="tabular-nums normal-case text-faint">{posRows.length}</span>
          </h2>
          <Button size="xs" variant="outline" onClick={() => { setEditing(null); setAddingPos(true); }}>
            <Plus size={13} /> {t('people.addPosition')}
          </Button>
        </div>
        {positions.isLoading ? loadingSkeleton : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {posRows.length === 0 && !addingPos && (
              <div className="px-4 py-6 text-center text-xs text-faint">{t('people.noPositions')}</div>
            )}
            {posRows.map((p, i) => (
              <div
                key={p.id}
                style={{ ['--i' as string]: Math.min(i, 10) } as CSSProperties}
                className={cn(
                  'row-enter group flex items-center gap-2 py-1.5 pl-3 pr-2 text-[13px] transition-colors duration-150 hover:bg-muted/60',
                  i > 0 && 'border-t border-border',
                )}
              >
                <Briefcase size={13} className="shrink-0 text-faint" />
                {editing?.kind === 'pos' && editing.id === p.id ? (
                  <InlineEdit
                    initial={p.title}
                    placeholder={t('people.posName')}
                    pending={renamePos.isPending}
                    onSave={(title) => renamePos.mutate({ id: p.id, title })}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{p.title}</span>
                    {countBadge(counts.pos.get(p.id) ?? 0)}
                    <span className="flex shrink-0 items-center">
                      <RowAction label={t('people.rename')} onClick={() => { setAddingPos(false); setEditing({ kind: 'pos', id: p.id }); }}>
                        <Pencil size={13} />
                      </RowAction>
                      <RowAction label={t('common.delete')} danger onClick={() => setPendingDelete({ kind: 'pos', id: p.id, name: p.title })}>
                        <Trash2 size={13} />
                      </RowAction>
                    </span>
                  </>
                )}
              </div>
            ))}
            {addingPos && addRow(0, null, 'pos')}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === 'dept') deleteDept.mutate(pendingDelete.id);
          else deletePos.mutate(pendingDelete.id);
        }}
        title={pendingDelete?.kind === 'dept' ? t('people.deleteDeptTitle') : t('people.deletePosTitle')}
        body={
          <>
            <span className="font-medium text-foreground">{pendingDelete?.name}</span>
            {' – '}
            {pendingDelete?.kind === 'dept' ? t('people.deleteDeptBody') : t('people.deletePosBody')}
          </>
        }
        confirmLabel={t('common.delete')}
        danger
        pending={deleteDept.isPending || deletePos.isPending}
      />
    </div>
  );
}
