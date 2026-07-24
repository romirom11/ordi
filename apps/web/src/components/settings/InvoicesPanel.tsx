import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Input, Textarea, Switch, Skeleton, Spinner, cn } from '../ui';
import { toast } from '../overlays';
import { SectionHead, SettingRow } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.invoicesDesc': 'Branding applied to every invoice you send and its public page.',
    'settings.invoiceShowLogo': 'Show workspace logo',
    'settings.invoiceShowLogoHint': 'Display your logo in the invoice header.',
    'settings.invoiceAccent': 'Accent colour',
    'settings.invoiceAccentHint': 'Used for the accent bar and the invoice number.',
    'settings.invoiceCustomHex': 'Custom hex',
    'settings.invoiceFooter': 'Footer note',
    'settings.invoiceFooterPlaceholder': 'Дякуємо за співпрацю!',
    'settings.invoicePayment': 'Payment details',
    'settings.invoicePaymentPlaceholder': 'IBAN UA00 0000 0000 …\nПризначення платежу: …',
    'settings.invoicePreview': 'Preview',
    'settings.invoicePreviewNumber': 'INV-0001',
    'settings.invoicePreviewFrom': 'From',
    'settings.invoicePreviewTotal': 'Total due',
  },
  uk: {
    'settings.invoicesDesc': 'Оформлення, що застосовується до кожного інвойсу та його публічної сторінки.',
    'settings.invoiceShowLogo': 'Показувати логотип',
    'settings.invoiceShowLogoHint': 'Відображати ваш логотип у шапці інвойсу.',
    'settings.invoiceAccent': 'Акцентний колір',
    'settings.invoiceAccentHint': 'Використовується для акцентної смуги та номера інвойсу.',
    'settings.invoiceCustomHex': 'Власний hex',
    'settings.invoiceFooter': 'Примітка у футері',
    'settings.invoiceFooterPlaceholder': 'Дякуємо за співпрацю!',
    'settings.invoicePayment': 'Платіжні реквізити',
    'settings.invoicePaymentPlaceholder': 'IBAN UA00 0000 0000 …\nПризначення платежу: …',
    'settings.invoicePreview': 'Попередній перегляд',
    'settings.invoicePreviewNumber': 'INV-0001',
    'settings.invoicePreviewFrom': 'Від',
    'settings.invoicePreviewTotal': 'До сплати',
  },
});

interface InvoiceSettings {
  showLogo?: boolean;
  accentColor?: string | null;
  footerNote?: string | null;
  paymentDetails?: string | null;
}
interface WorkspaceData {
  name?: string;
  logo?: string | null;
  invoiceSettings?: InvoiceSettings;
}

