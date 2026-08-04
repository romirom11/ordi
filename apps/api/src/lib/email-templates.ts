/**
 * Email rendering: one branded layout, per-message content, uk/en.
 *
 * Mail clients ignore CSS variables, external stylesheets and (mostly) dark
 * mode, so the layout is a table with inline styles on a light background.
 * Every message ships both HTML and a plain-text fallback.
 */
import { getDb, schema, eq } from '@ordi/db';
import { env } from '../env';

export type EmailLocale = 'en' | 'uk';

export function asLocale(value: unknown): EmailLocale {
  return value === 'uk' ? 'uk' : 'en';
}

/* ───────────────────────── Branding ───────────────────────── */

export interface Branding {
  workspaceName: string;
  logo: string | null;
  accent: string;
}

const DEFAULT_ACCENT = '#5e6ad2';

/** Workspace name/logo/accent, with safe fallbacks when settings are missing. */
export async function loadBranding(): Promise<Branding> {
  try {
    const { db } = getDb();
    const [row] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
    const invoiceSettings = (row?.invoiceSettings ?? {}) as { accentColor?: string };
    const accent = typeof invoiceSettings.accentColor === 'string' && /^#[0-9a-f]{3,8}$/i.test(invoiceSettings.accentColor)
      ? invoiceSettings.accentColor
      : DEFAULT_ACCENT;
    return { workspaceName: row?.name || 'ordi', logo: row?.logo ?? null, accent };
  } catch {
    return { workspaceName: 'ordi', logo: null, accent: DEFAULT_ACCENT };
  }
}

/* ───────────────────────── Strings ───────────────────────── */

type Dict = Record<string, string>;

const EN: Dict = {
  'footer.sentBy': 'Sent by {workspace} · powered by ordi',
  'footer.prefs': 'Manage email preferences',

  'invite.subject': 'You have been invited to {workspace}',
  'invite.heading': 'Join {workspace}',
  'invite.body': 'You have been invited to collaborate in {workspace} on ordi. Set up your account to get started.',
  'invite.cta': 'Accept invitation',
  'invite.expiry': 'This invitation link is personal – do not forward it.',

  'reset.subject': 'Reset your {workspace} password',
  'reset.heading': 'Reset your password',
  'reset.body': 'We received a request to reset the password for your {workspace} account. Choose a new one with the link below.',
  'reset.bodyAdmin': 'An administrator started a password reset for your {workspace} account. Choose a new password with the link below.',
  'reset.cta': 'Choose a new password',
  'reset.note': 'The link works once and expires in an hour. If you did not expect this, ignore this email – your password stays as it is.',

  'invoice.subject': 'Invoice {number} from {workspace}',
  'invoice.heading': 'Invoice {number}',
  'invoice.body': 'Please find invoice {number} for {amount} attached. It is due on {dueDate}.',
  'invoice.bodyNoDue': 'Please find invoice {number} for {amount} attached.',
  'invoice.cta': 'View invoice online',
  'invoice.attached': 'A PDF copy is attached to this email.',

  'quote.subject': 'Quote {number} from {workspace}',
  'quote.heading': 'Quote {number}',
  'quote.body': 'Here is quote {number} for {amount}. You can review and accept it online.',
  'quote.cta': 'Review quote',
  'quote.attached': 'A PDF copy is attached to this email.',

  'reminder.subject': 'Reminder: invoice {number} is due',
  'reminder.subjectOverdue': 'Overdue: invoice {number}',
  'reminder.heading': 'Payment reminder',
  'reminder.body': 'Invoice {number} for {amount} is due on {dueDate}.',
  'reminder.bodyOverdue': 'Invoice {number} for {amount} was due on {dueDate} and is still outstanding.',
  'reminder.cta': 'View invoice',
  'reminder.thanks': 'If payment is already on its way, please ignore this message.',

  'intakeAccepted.subject': 'Your request was accepted',
  'intakeAccepted.heading': 'Request accepted',
  'intakeAccepted.body': 'We have accepted your request “{title}” and started working on it.',
  'intakeDeclined.subject': 'Update on your request',
  'intakeDeclined.heading': 'Request declined',
  'intakeDeclined.body': 'We reviewed your request “{title}” and will not be taking it forward.',
  'intake.reason': 'Reason: {reason}',

  'notify.cta': 'Open in ordi',
  'notify.someone': 'Someone',
  'notify.task.assigned.subject': '{ref} assigned to you',
  'notify.task.assigned.heading': 'A task was assigned to you',
  'notify.task.assigned.body': '{actor} assigned {ref} “{title}” to you.',
  'notify.comment.mentioned.subject': '{actor} mentioned you in {ref}',
  'notify.comment.mentioned.heading': 'You were mentioned',
  'notify.comment.mentioned.body': '{actor} mentioned you in {ref} “{title}”.',
  'notify.task.status_changed.subject': '{ref} moved to {status}',
  'notify.task.status_changed.heading': 'Status changed',
  'notify.task.status_changed.body': '{ref} “{title}” moved to {status}.',
  'notify.invoice.paid.subject': 'Invoice {ref} was paid',
  'notify.invoice.paid.heading': 'Payment received',
  'notify.invoice.paid.body': 'Invoice {ref} has been paid in full.',
  'notify.quote.accepted.subject': 'Quote {ref} accepted',
  'notify.quote.accepted.heading': 'Quote accepted',
  'notify.quote.accepted.body': 'The client accepted quote {ref}.',
  'notify.leave.requested.subject': 'Leave request awaiting your decision',
  'notify.leave.requested.heading': 'Leave request',
  'notify.leave.requested.body': '{actor} requested leave and is waiting for your decision.',
  'notify.leave.decided.subject': 'Your leave request was {decision}',
  'notify.leave.decided.heading': 'Leave request {decision}',
  'notify.leave.decided.body': 'Your leave request was {decision}.',
  'notify.sales.work_digest.subject': 'Your sales work: {total} items',
  'notify.sales.work_digest.heading': 'Your sales work is ready',
  'notify.sales.work_digest.body': '{overdue} overdue, {dueToday} due today and {noNextAction} without a next action. {nurtureDue} come back from nurture. {upcoming} are booked ahead and {waitingReply} are awaiting a reply.',
  'notify.generic.subject': 'Notification from {workspace}',
  'notify.generic.heading': 'Something needs your attention',
  'notify.generic.body': 'There is an update on {ref}.',
};

