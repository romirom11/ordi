/**
 * Invoice & quote PDF rendering (PRD §11.3). Builds a text-line array for the
 * dependency-free fallback writer and, when the Typst CLI is present, a branded
 * Typst source. `renderWithTypst` returns null when the CLI is unavailable, so we
 * always fall back to `renderSimplePdf` and never fail the endpoint.
 */
import { renderSimplePdf, renderWithTypst } from '../../lib/pdf';
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
  notes?: string;
  terms?: string;
  publicToken: string;
  /** Per-document language (PRD §11.3): 'uk' | 'en'. */
  language?: string;
}

/** Localized labels (PRD §11.3, §19.5): PDF language is per-document. */
const LABELS: Record<'en' | 'uk', Record<string, string>> = {
  en: {
    invoice: 'Invoice', quote: 'Quote', billTo: 'Bill To', issue: 'Issue date',
    due: 'Due date', validUntil: 'Valid until', status: 'Status',
    description: 'Description', qty: 'Qty', unit: 'Unit price', amount: 'Amount',
    subtotal: 'Subtotal', discount: 'Discount', tax: 'Tax', total: 'Total',
    paid: 'Amount paid', balance: 'Balance due', notes: 'Notes', terms: 'Terms',
    viewOnline: 'View online',
  },
  uk: {
    invoice: 'Рахунок', quote: 'Комерційна пропозиція', billTo: 'Платник', issue: 'Дата виставлення',
    due: 'Термін оплати', validUntil: 'Дійсна до', status: 'Статус',
    description: 'Опис', qty: 'К-сть', unit: 'Ціна', amount: 'Сума',
    subtotal: 'Проміжна сума', discount: 'Знижка', tax: 'Податок', total: 'Разом',
    paid: 'Сплачено', balance: 'До сплати', notes: 'Нотатки', terms: 'Умови',
    viewOnline: 'Переглянути онлайн',
  },
};

function labels(doc: PdfDoc): Record<string, string> {
  return LABELS[doc.language === 'uk' ? 'uk' : 'en'];
}

export interface PdfLine {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  amount: string | number;
}

export interface PdfCompany {
  name: string;
  billingEmail?: string | null;
  address?: unknown;
}

export interface PdfWorkspace {
  name?: string;
  legalDetails?: unknown;
}

function fmtMoney(n: string | number | null | undefined, currency: string): string {
  return `${Number(n ?? 0).toFixed(2)} ${currency}`;
}

