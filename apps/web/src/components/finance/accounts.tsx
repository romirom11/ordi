/**
 * Settings → Finance: chart of accounts (grouped by type, archive toggle,
 * system rows locked against delete) + expense-category → account mapping.
 *
 * Contracts (verified):
 *   GET/POST /ledger/accounts, PATCH/DELETE /ledger/accounts/:id
 *   GET/POST /expense-categories, PATCH/DELETE /expense-categories/:id
 */
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Landmark, Lock, MoreHorizontal, Plus, Tags, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT, extendDict } from '../../lib/i18n';
import { Badge, Button, Input, Select, Skeleton, Spinner, Switch, cn } from '../ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { useLedgerAccounts, type LedgerAccount } from './ledger';

extendDict({
  en: {
    'coa.title': 'Chart of accounts',
    'coa.desc': 'Where the ledger files every money event. System accounts are managed for you.',
    'coa.addAccount': 'Add account',
    'coa.name': 'Name',
    'coa.code': 'Code',
    'coa.parent': 'Parent account',
    'coa.noParent': 'None',
    'coa.type.asset': 'Assets',
    'coa.type.liability': 'Liabilities',
    'coa.type.equity': 'Equity',
    'coa.type.revenue': 'Revenue',
    'coa.type.expense': 'Expenses',
    'coa.typeLabel': 'Type',
    'coa.system': 'System',
    'coa.archived': 'Archived',
    'coa.created': 'Account created',
    'coa.deleted': 'Account deleted',
    'coa.deleteTitle': 'Delete account',
    'coa.deleteBody': 'Delete “{name}”? Only accounts without ledger entries can be deleted.',
    'coa.categories': 'Expense categories',
    'coa.categoriesDesc': 'Each category posts to a ledger account. Unmapped categories use “Other expenses”.',
    'coa.addCategory': 'Add category',
    'coa.defaultAccount': 'Other expenses (default)',
    'coa.categoryCreated': 'Category created',
    'coa.categoryDeleted': 'Category deleted',
    'coa.deleteCategoryTitle': 'Delete category',
    'coa.deleteCategoryBody': 'Delete “{name}”? Existing expenses keep their history.',
    'coa.noCategories': 'No categories yet',
  },
  uk: {
    'coa.title': 'План рахунків',
    'coa.desc': 'Куди леджер записує кожну грошову подію. Системні рахунки керуються автоматично.',
    'coa.addAccount': 'Додати рахунок',
    'coa.name': 'Назва',
    'coa.code': 'Код',
    'coa.parent': 'Батьківський рахунок',
    'coa.noParent': 'Немає',
    'coa.type.asset': 'Активи',
    'coa.type.liability': 'Зобовʼязання',
    'coa.type.equity': 'Капітал',
    'coa.type.revenue': 'Доходи',
    'coa.type.expense': 'Витрати',
    'coa.typeLabel': 'Тип',
    'coa.system': 'Системний',
    'coa.archived': 'Архівовано',
    'coa.created': 'Рахунок створено',
    'coa.deleted': 'Рахунок видалено',
    'coa.deleteTitle': 'Видалити рахунок',
    'coa.deleteBody': 'Видалити «{name}»? Видаляти можна лише рахунки без проведень.',
    'coa.categories': 'Категорії витрат',
    'coa.categoriesDesc': 'Кожна категорія проводиться на рахунок леджера. Без мапінгу — «Інші витрати».',
    'coa.addCategory': 'Додати категорію',
    'coa.defaultAccount': 'Інші витрати (за замовчуванням)',
    'coa.categoryCreated': 'Категорію створено',
    'coa.categoryDeleted': 'Категорію видалено',
    'coa.deleteCategoryTitle': 'Видалити категорію',
    'coa.deleteCategoryBody': 'Видалити «{name}»? Наявні витрати збережуть свою історію.',
    'coa.noCategories': 'Ще немає категорій',
  },
});

const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

/* ────────────────────────────── Chart of accounts ────────────────────────────── */