const UK: Dict = {
  'footer.sentBy': 'Надіслано з {workspace} · на платформі ordi',
  'footer.prefs': 'Налаштувати сповіщення',

  'invite.subject': 'Вас запросили до {workspace}',
  'invite.heading': 'Приєднуйтесь до {workspace}',
  'invite.body': 'Вас запросили до спільної роботи в {workspace} на ordi. Створіть обліковий запис, щоб почати.',
  'invite.cta': 'Прийняти запрошення',
  'invite.expiry': 'Це персональне посилання – не пересилайте його іншим.',

  'reset.subject': 'Відновлення пароля в {workspace}',
  'reset.heading': 'Відновлення пароля',
  'reset.body': 'Ми отримали запит на відновлення пароля для вашого облікового запису в {workspace}. Створіть новий пароль за посиланням нижче.',
  'reset.bodyAdmin': 'Адміністратор розпочав відновлення пароля для вашого облікового запису в {workspace}. Створіть новий пароль за посиланням нижче.',
  'reset.cta': 'Створити новий пароль',
  'reset.note': 'Посилання одноразове і діє годину. Якщо ви цього не очікували – просто проігноруйте лист, пароль залишиться попереднім.',

  'invoice.subject': 'Рахунок {number} від {workspace}',
  'invoice.heading': 'Рахунок {number}',
  'invoice.body': 'Надсилаємо рахунок {number} на суму {amount}. Термін оплати – {dueDate}.',
  'invoice.bodyNoDue': 'Надсилаємо рахунок {number} на суму {amount}.',
  'invoice.cta': 'Переглянути рахунок онлайн',
  'invoice.attached': 'PDF-копію додано до цього листа.',

  'quote.subject': 'Комерційна пропозиція {number} від {workspace}',
  'quote.heading': 'Пропозиція {number}',
  'quote.body': 'Надсилаємо пропозицію {number} на суму {amount}. Її можна переглянути та прийняти онлайн.',
  'quote.cta': 'Переглянути пропозицію',
  'quote.attached': 'PDF-копію додано до цього листа.',

  'reminder.subject': 'Нагадування: рахунок {number} до оплати',
  'reminder.subjectOverdue': 'Прострочено: рахунок {number}',
  'reminder.heading': 'Нагадування про оплату',
  'reminder.body': 'Рахунок {number} на суму {amount} потрібно сплатити до {dueDate}.',
  'reminder.bodyOverdue': 'Рахунок {number} на суму {amount} мав бути сплачений до {dueDate} і досі не оплачений.',
  'reminder.cta': 'Переглянути рахунок',
  'reminder.thanks': 'Якщо оплата вже в дорозі – просто проігноруйте цей лист.',

  'intakeAccepted.subject': 'Вашу заявку прийнято',
  'intakeAccepted.heading': 'Заявку прийнято',
  'intakeAccepted.body': 'Ми прийняли вашу заявку «{title}» і вже почали над нею працювати.',
  'intakeDeclined.subject': 'Оновлення щодо вашої заявки',
  'intakeDeclined.heading': 'Заявку відхилено',
  'intakeDeclined.body': 'Ми розглянули вашу заявку «{title}» і не братимемо її в роботу.',
  'intake.reason': 'Причина: {reason}',

  'notify.cta': 'Відкрити в ordi',
  'notify.someone': 'Хтось',
  'notify.task.assigned.subject': '{ref} призначено вам',
  'notify.task.assigned.heading': 'Вам призначили задачу',
  'notify.task.assigned.body': '{actor} призначив(ла) вам {ref} «{title}».',
  'notify.comment.mentioned.subject': '{actor} згадав(ла) вас у {ref}',
  'notify.comment.mentioned.heading': 'Вас згадали',
  'notify.comment.mentioned.body': '{actor} згадав(ла) вас у {ref} «{title}».',
  'notify.task.status_changed.subject': '{ref} перейшла в статус {status}',
  'notify.task.status_changed.heading': 'Статус змінено',
  'notify.task.status_changed.body': '{ref} «{title}» перейшла в статус {status}.',
  'notify.invoice.paid.subject': 'Рахунок {ref} оплачено',
  'notify.invoice.paid.heading': 'Оплату отримано',
  'notify.invoice.paid.body': 'Рахунок {ref} повністю оплачено.',
  'notify.quote.accepted.subject': 'Пропозицію {ref} прийнято',
  'notify.quote.accepted.heading': 'Пропозицію прийнято',
  'notify.quote.accepted.body': 'Клієнт прийняв пропозицію {ref}.',
  'notify.leave.requested.subject': 'Запит на відпустку очікує рішення',
  'notify.leave.requested.heading': 'Запит на відпустку',
  'notify.leave.requested.body': '{actor} подав(ла) запит на відпустку і чекає на ваше рішення.',
  'notify.leave.decided.subject': 'Ваш запит на відпустку: {decision}',
  'notify.leave.decided.heading': 'Запит на відпустку: {decision}',
  'notify.leave.decided.body': 'Ваш запит на відпустку: {decision}.',
  'notify.sales.work_digest.subject': 'Ваша робота з продажів: {total} записів',
  'notify.sales.work_digest.heading': 'Ранкова черга продажів готова',
  'notify.sales.work_digest.body': 'Протерміновано: {overdue}, на сьогодні: {dueToday}, без наступної дії: {noNextAction}. Повернулись із відкладених: {nurtureDue}. Заплановано наперед: {upcoming}, очікують відповіді: {waitingReply}.',
  'notify.generic.subject': 'Сповіщення з {workspace}',
  'notify.generic.heading': 'Потрібна ваша увага',
  'notify.generic.body': 'Є оновлення щодо {ref}.',
};