function addressLines(address: unknown): string[] {
  if (!address || typeof address !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(address as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
  }
  return out;
}

/** Pad/truncate for the monospace fallback layout. */
function col(s: string, width: number, right = false): string {
  const t = s.length > width ? s.slice(0, width) : s;
  return right ? t.padStart(width) : t.padEnd(width);
}

function buildLines(
  kind: 'invoice' | 'quote',
  doc: PdfDoc,
  items: PdfLine[],
  company: PdfCompany,
  workspace: PdfWorkspace | null | undefined,
): { title: string; lines: string[] } {
  const cur = doc.currency;
  const L = labels(doc);
  const label = kind === 'invoice' ? L.invoice! : L.quote!;
  const title = `${label} ${doc.number}`;
  const lines: string[] = [];

  // Agency (workspace) header
  lines.push(workspace?.name ?? 'ordi');
  for (const l of addressLines(workspace?.legalDetails)) lines.push(l);
  lines.push('');

  // Bill-to
  lines.push(`${L.billTo}:`);
  lines.push(company.name);
  if (company.billingEmail) lines.push(company.billingEmail);
  for (const l of addressLines(company.address)) lines.push(l);
  lines.push('');

  // Meta
  lines.push(`${label} #: ${doc.number}`);
  lines.push(`${L.issue}: ${doc.issueDate}`);
  if (kind === 'invoice' && doc.dueDate) lines.push(`${L.due}: ${doc.dueDate}`);
  if (kind === 'quote' && doc.validUntil) lines.push(`${L.validUntil}: ${doc.validUntil}`);
  lines.push(`${L.status}: ${doc.status}`);
  lines.push('');

  // Items
  lines.push(`${col(L.description!, 40)}${col(L.qty!, 8, true)}${col(L.unit!, 14, true)}${col(L.amount!, 14, true)}`);
  lines.push(''.padEnd(76, '-'));
  for (const it of items) {
    lines.push(
      `${col(it.description, 40)}${col(String(Number(it.quantity)), 8, true)}${col(fmtMoney(it.unitPrice, cur), 14, true)}${col(fmtMoney(it.amount, cur), 14, true)}`,
    );
  }
  lines.push(''.padEnd(76, '-'));

  // Totals
  lines.push(`${col(L.subtotal!, 62)}${col(fmtMoney(doc.subtotal, cur), 14, true)}`);
  if (doc.discountType && doc.discountType !== 'none' && Number(doc.discountValue ?? 0) > 0) {
    const disc = doc.discountType === 'percent' ? `${Number(doc.discountValue)}%` : fmtMoney(doc.discountValue, cur);
    lines.push(`${col(L.discount!, 62)}${col(disc, 14, true)}`);
  }
  lines.push(`${col(L.tax!, 62)}${col(fmtMoney(doc.taxTotal, cur), 14, true)}`);
  lines.push(`${col(L.total!, 62)}${col(fmtMoney(doc.total, cur), 14, true)}`);
  if (kind === 'invoice') {
    const paid = Number(doc.amountPaid ?? 0);
    lines.push(`${col(L.paid!, 62)}${col(fmtMoney(paid, cur), 14, true)}`);
    lines.push(`${col(L.balance!, 62)}${col(fmtMoney(Number(doc.total) - paid, cur), 14, true)}`);
  }
  lines.push('');

  if (doc.notes) { lines.push(`${L.notes}:`); lines.push(doc.notes); lines.push(''); }
  if (doc.terms) { lines.push(`${L.terms}:`); lines.push(doc.terms); lines.push(''); }

  const path = kind === 'invoice' ? 'i' : 'q';
  lines.push(`${L.viewOnline}: ${env.appUrl}/${path}/${doc.publicToken}`);

  return { title, lines };
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Minimal branded Typst source; compiled only when the CLI exists. */
function buildTypst(
  kind: 'invoice' | 'quote',
  doc: PdfDoc,
  items: PdfLine[],
  company: PdfCompany,
  workspace: PdfWorkspace | null | undefined,
): string {
  const cur = doc.currency;
  const L = labels(doc);
  const label = kind === 'invoice' ? L.invoice! : L.quote!;
  const rows = items
    .map(
      (it) =>
        `  [${esc(it.description)}], [${Number(it.quantity)}], [${esc(fmtMoney(it.unitPrice, cur))}], [${esc(fmtMoney(it.amount, cur))}],`,
    )
    .join('\n');
  const meta = kind === 'invoice'
    ? `${esc(L.issue!)}: ${esc(doc.issueDate)} #h(1em) ${esc(L.due!)}: ${esc(doc.dueDate ?? '')}`
    : `${esc(L.issue!)}: ${esc(doc.issueDate)} #h(1em) ${esc(L.validUntil!)}: ${esc(doc.validUntil ?? '')}`;
  const discountRow = doc.discountType && doc.discountType !== 'none' && Number(doc.discountValue ?? 0) > 0
    ? `\n#text[${esc(L.discount!)}: ${doc.discountType === 'percent' ? `${Number(doc.discountValue)}%` : esc(fmtMoney(doc.discountValue, cur))}]\\`
    : '';
  const balance = kind === 'invoice'
    ? `\n#text[${esc(L.paid!)}: ${esc(fmtMoney(doc.amountPaid ?? 0, cur))}]\\\n#text(size: 12pt, weight: "bold", fill: rgb("#283b6b"))[${esc(L.balance!)}: ${esc(fmtMoney(Number(doc.total) - Number(doc.amountPaid ?? 0), cur))}]`
    : '';
  const publicUrl = `${env.appUrl}/${kind === 'invoice' ? 'i' : 'q'}/${doc.publicToken}`;
  const wsLines = addressLines(workspace?.legalDetails).map((l) => esc(l)).join('\\ ');
  const companyLines = addressLines(company.address).map((l) => esc(l)).join('\\ ');
  return `#set page(paper: "a4", margin: (x: 2cm, y: 1.8cm))
#set text(size: 10pt, font: "Liberation Sans", fallback: true)

#grid(columns: (1fr, auto),
  [#text(size: 16pt, weight: "bold", fill: rgb("#283b6b"))[${esc(workspace?.name ?? 'ordi')}]${wsLines ? ` \\ #text(size: 8pt, fill: rgb("#6b7280"))[${wsLines}]` : ''}],
  [#align(right)[#text(size: 20pt, weight: "bold")[${label}]\\ #text(size: 12pt, fill: rgb("#6b7280"))[${esc(doc.number)}]]],
)

#line(length: 100%, stroke: 0.5pt + rgb("#283b6b"))
#v(0.8em)

#grid(columns: (1fr, 1fr),
  [#text(size: 8pt, fill: rgb("#6b7280"))[${esc(L.billTo!).toUpperCase()}]\\ #text(weight: "bold")[${esc(company.name)}]\\ ${esc(company.billingEmail ?? '')}${companyLines ? `\\ ${companyLines}` : ''}],
  [#align(right)[${meta}\\ ${esc(L.status!)}: ${esc(doc.status)}]],
)

#v(1em)
#table(columns: (1fr, auto, auto, auto),
  stroke: (x, y) => if y == 0 { (bottom: 0.5pt + rgb("#283b6b")) } else { (bottom: 0.25pt + rgb("#e5e7eb")) },
  inset: 6pt,
  [*${esc(L.description!)}*], [*${esc(L.qty!)}*], [*${esc(L.unit!)}*], [*${esc(L.amount!)}*],
${rows}
)

#align(right)[
#text[${esc(L.subtotal!)}: ${esc(fmtMoney(doc.subtotal, cur))}]\\${discountRow}
#text[${esc(L.tax!)}: ${esc(fmtMoney(doc.taxTotal, cur))}]\\
#text(size: 13pt, weight: "bold")[${esc(L.total!)}: ${esc(fmtMoney(doc.total, cur))}]${balance}
]

#v(1em)
${doc.notes ? `#text(size: 8pt, fill: rgb("#6b7280"))[${esc(L.notes!).toUpperCase()}]\\ ${esc(doc.notes)}\n#v(0.5em)` : ''}
${doc.terms ? `#text(size: 8pt, fill: rgb("#6b7280"))[${esc(L.terms!).toUpperCase()}]\\ ${esc(doc.terms)}` : ''}

#v(1fr)
#line(length: 100%, stroke: 0.25pt + rgb("#e5e7eb"))
#text(size: 8pt, fill: rgb("#6b7280"))[${esc(L.viewOnline!)}: #link("${publicUrl}")[${esc(publicUrl)}]]
`;
}

export function renderInvoicePdf(
  invoice: PdfDoc,
  items: PdfLine[],
  company: PdfCompany,
  workspace?: PdfWorkspace | null,
): Buffer {
  const typst = renderWithTypst(buildTypst('invoice', invoice, items, company, workspace));
  if (typst) return typst;
  const { title, lines } = buildLines('invoice', invoice, items, company, workspace);
  return renderSimplePdf(title, lines);
}

export function renderQuotePdf(
  quote: PdfDoc,
  items: PdfLine[],
  company: PdfCompany,
  workspace?: PdfWorkspace | null,
): Buffer {
  const typst = renderWithTypst(buildTypst('quote', quote, items, company, workspace));
  if (typst) return typst;
  const { title, lines } = buildLines('quote', quote, items, company, workspace);
  return renderSimplePdf(title, lines);
}
