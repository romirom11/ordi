/**
 * Finance → Transactions: the quiet read-only journal over the double-entry
 * ledger core, plus the "Add income" document dialog (the SaaS-revenue case).
 *
 * Contracts (verified):
 *   GET  /ledger/accounts                                → { data: Account[] }
 *   GET  /ledger/transactions?accountId=&from=&to=&sourceType=&limit=
 *   POST /income { date, amount, currency, accountId?, projectId?, description }
 *   POST /ledger/transactions/:id/void
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight, BookOpen, ChevronRight, MoreHorizontal, Plus, Sprout, Undo2,
} from 'lucide-react';
import { api, qs, ApiError } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useT, extendDict } from '../../lib/i18n';
import { usePersistedState, stringPref } from '../../lib/prefs';
import {
  Badge, Button, Card, EmptyState, Input, Select, Skeleton, Spinner, cn, fmtMoney, fmtDate,
} from '../ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { DateField } from '../DatePicker';

extendDict({
  en: {
    'ledger.transactions': 'Transactions',
    'ledger.addIncome': 'Add income',
    'ledger.incomeRecorded': 'Income recorded',
    'ledger.incomePeriod': 'Income recorded',
    'ledger.incomeEntries': '{n} entries',
    'ledger.account': 'Account',
    'ledger.allAccounts': 'All accounts',
    'ledger.revenueAccount': 'Revenue account',
    'ledger.emptyJournal': 'No transactions yet',
    'ledger.emptyJournalHint': 'Send an invoice, record a payment or add income – every money event lands here automatically.',
    'ledger.postings': 'postings',
    'ledger.void': 'Void',
    'ledger.voided': 'Entry voided',
    'ledger.voidTitle': 'Void this entry?',
    'ledger.voidBody': 'A mirrored reversal will be added and this entry will be marked void. Nothing is deleted.',
    'ledger.status.void': 'Void',
    'ledger.source.invoice': 'Invoice',
    'ledger.source.payment': 'Payment',
    'ledger.source.expense': 'Expense',
    'ledger.source.income': 'Income',
    'ledger.source.manual': 'Manual',
    'ledger.source.reversal': 'Reversal',
    'ledger.noProject': 'No project',
    'ledger.debitShort': 'Dr',
    'ledger.creditShort': 'Cr',
    'ledger.descPlaceholder': 'Stripe payout, app subscriptions…',
  },
  uk: {
    'ledger.transactions': 'Транзакції',
    'ledger.addIncome': 'Додати дохід',
    'ledger.incomeRecorded': 'Дохід зафіксовано',
    'ledger.incomePeriod': 'Зафіксований дохід',
    'ledger.incomeEntries': 'записів: {n}',
    'ledger.account': 'Рахунок',
    'ledger.allAccounts': 'Усі рахунки',
    'ledger.revenueAccount': 'Рахунок доходу',
    'ledger.emptyJournal': 'Ще немає транзакцій',
    'ledger.emptyJournalHint': 'Надішліть рахунок, зафіксуйте платіж або додайте дохід – кожна грошова подія зʼявиться тут автоматично.',
    'ledger.postings': 'проведень',
    'ledger.void': 'Анулювати',
    'ledger.voided': 'Запис анульовано',
    'ledger.voidTitle': 'Анулювати цей запис?',
    'ledger.voidBody': 'Буде додано дзеркальне сторно, а запис позначено як анульований. Нічого не видаляється.',
    'ledger.status.void': 'Анульовано',
    'ledger.source.invoice': 'Рахунок',
    'ledger.source.payment': 'Платіж',
    'ledger.source.expense': 'Витрата',
    'ledger.source.income': 'Дохід',
    'ledger.source.manual': 'Вручну',
    'ledger.source.reversal': 'Сторно',
    'ledger.noProject': 'Без проєкту',
    'ledger.debitShort': 'Дт',
    'ledger.creditShort': 'Кт',
    'ledger.descPlaceholder': 'Виплата Stripe, підписки на застосунок…',
  },
});

const CURRENCIES = ['USD', 'EUR', 'GBP', 'UAH', 'PLN'];

export interface LedgerAccount {
  id: string; code?: string | null; name: string; type: string;
  parentId?: string | null; isSystem: boolean; archived: boolean; depth?: number; postingCount?: number;
}
interface Posting {
  id: string; accountId: string; accountName: string; accountType: string;
  direction: 'debit' | 'credit'; amount: string; currency: string;
}
interface LedgerTx {
  id: string; date: string; description: string; status: string;
  sourceType?: string | null; sourceId?: string | null; projectId?: string | null; companyId?: string | null;
  postings: Posting[];
}
interface ProjectLite { id: string; name: string }

export function useLedgerAccounts() {
  return useQuery({
    queryKey: ['ledger-accounts'],
    queryFn: () => api.get<{ data: LedgerAccount[] }>('/ledger/accounts').then((r) => r.data),
    staleTime: 60_000,
  });
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Signed display amount for a transaction's "primary" posting:
 * revenue credit → +, expense debit → −, otherwise the cash (first debit) leg.
 */
