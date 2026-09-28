/**
 * Invoice & quote PDF rendering (PRD §11.3).
 *
 * One renderer, no optional binaries: pdfkit draws the branded document the
 * public page shows – accent bar, workspace logo, both parties' requisites,
 * line items with wrapped descriptions and page breaks, totals, the
 * workspace's payment details, notes/terms and the footer note. Text is set
 * in Liberation Sans (bundled under apps/api/assets/fonts, SIL OFL), so
 * Ukrainian and every other Latin/Cyrillic document renders – the built-in
 * PDF fonts cover WinAnsi only and turned "Рахунок" into boxes.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { env } from '../../env';

export interface PdfDoc {
  number: string;
  currency: string;
  issueDate: string;
  dueDate?: string | null;
  validUntil?: string | null;
  status: string;
  subtotal: string | number;
  taxTotal: string | number;
  total: string | number;
  discountType?: string;
  discountValue?: string | number;
  amountPaid?: string | number | null;
  notes?: string | null;
  terms?: string | null;
  publicToken: string;
  /** Per-document language (PRD §11.3): 'uk' | 'en'. */
  language?: string;
}

export interface PdfLine {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  amount: string | number;
}

/** The client, as stored on `companies` – `address` holds the billing requisites. */
export interface PdfCompany {
  name: string;
  billingEmail?: string | null;
  address?: unknown;
}

/** The workspace row: name + logo + legal_details + invoice_settings. */
export interface PdfWorkspace {
  name?: string | null;
  logo?: string | null;
  legalDetails?: unknown;
  invoiceSettings?: unknown;
}

interface Requisites { legalName?: string | null; taxId?: string | null; address?: string | null; email?: string | null; phone?: string | null }
interface InvoiceSettings {
  accentColor?: string | null; footerNote?: string | null; paymentDetails?: string | null; showLogo?: boolean;
}

/** Localized labels (PRD §11.3, §19.5): PDF language is per-document. */
const LABELS = {
  en: {
    invoice: 'Invoice', quote: 'Quote', from: 'From', billTo: 'Bill to', issue: 'Issue date',
    due: 'Due date', validUntil: 'Valid until', status: 'Status',
    description: 'Description', qty: 'Qty', unit: 'Unit price', amount: 'Amount',
    subtotal: 'Subtotal', discount: 'Discount', tax: 'Tax', total: 'Total',
    paid: 'Amount paid', balance: 'Balance due', notes: 'Notes', terms: 'Terms',
    paymentDetails: 'Payment details', taxId: 'Tax ID', viewOnline: 'View online', page: 'Page',
    status_draft: 'Draft', status_sent: 'Sent', status_viewed: 'Viewed', status_partially_paid: 'Partially paid',
    status_paid: 'Paid', status_overdue: 'Overdue', status_canceled: 'Canceled', status_accepted: 'Accepted',
    status_declined: 'Declined', status_expired: 'Expired',
  },
  uk: {
    invoice: 'Рахунок', quote: 'Комерційна пропозиція', from: 'Постачальник', billTo: 'Платник', issue: 'Дата виставлення',
    due: 'Термін оплати', validUntil: 'Дійсна до', status: 'Статус',
    description: 'Опис', qty: 'К-сть', unit: 'Ціна', amount: 'Сума',
    subtotal: 'Проміжна сума', discount: 'Знижка', tax: 'Податок', total: 'Разом',
    paid: 'Сплачено', balance: 'До сплати', notes: 'Примітки', terms: 'Умови',
    paymentDetails: 'Реквізити для оплати', taxId: 'Код', viewOnline: 'Переглянути онлайн', page: 'Сторінка',
    status_draft: 'Чернетка', status_sent: 'Надіслано', status_viewed: 'Переглянуто', status_partially_paid: 'Частково оплачено',
    status_paid: 'Оплачено', status_overdue: 'Прострочено', status_canceled: 'Скасовано', status_accepted: 'Прийнято',
    status_declined: 'Відхилено', status_expired: 'Прострочено',
  },
} as const;
type Labels = typeof LABELS.en;

function labels(doc: PdfDoc): Labels {
  return doc.language === 'uk' ? (LABELS.uk as unknown as Labels) : LABELS.en;
}

const DEFAULT_ACCENT = '#6366f1';
const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const PANEL = '#f8fafc';

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = { x: 48, top: 44, bottom: 56 };
const CONTENT_W = PAGE.width - MARGIN.x * 2;