const DEFAULT_ACCENT = '#6366f1';
const PRESETS = ['#6366f1', '#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b'];
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function InvoicesPanel() {
  const t = useT();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ['workspace-settings'], queryFn: () => api.get<WorkspaceData>('/settings/workspace') });

  const [showLogo, setShowLogo] = useState(true);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [footer, setFooter] = useState('');
  const [payment, setPayment] = useState('');

  useEffect(() => {
    if (ws.data) {
      const inv = ws.data.invoiceSettings ?? {};
      setShowLogo(inv.showLogo ?? true);
      setAccent(inv.accentColor ?? DEFAULT_ACCENT);
      setFooter(inv.footerNote ?? '');
      setPayment(inv.paymentDetails ?? '');
    }
  }, [ws.data]);

  const patch = useMutation({
    mutationFn: (body: InvoiceSettings) => api.patch('/settings/workspace', { invoiceSettings: body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-settings'] });
      qc.invalidateQueries({ queryKey: ['workspace'] });
      toast(t('common.saved'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const validHex = HEX_RE.test(accent);
  const safeAccent = validHex ? accent : DEFAULT_ACCENT;
  const logo = ws.data?.logo ?? null;
  const name = ws.data?.name ?? 'ordi';

  const stored = ws.data?.invoiceSettings ?? {};
  const dirty = !!ws.data && (
    showLogo !== (stored.showLogo ?? true) ||
    accent !== (stored.accentColor ?? DEFAULT_ACCENT) ||
    footer !== (stored.footerNote ?? '') ||
    payment !== (stored.paymentDetails ?? '')
  );

  const save = () => {
    if (!validHex) return;
    patch.mutate({
      showLogo,
      accentColor: accent,
      footerNote: footer.trim() || null,
      paymentDetails: payment.trim() || null,
    });
  };

  if (ws.isLoading) {
    return <div className="space-y-4"><Skeleton className="h-6 w-40" /><Skeleton className="h-40 w-full" /><Skeleton className="h-56 w-full" /></div>;
  }

  return (
    <div>
      <SectionHead title={t('settings.invoices')} desc={t('settings.invoicesDesc')} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr,280px]">
        {/* Form */}
        <div>
          <SettingRow label={t('settings.invoiceShowLogo')} hint={t('settings.invoiceShowLogoHint')}>
            <Switch checked={showLogo} onChange={setShowLogo} />
          </SettingRow>

          <SettingRow label={t('settings.invoiceAccent')} hint={t('settings.invoiceAccentHint')} className="items-start">
            <div className="flex flex-col items-end gap-2.5">
              <div className="flex flex-wrap justify-end gap-1.5">
                {PRESETS.map((c) => {
                  const active = accent.toLowerCase() === c.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setAccent(c)}
                      title={c}
                      aria-label={c}
                      className={cn(
                        'grid h-6 w-6 place-items-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-150 hover:scale-110',
                        active && 'ring-2 ring-foreground',
                      )}
                      style={{ backgroundColor: c }}
                    >
                      {active && <Check size={13} className="text-white" strokeWidth={3} />}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="h-6 w-6 shrink-0 rounded-md border border-border"
                  style={{ backgroundColor: safeAccent }}
                />
                <Input
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  placeholder={DEFAULT_ACCENT}
                  aria-label={t('settings.invoiceCustomHex')}
                  className={cn('w-28 font-mono text-xs', !validHex && 'border-destructive')}
                />
              </div>
            </div>
          </SettingRow>

          <SettingRow label={t('settings.invoiceFooter')} className="items-start">
            <Textarea
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder={t('settings.invoiceFooterPlaceholder')}
              rows={2}
              className="w-64"
            />
          </SettingRow>

          <SettingRow label={t('settings.invoicePayment')} className="items-start">
            <Textarea
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
              placeholder={t('settings.invoicePaymentPlaceholder')}
              rows={3}
              className="w-64"
            />
          </SettingRow>

          <div className="mt-5 flex h-8 items-center gap-3">
            {dirty && (
              <Button size="sm" onClick={save} disabled={patch.isPending || !validHex}>
                {patch.isPending ? <Spinner /> : null} {t('common.save')}
              </Button>
            )}
          </div>
        </div>

        {/* Live preview */}
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('settings.invoicePreview')}</div>
          <InvoicePreview
            accent={safeAccent}
            showLogo={showLogo}
            logo={logo}
            name={name}
            footer={footer}
            payment={payment}
          />
        </div>
      </div>
    </div>
  );
}

function InvoicePreview({ accent, showLogo, logo, name, footer, payment }: {
  accent: string; showLogo: boolean; logo: string | null; name: string; footer: string; payment: string;
}) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-pop">
      <div className="h-1.5 w-full" style={{ backgroundColor: accent }} />
      <div className="p-4">
        {/* header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {showLogo && (
              logo ? (
                <img src={logo} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
              ) : (
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded text-xs font-bold text-white" style={{ backgroundColor: accent }}>
                  {name.slice(0, 1).toUpperCase()}
                </div>
              )
            )}
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{name}</div>
              <div className="text-[10px] text-faint">{t('settings.invoicePreviewFrom')}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[15px] font-bold tabular-nums" style={{ color: accent }}>{t('settings.invoicePreviewNumber')}</div>
            <div className="text-[10px] text-faint">2026</div>
          </div>
        </div>

        {/* fake line rows */}
        <div className="mt-4 space-y-2">
          {[0.9, 0.7, 0.55].map((w, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="h-2 rounded-full bg-muted" style={{ width: `${w * 100}%` }} />
              <div className="h-2 w-8 shrink-0 rounded-full bg-muted" />
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <span className="text-[11px] text-muted-foreground">{t('settings.invoicePreviewTotal')}</span>
          <span className="text-[13px] font-bold tabular-nums" style={{ color: accent }}>$1,240.00</span>
        </div>

        {/* payment details */}
        {payment.trim() && (
          <div className="mt-3 whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-[10px] leading-relaxed text-muted-foreground">
            {payment}
          </div>
        )}

        {/* footer */}
        <div className="mt-3 border-t border-border pt-2 text-center text-[11px] italic text-muted-foreground">
          {footer.trim() || t('settings.invoiceFooterPlaceholder')}
        </div>
      </div>
    </div>
  );
}