export function ChartOfAccountsBlock() {
  const t = useT();
  const qc = useQueryClient();
  const accountsQ = useLedgerAccounts();
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<LedgerAccount | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ledger-accounts'] });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/ledger/accounts/${id}`, body),
    onSuccess: invalidate,
    onError: (e) => { invalidate(); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/ledger/accounts/${id}`),
    onSuccess: () => { setToDelete(null); invalidate(); toast(t('coa.deleted')); },
    onError: (e) => { setToDelete(null); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });

  const accounts = accountsQ.data ?? [];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
          <Landmark size={13} /> {t('coa.title')}
        </div>
        <Button size="xs" variant="outline" onClick={() => setAddOpen(true)}><Plus size={13} /> {t('coa.addAccount')}</Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('coa.desc')}</p>

      {accountsQ.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="space-y-4">
          {TYPES.map((type) => {
            const group = accounts.filter((a) => a.type === type);
            if (!group.length) return null;
            return (
              <div key={type}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">{t(`coa.type.${type}`)}</div>
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  {group.map((a, i) => (
                    <div
                      key={a.id}
                      className={cn(
                        'flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors duration-150 hover:bg-muted/40',
                        i > 0 && 'border-t border-border',
                        a.archived && 'opacity-55',
                      )}
                      style={{ paddingLeft: `${12 + (a.depth ?? 0) * 16}px` }}
                    >
                      <span className="w-10 shrink-0 font-mono text-[11px] text-faint tabular-nums">{a.code ?? ''}</span>
                      <span className={cn('min-w-0 flex-1 truncate', a.archived && 'line-through decoration-faint')}>{a.name}</span>
                      {a.isSystem && <Badge className="gap-1 bg-muted text-muted-foreground"><Lock size={10} /> {t('coa.system')}</Badge>}
                      {(a.postingCount ?? 0) > 0 && (
                        <span className="text-[11px] tabular-nums text-faint">{a.postingCount}</span>
                      )}
                      <Switch
                        checked={!a.archived}
                        disabled={a.isSystem || patch.isPending}
                        onChange={() => patch.mutate({ id: a.id, body: { archived: !a.archived } })}
                      />
                      <DropdownMenu
                        align="end"
                        trigger={
                          <button className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                            <MoreHorizontal size={14} />
                          </button>
                        }
                      >
                        <MenuItem
                          icon={a.isSystem ? <Lock size={14} /> : <Trash2 size={14} />}
                          danger
                          disabled={a.isSystem || (a.postingCount ?? 0) > 0}
                          onSelect={() => setToDelete(a)}
                        >
                          {t('common.delete')}
                        </MenuItem>
                      </DropdownMenu>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {addOpen && <AddAccountDialog accounts={accounts} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); invalidate(); }} />}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('coa.deleteTitle')}
        body={toDelete ? t('coa.deleteBody').replace('{name}', toDelete.name) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

function AddAccountDialog({ accounts, onClose, onSaved }: { accounts: LedgerAccount[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('expense');
  const [code, setCode] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/ledger/accounts', {
      name: name.trim(), type, code: code.trim() || undefined, parentId: parentId || undefined,
    }),
    onSuccess: () => { toast(t('coa.created')); onSaved(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });

  const parents = accounts.filter((a) => a.type === type && !a.archived);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim()) create.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={t('coa.addAccount')} width={400}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('coa.name')}</label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('coa.typeLabel')}</label>
            <Select value={type} onChange={(e) => { setType(e.target.value as typeof type); setParentId(''); }} className="w-full">
              {TYPES.map((ty) => <option key={ty} value={ty}>{t(`coa.type.${ty}`)}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('coa.code')}</label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="5300" />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('coa.parent')}</label>
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)} className="w-full">
            <option value="">{t('coa.noParent')}</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ` : ''}{p.name}</option>)}
          </Select>
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
            {create.isPending ? <Spinner /> : <Plus size={14} />} {t('common.add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ────────────────────────────── Expense categories ────────────────────────────── */

interface ExpenseCategory { id: string; name: string; accountId?: string | null }

export function ExpenseCategoriesBlock() {
  const t = useT();
  const qc = useQueryClient();
  const accountsQ = useLedgerAccounts();
  const catsQ = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => api.get<{ data: ExpenseCategory[] }>('/expense-categories'),
  });
  const [newName, setNewName] = useState('');
  const [toDelete, setToDelete] = useState<ExpenseCategory | null>(null);

  const expenseAccounts = (accountsQ.data ?? []).filter((a) => a.type === 'expense' && !a.archived);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['expense-categories'] });

  const create = useMutation({
    mutationFn: () => api.post('/expense-categories', { name: newName.trim() }),
    onSuccess: () => { setNewName(''); invalidate(); toast(t('coa.categoryCreated')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });
  const setAccount = useMutation({
    mutationFn: ({ id, accountId }: { id: string; accountId: string | null }) =>
      api.patch(`/expense-categories/${id}`, { accountId }),
    onSuccess: () => { invalidate(); toast(t('common.saved')); },
    onError: (e) => { invalidate(); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/expense-categories/${id}`),
    onSuccess: () => { setToDelete(null); invalidate(); toast(t('coa.categoryDeleted')); },
    onError: (e) => { setToDelete(null); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });

  const cats = catsQ.data?.data ?? [];

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
        <Tags size={13} /> {t('coa.categories')}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('coa.categoriesDesc')}</p>

      <form
        className="mb-3 flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (newName.trim()) create.mutate(); }}
      >
        <div className="w-56"><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('finance.category')} /></div>
        <Button type="submit" size="sm" variant="outline" disabled={!newName.trim() || create.isPending}>
          <Plus size={13} /> {t('coa.addCategory')}
        </Button>
      </form>

      {catsQ.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : cats.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t('coa.noCategories')}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {cats.map((c, i) => (
            <div key={c.id} className={cn('flex items-center gap-3 px-3 py-2 text-[13px]', i > 0 && 'border-t border-border')}>
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              <Select
                value={c.accountId ?? ''}
                onChange={(e) => setAccount.mutate({ id: c.id, accountId: e.target.value || null })}
                className="h-7 w-56 text-xs"
              >
                <option value="">{t('coa.defaultAccount')}</option>
                {expenseAccounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} · ` : ''}{a.name}</option>)}
              </Select>
              <button
                className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                onClick={() => setToDelete(c)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('coa.deleteCategoryTitle')}
        body={toDelete ? t('coa.deleteCategoryBody').replace('{name}', toDelete.name) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}