/* ───────────────────────── Fonts ───────────────────────── */

const FONT_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../assets/fonts'), // apps/api/src/domains/finance → apps/api/assets/fonts
    path.resolve(here, '../../../../assets/fonts'), // apps/api/dist/... layouts
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(process.cwd(), 'apps/api/assets/fonts'),
  ];
  return candidates.find((d) => existsSync(path.join(d, 'LiberationSans-Regular.ttf'))) ?? null;
})();

let fontCache: { regular: Buffer; bold: Buffer } | null | undefined;
function fonts(): { regular: Buffer; bold: Buffer } | null {
  if (fontCache !== undefined) return fontCache;
  if (!FONT_DIR) { fontCache = null; return null; }
  fontCache = {
    regular: readFileSync(path.join(FONT_DIR, 'LiberationSans-Regular.ttf')),
    bold: readFileSync(path.join(FONT_DIR, 'LiberationSans-Bold.ttf')),
  };
  return fontCache;
}

/* ───────────────────────── Helpers ───────────────────────── */

function fmtMoney(n: string | number | null | undefined, currency: string): string {
  const v = Number(n ?? 0);
  const [int, frac] = Math.abs(v).toFixed(2).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0 ? '-' : ''}${grouped}.${frac} ${currency}`;
}

function fmtQty(n: string | number): string {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

function fmtDate(iso: string | null | undefined, language: string | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return language === 'uk' ? `${m[3]}.${m[2]}.${m[1]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

function requisites(raw: unknown): Requisites {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  return { legalName: str(r.legalName), taxId: str(r.taxId), address: str(r.address), email: str(r.email), phone: str(r.phone) };
}

function settingsOf(ws: PdfWorkspace | null | undefined): InvoiceSettings {
  const raw = ws?.invoiceSettings;
  return raw && typeof raw === 'object' ? (raw as InvoiceSettings) : {};
}

function accentOf(settings: InvoiceSettings): string {
  const c = settings.accentColor;
  return typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : DEFAULT_ACCENT;
}

/**
 * A structurally complete PNG: signature, then chunks up to IEND. pdfkit's
 * PNG parser walks chunks in an unbounded loop and never returns on a
 * truncated file – which would hang the whole API on one bad logo – so the
 * walk happens here first, bounded, and anything short of IEND is skipped.
 */
function isCompletePng(buf: Buffer): boolean {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 + 12 || !buf.subarray(0, 8).equals(SIG)) return false;
  let pos = 8;
  for (let i = 0; i < 10_000 && pos + 8 <= buf.length; i++) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    pos += 12 + size;
    if (pos > buf.length) return false;
    if (type === 'IEND') return true;
  }
  return false;
}

/** A JPEG with both its start and end markers; the in-between is pdfkit's to parse (it throws, never hangs). */
function isCompleteJpeg(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}

/** pdfkit decodes PNG and JPEG only; a WebP or damaged logo is skipped (the name shows instead). */
function logoBytes(ws: PdfWorkspace | null | undefined, settings: InvoiceSettings): Buffer | null {
  if (settings.showLogo === false) return null;
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(ws?.logo ?? '');
  if (!m) return null;
  let bytes: Buffer;
  try { bytes = Buffer.from(m[2]!, 'base64'); } catch { return null; }
  const ok = m[1]!.toLowerCase() === 'png' ? isCompletePng(bytes) : isCompleteJpeg(bytes);
  return ok ? bytes : null;
}

function statusLabel(L: Labels, status: string): string {
  const key = `status_${status}` as keyof Labels;
  return (L[key] as string | undefined) ?? status;
}

/* ───────────────────────── Renderer ───────────────────────── */

class DocWriter {
  readonly doc: PDFKit.PDFDocument;
  private readonly hasFonts: boolean;
  y = MARGIN.top;