function txAmount(tx: LedgerTx): { value: number; currency: string } {
  const ps = tx.postings;
  const rev = ps.find((p) => p.accountType === 'revenue');
  if (rev) return { value: (rev.direction === 'credit' ? 1 : -1) * Number(rev.amount), currency: rev.currency };
  const exp = ps.find((p) => p.accountType === 'expense');
  if (exp) return { value: (exp.direction === 'debit' ? -1 : 1) * Number(exp.amount), currency: exp.currency };
  const bank = ps.find((p) => p.accountName === 'Bank' || p.accountName === 'Main bank');
  if (bank) return { value: (bank.direction === 'debit' ? 1 : -1) * Number(bank.amount), currency: bank.currency };
  const debit = ps.find((p) => p.direction === 'debit');
  return { value: Number(debit?.amount ?? 0), currency: debit?.currency ?? 'USD' };
}

const SOURCE_TONE: Record<string, string> = {
  invoice: 'bg-primary/12 text-primary',
  payment: 'bg-success/15 text-success',
  income: 'bg-success/15 text-success',
  expense: 'bg-warning/15 text-warning',
  manual: 'bg-muted text-muted-foreground',
  reversal: 'bg-muted text-faint',
};

function SourceBadge({ sourceType }: { sourceType?: string | null }) {
  const t = useT();
  const key = sourceType ?? 'manual';
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium', SOURCE_TONE[key] ?? SOURCE_TONE.manual)}>
      {t(`ledger.source.${key}`, key)}
    </span>
  );
}

/* ────────────────────────────── Transactions tab ────────────────────────────── */

