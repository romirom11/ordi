import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MoreHorizontal, Pencil, Plus, Plug, Send, ShieldCheck, Receipt, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT, extendDict } from '../../lib/i18n';
import { Button, EmptyState, Input, Skeleton, Spinner, Switch } from '../ui';
import { ConfirmDialog, Dialog, DropdownMenu, MenuItem, MenuSeparator, toast } from '../overlays';
import { AnimatedRow, Field, RowList, SectionHead } from './primitives';

extendDict({
  en: {
    'email.title': 'Email',
    'email.desc': 'Addresses ordi sends mail from. Invites, password resets and notifications go out from the system sender; invoices and quotes from the invoice sender, unless you pick another one when sending.',
    'email.add': 'Add sender',
    'email.edit': 'Edit sender',
    'email.none': 'No senders yet',
    'email.noneHint': 'Add the mailbox ordi should send from. Until then nothing is emailed.',
    'email.system': 'System',
    'email.invoices': 'Invoices',
    'email.env': 'Server .env',
    'email.envHint': 'From SMTP_URL on the server; change it there.',
    'email.repliesTo': 'Replies to {to}',
    'email.useSystem': 'Use for system mail',
    'email.useInvoices': 'Use for invoices and quotes',
    'email.check': 'Test connection',
    'email.sendTest': 'Send test email',
    'email.ok': '{name}: connected, mail can go out.',
    'email.failed': '{name}: could not reach the SMTP server ({error}). Many hosting providers block outbound SMTP ports.',
    'email.testSent': 'Test email sent to {to}',
    'email.testFailed': 'Could not send: {error}',
    'email.delete': 'Delete sender',
    'email.deleteBody': 'Delete "{name}"? Mail that used it goes out from the system sender instead.',
    'email.name': 'Name',
    'email.namePlaceholder': 'Finance',
    'email.from': 'From',
    'email.fromHint': 'What recipients see, e.g. kdn.agency <invoices@kdn.agency>',
    'email.replyTo': 'Reply-to (optional)',
    'email.replyToHint': 'Where replies go, if not to the From address.',
    'email.host': 'SMTP host',
    'email.port': 'Port',
    'email.secure': 'Implicit TLS (port 465)',
    'email.user': 'Username',
    'email.pass': 'Password',
    'email.passKeep': 'Leave blank to keep the current password',
    'email.saved': 'Sender saved',
    'email.rolesSaved': 'Saved',
  },
  uk: {
    'email.title': 'Пошта',
    'email.desc': 'Адреси, з яких ordi надсилає листи. Запрошення, скидання пароля й сповіщення йдуть від системного відправника; рахунки й кошториси – від відправника для рахунків, якщо під час надсилання не обрати іншого.',
    'email.add': 'Додати відправника',
    'email.edit': 'Редагувати відправника',
    'email.none': 'Відправників ще немає',
    'email.noneHint': 'Додайте скриньку, з якої ordi надсилатиме листи. Доти нічого не надсилається.',
    'email.system': 'Системний',
    'email.invoices': 'Рахунки',
    'email.env': 'Серверний .env',
    'email.envHint': 'Із SMTP_URL на сервері; змінюється там.',
    'email.repliesTo': 'Відповіді на {to}',
    'email.useSystem': 'Використовувати для системних листів',
    'email.useInvoices': 'Використовувати для рахунків і кошторисів',
    'email.check': 'Перевірити зʼєднання',
    'email.sendTest': 'Надіслати тестовий лист',
    'email.ok': '{name}: підключено, листи можуть іти.',
    'email.failed': '{name}: не вдалося досягти SMTP-сервера ({error}). Багато хостингів блокують вихідні SMTP-порти.',
    'email.testSent': 'Тестовий лист надіслано на {to}',
    'email.testFailed': 'Не вдалося надіслати: {error}',
    'email.delete': 'Видалити відправника',
    'email.deleteBody': 'Видалити «{name}»? Листи, що йшли від нього, підуть від системного відправника.',
    'email.name': 'Назва',
    'email.namePlaceholder': 'Фінанси',
    'email.from': 'Від кого',
    'email.fromHint': 'Що бачить отримувач, напр. kdn.agency <invoices@kdn.agency>',
    'email.replyTo': 'Відповідати на (необовʼязково)',
    'email.replyToHint': 'Куди йдуть відповіді, якщо не на адресу «Від кого».',
    'email.host': 'SMTP-хост',
    'email.port': 'Порт',
    'email.secure': 'Неявний TLS (порт 465)',
    'email.user': 'Логін',
    'email.pass': 'Пароль',
    'email.passKeep': 'Залиште порожнім, щоб не змінювати пароль',
    'email.saved': 'Відправника збережено',
    'email.rolesSaved': 'Збережено',
  },
});