  constructor(private readonly L: Labels, private readonly accent: string, title: string) {
    this.doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, bufferPages: true, info: { Title: title, Producer: 'ordi' } });
    const f = fonts();
    this.hasFonts = !!f;
    if (f) {
      this.doc.registerFont('Body', f.regular);
      this.doc.registerFont('Bold', f.bold);
    }
    this.doc.on('pageAdded', () => { this.y = MARGIN.top; this.accentBar(); });
    this.accentBar();
  }

  private accentBar(): void {
    this.doc.rect(0, 0, PAGE.width, 6).fill(this.accent);
  }

  font(bold = false): this {
    this.doc.font(this.hasFonts ? (bold ? 'Bold' : 'Body') : (bold ? 'Helvetica-Bold' : 'Helvetica'));
    return this;
  }

  /** Start a new page when fewer than `needed` points remain. */
  ensure(needed: number): void {
    if (this.y + needed > PAGE.height - MARGIN.bottom) this.doc.addPage();
  }

  textHeight(text: string, width: number, size: number, bold = false): number {
    this.font(bold).doc.fontSize(size);
    return this.doc.heightOfString(text || ' ', { width, lineGap: 1 });
  }

  /** Draw text at (x, y) with wrapping; returns the height used. */
  text(text: string, x: number, y: number, width: number, opts: { size?: number; bold?: boolean; color?: string; align?: 'left' | 'right' | 'center' } = {}): number {
    const size = opts.size ?? 9.5;
    this.font(opts.bold).doc.fontSize(size).fillColor(opts.color ?? INK);
    this.doc.text(text, x, y, { width, align: opts.align ?? 'left', lineGap: 1 });
    return this.doc.heightOfString(text || ' ', { width, lineGap: 1 });
  }

  /** A stacked block of lines at the cursor; returns the height used. */
  block(lines: { text: string; size?: number; bold?: boolean; color?: string }[], x: number, y: number, width: number): number {
    let dy = 0;
    for (const l of lines) {
      if (!l.text) continue;
      dy += this.text(l.text, x, y + dy, width, { size: l.size, bold: l.bold, color: l.color }) + 1.5;
    }
    return dy;
  }

  rule(y: number, color = RULE, weight = 0.6): void {
    this.doc.moveTo(MARGIN.x, y).lineTo(PAGE.width - MARGIN.x, y).lineWidth(weight).strokeColor(color).stroke();
  }

  /** Page numbers + the "view online" link on every page, once the body is done. */
  finishPages(publicUrl: string): void {
    const range = this.doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i);
      const y = PAGE.height - MARGIN.bottom + 18;
      this.rule(y - 8, RULE, 0.4);
      this.text(`${this.L.viewOnline}: ${publicUrl}`, MARGIN.x, y, CONTENT_W - 80, { size: 7.5, color: MUTED });
      this.doc.link(MARGIN.x, y - 2, CONTENT_W - 80, 10, publicUrl);
      this.text(`${this.L.page} ${i - range.start + 1} / ${range.count}`, PAGE.width - MARGIN.x - 80, y, 80, { size: 7.5, color: MUTED, align: 'right' });
    }
  }
}

