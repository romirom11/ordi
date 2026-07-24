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
  const label = kind === 'invoice' ? 'Invoice' : 'Quote';
  const title = `${label} ${doc.number}`;
  const lines: string[] = [];

  // Agency (workspace) header
  lines.push(workspace?.name ?? 'ordi');
  for (const l of addressLines(workspace?.legalDetails)) lines.push(l);
  lines.push('');

  // Bill-to
  lines.push('Bill To:');
  lines.push(company.name);
  if (company.billingEmail) lines.push(company.billingEmail);
  for (const l of addressLines(company.address)) lines.push(l);
  lines.push('');

  // Meta
  lines.push(`${label} #: ${doc.number}`);
  lines.push(`Issue date: ${doc.issueDate}`);
  if (kind === 'invoice' && doc.dueDate) lines.push(`Due date: ${doc.dueDate}`);
  if (kind === 'quote' && doc.validUntil) lines.push(`Valid until: ${doc.validUntil}`);
  lines.push(`Status: ${doc.status}`);
  lines.push('');

  // Items
  lines.push(`${col('Description', 40)}${col('Qty', 8, true)}${col('Unit', 14, true)}${col('Amount', 14, true)}`);
  lines.push(''.padEnd(76, '-'));
  for (const it of items) {
    lines.push(
      `${col(it.description, 40)}${col(String(Number(it.quantity)), 8, true)}${col(fmtMoney(it.unitPrice, cur), 14, true)}${col(fmtMoney(it.amount, cur), 14, true)}`,
    );
  }
  lines.push(''.padEnd(76, '-'));

  // Totals
  lines.push(`${col('Subtotal', 62)}${col(fmtMoney(doc.subtotal, cur), 14, true)}`);
  if (doc.discountType && doc.discountType !== 'none' && Number(doc.discountValue ?? 0) > 0) {
    const disc = doc.discountType === 'percent' ? `${Number(doc.discountValue)}%` : fmtMoney(doc.discountValue, cur);
    lines.push(`${col('Discount', 62)}${col(disc, 14, true)}`);
  }
  lines.push(`${col('Tax', 62)}${col(fmtMoney(doc.taxTotal, cur), 14, true)}`);
  lines.push(`${col('Total', 62)}${col(fmtMoney(doc.total, cur), 14, true)}`);
  if (kind === 'invoice') {
    const paid = Number(doc.amountPaid ?? 0);
    lines.push(`${col('Amount paid', 62)}${col(fmtMoney(paid, cur), 14, true)}`);
    lines.push(`${col('Balance due', 62)}${col(fmtMoney(Number(doc.total) - paid, cur), 14, true)}`);
  }
  lines.push('');

  if (doc.notes) { lines.push('Notes:'); lines.push(doc.notes); lines.push(''); }
  if (doc.terms) { lines.push('Terms:'); lines.push(doc.terms); lines.push(''); }

  const path = kind === 'invoice' ? 'i' : 'q';
  lines.push(`View online: ${env.appUrl}/${path}/${doc.publicToken}`);

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
  const label = kind === 'invoice' ? 'Invoice' : 'Quote';
  const rows = items
    .map(
      (it) =>
        `  [${esc(it.description)}], [${Number(it.quantity)}], [${esc(fmtMoney(it.unitPrice, cur))}], [${esc(fmtMoney(it.amount, cur))}],`,
    )
    .join('\n');
  const meta = kind === 'invoice'
    ? `Issue: ${esc(doc.issueDate)} #h(1em) Due: ${esc(doc.dueDate ?? '')}`
    : `Issue: ${esc(doc.issueDate)} #h(1em) Valid until: ${esc(doc.validUntil ?? '')}`;
  const balance = kind === 'invoice'
    ? `\n#text[Amount paid: ${esc(fmtMoney(doc.amountPaid ?? 0, cur))}]\\\n#text(weight: "bold")[Balance due: ${esc(fmtMoney(Number(doc.total) - Number(doc.amountPaid ?? 0), cur))}]`
    : '';
  return `#set page(paper: "a4", margin: 2cm)
#set text(size: 10pt)
#text(size: 16pt, weight: "bold")[${esc(workspace?.name ?? 'ordi')}]\\
#text(size: 20pt, weight: "bold")[${label} ${esc(doc.number)}]

#grid(columns: (1fr, 1fr),
  [*Bill To*\\ ${esc(company.name)}\\ ${esc(company.billingEmail ?? '')}],
  [${meta}\\ Status: ${esc(doc.status)}],
)

#table(columns: (1fr, auto, auto, auto),
  [*Description*], [*Qty*], [*Unit*], [*Amount*],
${rows}
)

#align(right)[
#text[Subtotal: ${esc(fmtMoney(doc.subtotal, cur))}]\\
#text[Tax: ${esc(fmtMoney(doc.taxTotal, cur))}]\\
#text(size: 12pt, weight: "bold")[Total: ${esc(fmtMoney(doc.total, cur))}]${balance}
]

${doc.notes ? `*Notes:* ${esc(doc.notes)}\\` : ''}
${doc.terms ? `*Terms:* ${esc(doc.terms)}` : ''}
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