const DICTS: Record<EmailLocale, Dict> = { en: EN, uk: UK };

export function tr(locale: EmailLocale, key: string, vars: Record<string, string | number | undefined> = {}): string {
  const template = DICTS[locale][key] ?? DICTS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ''));
}

/* ───────────────────────── Layout ───────────────────────── */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export interface RenderInput {
  locale: EmailLocale;
  branding: Branding;
  heading: string;
  /** Paragraphs of body copy, plain text (escaped on render). */
  paragraphs: string[];
  cta?: { label: string; url: string };
  /** Small muted line under the body. */
  note?: string;
}

export interface RenderedEmail { html: string; text: string }

export function renderEmail(input: RenderInput): RenderedEmail {
  const { locale, branding, heading, paragraphs, cta, note } = input;
  const accent = branding.accent;

  const logoCell = branding.logo
    ? `<img src="${esc(branding.logo)}" width="28" height="28" alt="" style="display:block;border-radius:6px;border:0;" />`
    : `<span style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:6px;background:${esc(accent)};color:#ffffff;font-weight:600;font-size:13px;">${esc(branding.workspaceName.slice(0, 1).toUpperCase())}</span>`;

  const body = paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#3c4149;">${esc(p)}</p>`)
    .join('');

  const ctaHtml = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;">
         <tr><td style="border-radius:8px;background:${esc(accent)};">
           <a href="${esc(cta.url)}" style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(cta.label)}</a>
         </td></tr>
       </table>
       <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#8a8f98;word-break:break-all;">${esc(cta.url)}</p>`
    : '';

  const noteHtml = note
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#8a8f98;">${esc(note)}</p>`
    : '';

  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width" />
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#ffffff;border:1px solid #e6e8ec;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;">
        <tr><td style="height:3px;background:${esc(accent)};line-height:3px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:20px 28px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="padding-right:10px;">${logoCell}</td>
            <td style="font-size:14px;font-weight:600;color:#1c1e21;">${esc(branding.workspaceName)}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:18px 28px 26px;">
          <h1 style="margin:0 0 12px;font-size:19px;line-height:1.35;font-weight:650;color:#1c1e21;">${esc(heading)}</h1>
          ${body}${ctaHtml}${noteHtml}
        </td></tr>
        <tr><td style="padding:14px 28px 20px;border-top:1px solid #eef0f3;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#8a8f98;">${esc(tr(locale, 'footer.sentBy', { workspace: branding.workspaceName }))}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    branding.workspaceName,
    '',
    heading,
    '',
    ...paragraphs,
    ...(cta ? ['', `${cta.label}: ${cta.url}`] : []),
    ...(note ? ['', note] : []),
    '',
    '–',
    tr(locale, 'footer.sentBy', { workspace: branding.workspaceName }),
  ].join('\n');

  return { html, text };
}

/** Absolute app URL for a path like `/projects/x/tasks/y`. */
export function appLink(path: string): string {
  const base = (env.appUrl || '').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