function render(
  kind: 'invoice' | 'quote',
  doc: PdfDoc,
  items: PdfLine[],
  company: PdfCompany,
  workspace: PdfWorkspace | null | undefined,
): Promise<Buffer> {
  const L = labels(doc);
  const settings = settingsOf(workspace);
  const accent = accentOf(settings);
  const cur = doc.currency;
  const title = `${kind === 'invoice' ? L.invoice : L.quote} ${doc.number}`;
  const w = new DocWriter(L, accent, title);
  const pdf = w.doc;
  const issuerName = str(workspace?.name) || 'ordi';
  const issuer = requisites(workspace?.legalDetails);
  const client = requisites(company.address);
  const publicUrl = `${env.appUrl}/${kind === 'invoice' ? 'i' : 'q'}/${doc.publicToken}`;

  /* ── Header: logo + issuer on the left, document title + number on the right ── */
  const logo = logoBytes(workspace, settings);
  let x = MARGIN.x;
  let headerH = 0;
  if (logo) {
    try {
      pdf.image(logo, x, w.y, { fit: [44, 44] });
      x += 54;
      headerH = 44;
    } catch { /* an undecodable image is not worth a failed invoice */ }
  }
  const leftW = CONTENT_W * 0.55 - (x - MARGIN.x);
  const nameH = w.text(issuerName, x, w.y, leftW, { size: 15, bold: true });
  headerH = Math.max(headerH, nameH);

  const rightX = MARGIN.x + CONTENT_W * 0.55;
  const rightW = CONTENT_W * 0.45;
  w.text((kind === 'invoice' ? L.invoice : L.quote).toUpperCase(), rightX, w.y, rightW, { size: 9, color: MUTED, align: 'right' });
  w.text(doc.number, rightX, w.y + 13, rightW, { size: 20, bold: true, color: accent, align: 'right' });
  headerH = Math.max(headerH, 40);
  w.y += headerH + 16;
  w.rule(w.y, accent, 1);
  w.y += 16;

  /* ── Parties + dates ── */
  const colW = (CONTENT_W - 24) / 3;
  const fromLines = [
    { text: L.from.toUpperCase(), size: 7.5, color: MUTED },
    { text: issuer.legalName || issuerName, bold: true },
    { text: issuer.taxId ? `${L.taxId}: ${issuer.taxId}` : '', color: MUTED },
    { text: issuer.address || '', color: MUTED },
    { text: issuer.email || '', color: MUTED },
    { text: issuer.phone || '', color: MUTED },
  ];
  const toLines = [
    { text: L.billTo.toUpperCase(), size: 7.5, color: MUTED },
    { text: client.legalName || company.name, bold: true },
    { text: client.legalName && client.legalName !== company.name ? company.name : '', color: MUTED },
    { text: client.taxId ? `${L.taxId}: ${client.taxId}` : '', color: MUTED },
    { text: client.address || '', color: MUTED },
    { text: str(company.billingEmail), color: MUTED },
  ];
  const metaRows: [string, string][] = [
    [L.issue, fmtDate(doc.issueDate, doc.language)],
    kind === 'invoice' ? [L.due, fmtDate(doc.dueDate, doc.language)] : [L.validUntil, fmtDate(doc.validUntil, doc.language)],
    [L.status, statusLabel(L, doc.status)],
  ];
  const fromH = w.block(fromLines, MARGIN.x, w.y, colW);
  const toH = w.block(toLines, MARGIN.x + colW + 12, w.y, colW);
  let metaH = 0;
  for (const [k, v] of metaRows) {
    if (!v) continue;
    const mx = MARGIN.x + (colW + 12) * 2;
    w.text(k, mx, w.y + metaH, colW * 0.5, { size: 8.5, color: MUTED });
    w.text(v, mx + colW * 0.5, w.y + metaH, colW * 0.5, { size: 9.5, bold: true, align: 'right' });
    metaH += 14;
  }
  w.y += Math.max(fromH, toH, metaH) + 20;

  /* ── Line items ── */
  const cols = { qty: 50, unit: 90, amount: 96 };
  const descW = CONTENT_W - cols.qty - cols.unit - cols.amount;
  const xQty = MARGIN.x + descW;
  const xUnit = xQty + cols.qty;
  const xAmount = xUnit + cols.unit;
  const drawTableHead = () => {
    w.ensure(28);
    pdf.rect(MARGIN.x, w.y, CONTENT_W, 20).fill(PANEL);
    const ty = w.y + 6;
    w.text(L.description, MARGIN.x + 8, ty, descW - 8, { size: 8, bold: true, color: MUTED });
    w.text(L.qty, xQty, ty, cols.qty, { size: 8, bold: true, color: MUTED, align: 'right' });
    w.text(L.unit, xUnit, ty, cols.unit, { size: 8, bold: true, color: MUTED, align: 'right' });
    w.text(L.amount, xAmount, ty, cols.amount - 8, { size: 8, bold: true, color: MUTED, align: 'right' });
    w.y += 20;
    w.rule(w.y, accent, 0.8);
  };
  drawTableHead();
  for (const it of items) {
    const h = Math.max(w.textHeight(it.description, descW - 16, 9.5), 12) + 12;
    if (w.y + h > PAGE.height - MARGIN.bottom) { pdf.addPage(); drawTableHead(); }
    const ty = w.y + 6;
    w.text(it.description, MARGIN.x + 8, ty, descW - 16, { size: 9.5 });
    w.text(fmtQty(it.quantity), xQty, ty, cols.qty, { size: 9.5, color: MUTED, align: 'right' });
    w.text(fmtMoney(it.unitPrice, cur), xUnit, ty, cols.unit, { size: 9.5, color: MUTED, align: 'right' });
    w.text(fmtMoney(it.amount, cur), xAmount, ty, cols.amount - 8, { size: 9.5, bold: true, align: 'right' });
    w.y += h;
    w.rule(w.y);
  }
  w.y += 12;

  /* ── Totals ── */
  const totals: { label: string; value: string; bold?: boolean; highlight?: boolean }[] = [
    { label: L.subtotal, value: fmtMoney(doc.subtotal, cur) },
  ];
  if (doc.discountType && doc.discountType !== 'none' && Number(doc.discountValue ?? 0) > 0) {
    totals.push({ label: L.discount, value: doc.discountType === 'percent' ? `${Number(doc.discountValue)}%` : fmtMoney(doc.discountValue, cur) });
  }
  totals.push({ label: L.tax, value: fmtMoney(doc.taxTotal, cur) });
  totals.push({ label: L.total, value: fmtMoney(doc.total, cur), bold: true });
  if (kind === 'invoice') {
    const paid = Number(doc.amountPaid ?? 0);
    if (paid > 0) totals.push({ label: L.paid, value: fmtMoney(paid, cur) });
    totals.push({ label: L.balance, value: fmtMoney(Number(doc.total) - paid, cur), bold: true, highlight: true });
  }
  const totalsW = 230;
  const totalsX = PAGE.width - MARGIN.x - totalsW;
  w.ensure(totals.length * 18 + 10);
  for (const row of totals) {
    const rowH = row.highlight ? 24 : 17;
    if (row.highlight) {
      pdf.roundedRect(totalsX, w.y, totalsW, rowH, 4).fill(accent);
      const ty = w.y + 7;
      w.text(row.label, totalsX + 10, ty, totalsW / 2, { size: 10, bold: true, color: '#ffffff' });
      w.text(row.value, totalsX + totalsW / 2, ty, totalsW / 2 - 10, { size: 10.5, bold: true, color: '#ffffff', align: 'right' });
    } else {
      const ty = w.y + 3;
      w.text(row.label, totalsX + 10, ty, totalsW / 2, { size: 9.5, bold: row.bold, color: row.bold ? INK : MUTED });
      w.text(row.value, totalsX + totalsW / 2, ty, totalsW / 2 - 10, { size: row.bold ? 10.5 : 9.5, bold: row.bold, align: 'right' });
      if (row.bold) w.doc.moveTo(totalsX + 10, w.y).lineTo(totalsX + totalsW - 10, w.y).lineWidth(0.6).strokeColor(RULE).stroke();
    }
    w.y += rowH + 2;
  }
  w.y += 14;

  /* ── Payment details (workspace) ── */
  const payment = str(settings.paymentDetails);
  if (payment && kind === 'invoice') {
    const innerW = CONTENT_W - 24;
    const h = w.textHeight(payment, innerW, 9) + 34;
    w.ensure(h);
    pdf.roundedRect(MARGIN.x, w.y, CONTENT_W, h, 5).fill(PANEL);
    w.text(L.paymentDetails.toUpperCase(), MARGIN.x + 12, w.y + 10, innerW, { size: 7.5, bold: true, color: MUTED });
    w.text(payment, MARGIN.x + 12, w.y + 23, innerW, { size: 9 });
    w.y += h + 14;
  }

  /* ── Notes / terms ── */
  for (const [label, body] of [[L.notes, str(doc.notes)], [L.terms, str(doc.terms)]] as const) {
    if (!body) continue;
    const h = w.textHeight(body, CONTENT_W, 9) + 16;
    w.ensure(h);
    w.text(label.toUpperCase(), MARGIN.x, w.y, CONTENT_W, { size: 7.5, bold: true, color: MUTED });
    w.text(body, MARGIN.x, w.y + 12, CONTENT_W, { size: 9, color: '#374151' });
    w.y += h + 6;
  }

  /* ── Footer note ── */
  const footer = str(settings.footerNote);
  if (footer) {
    const h = w.textHeight(footer, CONTENT_W, 9) + 8;
    w.ensure(h);
    w.text(footer, MARGIN.x, w.y + 4, CONTENT_W, { size: 9, color: MUTED, align: 'center' });
    w.y += h;
  }

  w.finishPages(publicUrl);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

export function renderInvoicePdf(
  invoice: PdfDoc,
  items: PdfLine[],
  company: PdfCompany,
  workspace?: PdfWorkspace | null,
): Promise<Buffer> {
  return render('invoice', invoice, items, company, workspace);
}

export function renderQuotePdf(
  quote: PdfDoc,
  items: PdfLine[],
  company: PdfCompany,
  workspace?: PdfWorkspace | null,
): Promise<Buffer> {
  return render('quote', quote, items, company, workspace);
}