export function TransactionsTab() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const [accountId, setAccountId] = usePersistedState('ordi:view:finance.ledger.account', '', stringPref());
  const [from, setFrom] = usePersistedState('ordi:view:finance.ledger.from', '', stringPref());
  const [to, setTo] = usePersistedState('ordi:view:finance.ledger.to', '', stringPref());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toVoid, setToVoid] = useState<LedgerTx | null>(null);
  const [incomeOpen, setIncomeOpen] = useState(false);

  const accountsQ = useLedgerAccounts();
  const txQ = useQuery({
    queryKey: ['ledger-transactions', accountId, from, to],
    queryFn: () => api.get<{ data: LedgerTx[] }>('/ledger/transactions' + qs({ accountId, from, to, limit: 100 })),
  });
  const incomeQ = useQuery({
    queryKey: ['ledger-transactions', 'income', from, to],
    queryFn: () => api.get<{ data: LedgerTx[] }>('/ledger/transactions' + qs({ sourceType: 'income', from, to, limit: 200 })),
  });
  const projectsQ = useQuery({
    queryKey: ['projects', 'ledger'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects'),
    staleTime: 5 * 60_000,
  });
  const projectName = useMemo(() => {
    const map = new Map((projectsQ.data?.data ?? []).map((p) => [p.id, p.name]));
    return (id?: string | null) => (id ? map.get(id) ?? null : null);
  }, [projectsQ.data]);

  const voidTx = useMutation({
    mutationFn: (id: string) => api.post(`/ledger/transactions/${id}/void`),
    onSuccess: () => {
      setToVoid(null);
      qc.invalidateQueries({ queryKey: ['ledger-transactions'] });
      qc.invalidateQueries({ queryKey: ['profitability'] });
      toast(t('ledger.voided'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const rows = txQ.data?.data ?? [];
  const accounts = accountsQ.data ?? [];

  // Green income stat: net recorded income in the filtered period.
  const incomeRows = (incomeQ.data?.data ?? []).filter((r) => r.status === 'posted');
  const incomeByCur = new Map<string, number>();
  for (const r of incomeRows) {
    const a = txAmount(r);
    incomeByCur.set(a.currency, (incomeByCur.get(a.currency) ?? 0) + a.value);
  }

  const toggle = (id: string) => setExpanded((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="space-y-4 p-6">
      {/* Income stat + filters */}
      <div className="flex flex-wrap items-end gap-3">
        <Card className="flex items-center gap-3 border-success/25 bg-success/[0.06] p-3.5 pr-6">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-success/15 text-success">
            <Sprout size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{t('ledger.incomePeriod')}</div>
            {incomeQ.isLoading ? (
              <Skeleton className="mt-1 h-6 w-24" />
            ) : (
              <div className="flex items-baseline gap-3">
                {incomeByCur.size === 0 ? (
                  <span className="text-xl font-semibold tabular-nums text-muted-foreground">–</span>
                ) : (
                  [...incomeByCur.entries()].map(([cur, v]) => (
                    <span key={cur} className="text-xl font-semibold tabular-nums text-success">{fmtMoney(v, cur)}</span>
                  ))
                )}
                {incomeRows.length > 0 && (
                  <span className="text-[11px] text-faint">{t('ledger.incomeEntries').replace('{n}', String(incomeRows.length))}</span>
                )}
              </div>
            )}
          </div>
        </Card>

        <div className="ml-auto flex items-center gap-2">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="h-8 max-w-52">
            <option value="">{t('ledger.allAccounts')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {' '.repeat((a.depth ?? 0) * 2)}{a.code ? `${a.code} · ` : ''}{a.name}
              </option>
            ))}
          </Select>
          <div className="w-36 shrink-0"><DateField value={from} onChange={(v) => setFrom(v ?? '')} /></div>
          <span className="text-xs text-faint">–</span>
          <div className="w-36 shrink-0"><DateField value={to} onChange={(v) => setTo(v ?? '')} /></div>
        </div>
      </div>

      {/* Journal */}
      {txQ.isLoading ? (
        <div className="overflow-hidden rounded-xl border border-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}>
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-52" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="ml-auto h-4 w-20" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={20} />}
          title={t('ledger.emptyJournal')}
          hint={t('ledger.emptyJournalHint')}
          action={can('finance.write') ? <Button size="sm" variant="outline" onClick={() => setIncomeOpen(true)}><Plus size={13} /> {t('ledger.addIncome')}</Button> : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((tx, i) => {
            const amt = txAmount(tx);
            const open = expanded.has(tx.id);
            const isVoid = tx.status === 'void';
            const proj = projectName(tx.projectId);
            const canVoid = can('finance.settings') && !isVoid && (tx.sourceType === 'manual' || tx.sourceType === 'income');
            return (
              <div key={tx.id} className={cn(i > 0 && 'border-t border-border')}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(tx.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') toggle(tx.id); }}
                  className={cn(
                    'row-enter flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-muted/50',
                    isVoid && 'opacity-55',
                  )}
                  style={{ ['--i' as string]: Math.min(i, 10) }}
                >
                  <ChevronRight
                    size={14}
                    className={cn('shrink-0 text-faint transition-transform duration-150 ease-smooth-out', open && 'rotate-90')}
                  />
                  <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDate(tx.date)}</span>
                  <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', isVoid && 'line-through decoration-faint')}>
                    {tx.description || '–'}
                  </span>
                  {isVoid && <Badge className="bg-muted text-faint">{t('ledger.status.void')}</Badge>}
                  <SourceBadge sourceType={tx.sourceType} />
                  <span className="hidden w-36 shrink-0 truncate text-right text-xs text-muted-foreground md:block">
                    {proj ?? ''}
                  </span>
                  <span className={cn(
                    'w-28 shrink-0 text-right text-[13px] font-semibold tabular-nums',
                    amt.value > 0 && !isVoid ? 'text-success' : 'text-foreground',
                  )}>
                    {amt.value > 0 ? '+' : ''}{fmtMoney(amt.value, amt.currency)}
                  </span>
                  <div className="w-7 shrink-0" onClick={(e) => e.stopPropagation()}>
                    {canVoid && (
                      <DropdownMenu
                        align="end"
                        trigger={
                          <button className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                            <MoreHorizontal size={15} />
                          </button>
                        }
                      >
                        <MenuItem icon={<Undo2 size={14} />} danger onSelect={() => setToVoid(tx)}>{t('ledger.void')}</MenuItem>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
                {open && (
                  <div className="anim-fade-in border-t border-border/60 bg-muted/25 px-3 py-2">
                    {tx.postings.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 py-1 pl-7 text-xs">
                        <span className={cn(
                          'w-6 shrink-0 font-mono text-[10px] font-semibold uppercase',
                          p.direction === 'debit' ? 'text-muted-foreground' : 'text-faint',
                        )}>
                          {p.direction === 'debit' ? t('ledger.debitShort') : t('ledger.creditShort')}
                        </span>
                        <ArrowLeftRight size={11} className="shrink-0 text-faint" />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.accountName}</span>
                        <span className="tabular-nums text-foreground">{fmtMoney(p.amount, p.currency)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!toVoid}
        onClose={() => setToVoid(null)}
        onConfirm={() => toVoid && voidTx.mutate(toVoid.id)}
        title={t('ledger.voidTitle')}
        body={t('ledger.voidBody')}
        confirmLabel={t('ledger.void')}
        danger
        pending={voidTx.isPending}
      />

      {incomeOpen && <AddIncomeDialog onClose={() => setIncomeOpen(false)} />}
    </div>
  );
}

/* ────────────────────────────── Add income dialog ────────────────────────────── */

export function AddIncomeDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const accountsQ = useLedgerAccounts();
  const projectsQ = useQuery({
    queryKey: ['projects', 'ledger'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects'),
    staleTime: 5 * 60_000,
  });
  const revenueAccounts = (accountsQ.data ?? []).filter((a) => a.type === 'revenue' && !a.archived);
  const defaultAccount = revenueAccounts.find((a) => a.code === '4100') ?? revenueAccounts[0];

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.post('/income', {
      date,
      amount: Number(amount),
      currency,
      accountId: accountId || defaultAccount?.id || undefined,
      projectId: projectId || undefined,
      description: description.trim(),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ledger-transactions'] });
      qc.invalidateQueries({ queryKey: ['profitability'] });
      toast(t('ledger.incomeRecorded'));
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!(Number(amount) > 0) || !date) return;
    save.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={t('ledger.addIncome')} width={440}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('public.amount')}</label>
            <Input autoFocus type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('common.currency')}</label>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('common.date')}</label>
            <DateField value={date} onChange={(v) => setDate(v ?? '')} clearable={false} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('ledger.revenueAccount')}</label>
            <Select value={accountId || defaultAccount?.id || ''} onChange={(e) => setAccountId(e.target.value)} className="w-full">
              {revenueAccounts.map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} · ` : ''}{a.name}</option>)}
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('time.groupProject')}</label>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full">
            <option value="">{t('ledger.noProject')}</option>
            {(projectsQ.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('public.description')}</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('ledger.descPlaceholder')} />
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={save.isPending || !(Number(amount) > 0)}>
            {save.isPending ? <Spinner /> : <Plus size={14} />} {t('common.add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