export interface MailSenderView {
  id: string; name: string; from: string; replyTo: string | null; source: 'db' | 'env';
  host: string; port: number; secure: boolean; user: string; hasPassword: boolean;
}
interface SendersResponse { senders: MailSenderView[]; systemSenderId: string | null; invoiceSenderId: string | null }

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

export function EmailPanel() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mail-senders'], queryFn: () => api.get<SendersResponse>('/settings/mail-senders') });
  const [editing, setEditing] = useState<MailSenderView | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<MailSenderView | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['mail-senders'] });

  const roles = useMutation({
    mutationFn: (body: { system?: string; invoices?: string }) => api.put('/settings/mail-senders/roles', body),
    onSuccess: () => { refresh(); toast(t('email.rolesSaved')); },
    onError: (e) => toast.error(errText(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/settings/mail-senders/${id}`),
    onSuccess: () => { setToDelete(null); refresh(); },
    onError: (e) => { setToDelete(null); toast.error(errText(e)); },
  });
  const check = async (s: MailSenderView) => {
    try {
      const r = await api.get<{ ok: boolean; error?: string }>(`/settings/mail-senders/${s.id}/health`);
      if (r.ok) toast(t('email.ok').replace('{name}', s.name));
      else toast.error(t('email.failed').replace('{name}', s.name).replace('{error}', r.error ?? '?'));
    } catch (e) { toast.error(errText(e)); }
  };
  const sendTest = async (s: MailSenderView) => {
    try {
      const r = await api.post<{ sent: boolean; error?: string; to: string }>(`/settings/mail-senders/${s.id}/test`);
      if (r.sent) toast(t('email.testSent').replace('{to}', r.to));
      else toast.error(t('email.testFailed').replace('{error}', r.error ?? '?'));
    } catch (e) { toast.error(errText(e)); }
  };

  const data = q.data;
  return (
    <div>
      <SectionHead
        title={t('email.title')}
        desc={t('email.desc')}
        actions={<Button size="sm" onClick={() => setEditing('new')}><Plus size={14} /> {t('email.add')}</Button>}
      />
      {q.isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : q.isError ? (
        <p className="text-[13px] text-destructive">{errText(q.error)}</p>
      ) : !data || data.senders.length === 0 ? (
        <RowList>
          <EmptyState icon={<Mail size={18} />} title={t('email.none')} hint={t('email.noneHint')}
            action={<Button size="sm" onClick={() => setEditing('new')}><Plus size={14} /> {t('email.add')}</Button>} />
        </RowList>
      ) : (
        <RowList>
          {data.senders.map((s, i) => {
            const isSystem = s.id === data.systemSenderId;
            const isInvoices = s.id === data.invoiceSenderId;
            const env = s.source === 'env';
            return (
              <AnimatedRow key={s.id} index={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-0">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Mail size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold">{s.name}</span>
                    {isSystem && <RoleChip icon={<ShieldCheck size={11} />}>{t('email.system')}</RoleChip>}
                    {isInvoices && <RoleChip icon={<Receipt size={11} />}>{t('email.invoices')}</RoleChip>}
                    {env && <span className="text-[11px] text-faint" title={t('email.envHint')}>· {t('email.env')}</span>}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {s.from}
                    {s.replyTo && <span className="text-faint"> · {t('email.repliesTo').replace('{to}', s.replyTo)}</span>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-faint">{s.host}:{s.port}{s.user ? ` · ${s.user}` : ''}</div>
                </div>
                <DropdownMenu align="end" trigger={<Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label={s.name}><MoreHorizontal size={15} /></Button>}>
                  {!env && <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(s)}>{t('email.edit')}</MenuItem>}
                  <MenuItem icon={<Plug size={14} />} onSelect={() => void check(s)}>{t('email.check')}</MenuItem>
                  <MenuItem icon={<Send size={14} />} onSelect={() => void sendTest(s)}>{t('email.sendTest')}</MenuItem>
                  {(!isSystem || !isInvoices) && <MenuSeparator />}
                  {!isSystem && <MenuItem icon={<ShieldCheck size={14} />} onSelect={() => roles.mutate({ system: s.id })}>{t('email.useSystem')}</MenuItem>}
                  {!isInvoices && <MenuItem icon={<Receipt size={14} />} onSelect={() => roles.mutate({ invoices: s.id })}>{t('email.useInvoices')}</MenuItem>}
                  {!env && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setToDelete(s)}>{t('email.delete')}</MenuItem>
                    </>
                  )}
                </DropdownMenu>
              </AnimatedRow>
            );
          })}
        </RowList>
      )}

      <SenderDialog sender={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('email.delete')}
        body={t('email.deleteBody').replace('{name}', toDelete?.name ?? '')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

function RoleChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-muted px-1.5 py-px text-[10.5px] font-medium text-foreground">
      {icon}{children}
    </span>
  );
}

const EMPTY = { name: '', from: '', replyTo: '', host: '', port: 587, secure: false, user: '', pass: '' };

function SenderDialog({ sender, onClose, onSaved }: { sender: MailSenderView | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const editing = sender && sender !== 'new' ? sender : null;
  const [form, setForm] = useState(EMPTY);
  const [lastKey, setLastKey] = useState<string | null>(null);
  // Reset the form whenever a different sender (or "new") opens the dialog.
  const key = sender === null ? null : editing ? editing.id : 'new';
  if (key !== lastKey) {
    setLastKey(key);
    setForm(editing
      ? { name: editing.name, from: editing.from, replyTo: editing.replyTo ?? '', host: editing.host, port: editing.port, secure: editing.secure, user: editing.user, pass: '' }
      : EMPTY);
  }
  const set = <K extends keyof typeof EMPTY>(k: K, v: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, pass: form.pass || undefined };
      return editing ? api.patch(`/settings/mail-senders/${editing.id}`, body) : api.post('/settings/mail-senders', body);
    },
    onSuccess: () => { toast(t('email.saved')); onSaved(); },
    onError: (e) => toast.error(errText(e)),
  });
  const valid = form.name.trim() && form.from.trim() && form.host.trim() && form.port > 0;

  return (
    <Dialog open={sender !== null} onClose={onClose} title={editing ? t('email.edit') : t('email.add')} width={540}>
      <form
        className="space-y-3 px-4 pb-4 pt-3"
        onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('email.name')}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('email.namePlaceholder')} autoFocus />
          </Field>
          <Field label={t('email.from')}>
            <Input value={form.from} onChange={(e) => set('from', e.target.value)} placeholder="kdn.agency <invoices@kdn.agency>" />
          </Field>
        </div>
        <p className="-mt-1 text-[11px] text-faint">{t('email.fromHint')}</p>
        <Field label={t('email.replyTo')}>
          <Input value={form.replyTo} onChange={(e) => set('replyTo', e.target.value)} placeholder="accountant@kdn.agency" />
        </Field>
        <div className="grid grid-cols-[1fr,96px] gap-3 border-t border-border pt-3">
          <Field label={t('email.host')}>
            <Input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.gmail.com" />
          </Field>
          <Field label={t('email.port')}>
            <Input type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value) || 0)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('email.user')}>
            <Input value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
          </Field>
          <Field label={t('email.pass')}>
            <Input type="password" value={form.pass} onChange={(e) => set('pass', e.target.value)} autoComplete="new-password"
              placeholder={editing?.hasPassword ? '••••••••' : ''} />
          </Field>
        </div>
        {editing?.hasPassword && <p className="-mt-1 text-[11px] text-faint">{t('email.passKeep')}</p>}
        <div className="flex items-center gap-2.5">
          <Switch checked={form.secure} onChange={(v) => { set('secure', v); if (v && form.port === 587) set('port', 465); if (!v && form.port === 465) set('port', 587); }} label={t('email.secure')} />
          <span className="text-[13px]">{t('email.secure')}</span>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!valid || save.isPending}>{save.isPending ? <Spinner /> : null} {t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
