/**
 * PDF rendering (PRD §11.3). Uses the Typst CLI when available for the branded
 * template; otherwise falls back to a dependency-free minimal PDF writer so the
 * endpoint always returns a valid PDF. Artifacts are stored immutably in S3 by
 * the caller.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function escapePdfText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Build a valid single/multi-page PDF from text lines (no external deps). */
export function renderSimplePdf(title: string, lines: string[]): Buffer {
  const allLines = [title, ''.padEnd(0), ...lines];
  const perPage = 48;
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += perPage) pages.push(allLines.slice(i, i + perPage));
  if (!pages.length) pages.push([title]);

  const objects: string[] = [];
  const fontObj = 4 + pages.length * 2; // font after pages+contents

  // Build content streams first (obj ids: page i => 4 + i*2 ; content => 5 + i*2)
  const pageObjIds: number[] = [];
  const contentObjs: { id: number; body: string }[] = [];
  pages.forEach((pageLines, i) => {
    const pageId = 4 + i * 2;
    const contentId = 5 + i * 2;
    pageObjIds.push(pageId);
    let text = 'BT /F1 11 Tf 50 780 Td 14 TL\n';
    for (const line of pageLines) text += `(${escapePdfText(line)}) Tj T*\n`;
    text += 'ET';
    contentObjs.push({ id: contentId, body: text });
  });

  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageObjIds.length} >>`;
  objects[3] = ``; // reserved
  pages.forEach((_pl, i) => {
    const pageId = 4 + i * 2;
    const contentId = 5 + i * 2;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentId} 0 R >>`;
    const c = contentObjs.find((x) => x.id === contentId)!;
    objects[contentId] = `<< /Length ${c.body.length} >>\nstream\n${c.body}\nendstream`;
  });
  objects[fontObj] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  const maxId = fontObj;
  for (let id = 1; id <= maxId; id++) {
    if (!objects[id]) { objects[id] = `<< >>`; }
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/** Render via Typst if the CLI is present, else null (caller uses fallback). */
export function renderWithTypst(typstSource: string): Buffer | null {
  try {
    const probe = spawnSync('typst', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) return null;
    const dir = mkdtempSync(join(tmpdir(), 'ordi-pdf-'));
    const src = join(dir, 'doc.typ');
    const out = join(dir, 'doc.pdf');
    writeFileSync(src, typstSource, 'utf8');
    const res = spawnSync('typst', ['compile', src, out], { encoding: 'utf8' });
    if (res.status !== 0) { rmSync(dir, { recursive: true, force: true }); return null; }
    const buf = readFileSync(out);
    rmSync(dir, { recursive: true, force: true });
    return buf;
  } catch {
    return null;
  }
}
