/**
 * Markdown → tiptap doc, for showing .md files (readmes, specs, exports) as a
 * formatted document instead of raw text. It feeds the same read-only
 * renderer as notes and KB pages, so the output is a plain JSON tree – no raw
 * HTML ever reaches the page, which is what makes previewing an uploaded file
 * safe by construction.
 *
 * Deliberately a subset of CommonMark/GFM: headings, fenced code, blockquotes,
 * bullet / ordered / task lists, pipe tables, horizontal rules, and the inline
 * marks the editor itself offers (bold, italic, strike, code, links). Links
 * are kept only for http/https/mailto; images become links rather than <img>,
 * so opening a preview never fetches third-party URLs.
 */

type DocNode = Record<string, unknown>;
type Mark = { type: string; attrs?: Record<string, unknown> };

const SAFE_LINK = /^(https?:|mailto:)/i;

/* ── Inline ──────────────────────────────────────────────────────────────── */

function textNode(text: string, marks: Mark[]): DocNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text };
}

const CODE_SPAN = /^`([^`]+)`/;
const LINK = /^(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/;
const BOLD_ITALIC = /^(\*\*\*|___)(.+?)\1/;
const BOLD = /^(\*\*|__)(.+?)\1/;
const STRIKE = /^~~(.+?)~~/;
// The other emphasis char is allowed inside, so `_a **b** c_` nests.
const ITALIC = /^(?:\*([^*]+)\*|_([^_]+)_)/;

/** One line of text → text nodes with marks. Never returns raw markup. */
export function markdownInline(src: string, marks: Mark[] = []): DocNode[] {
  const out: DocNode[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) out.push(textNode(buf, marks));
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    if (src.charAt(i) === '\\' && i + 1 < src.length) {
      buf += src.charAt(i + 1);
      i += 2;
      continue;
    }
    const rest = src.slice(i);
    let m = CODE_SPAN.exec(rest);
    if (m) {
      flush();
      out.push(textNode(m[1] ?? '', [...marks, { type: 'code' }]));
      i += m[0].length;
      continue;
    }
    m = LINK.exec(rest);
    if (m) {
      flush();
      const text = m[2] ?? '';
      const href = m[3] ?? '';
      const label = text || href;
      if (SAFE_LINK.test(href)) {
        const linked: Mark[] = [...marks, { type: 'link', attrs: { href } }];
        // An image stays a link to itself: the preview must not fetch it.
        if (m[1]) out.push(textNode(label, linked));
        else out.push(...markdownInline(text, linked));
      } else {
        // javascript:, data:, relative … – keep the words, drop the link.
        out.push(...markdownInline(label, marks));
      }
      i += m[0].length;
      continue;
    }
    m = BOLD_ITALIC.exec(rest);
    if (m) {
      flush();
      out.push(...markdownInline(m[2] ?? '', [...marks, { type: 'bold' }, { type: 'italic' }]));
      i += m[0].length;
      continue;
    }
    m = BOLD.exec(rest);
    if (m) {
      flush();
      out.push(...markdownInline(m[2] ?? '', [...marks, { type: 'bold' }]));
      i += m[0].length;
      continue;
    }
    m = STRIKE.exec(rest);
    if (m) {
      flush();
      out.push(...markdownInline(m[1] ?? '', [...marks, { type: 'strike' }]));
      i += m[0].length;
      continue;
    }
    m = ITALIC.exec(rest);
    if (m) {
      flush();
      out.push(...markdownInline(m[1] ?? m[2] ?? '', [...marks, { type: 'italic' }]));
      i += m[0].length;
      continue;
    }
    buf += src.charAt(i);
    i += 1;
  }
  flush();
  return out;
}

/* ── Blocks ──────────────────────────────────────────────────────────────── */

interface ListMark {
  indent: number;
  ordered: boolean;
  task: boolean;
  checked: boolean;
  text: string;
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK_BOX = /^\[([ xX])\]\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)\s*(\S+)?\s*$/;
const HR = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^ {0,3}> ?/;
const TABLE_DIVIDER = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;

function listMark(line: string): ListMark | null {
  const m = LIST_ITEM.exec(line);
  if (!m) return null;
  // "* * *" is a rule, not a list starting with an italic marker.
  if (HR.test(line)) return null;
  const body = m[3] ?? '';
  const box = TASK_BOX.exec(body);
  return {
    indent: (m[1] ?? '').length,
    ordered: /\d/.test(m[2] ?? ''),
    task: !!box,
    checked: box ? (box[1] ?? '').toLowerCase() === 'x' : false,
    text: box ? body.slice(box[0].length) : body,
  };
}

function isBlockStart(line: string): boolean {
  return HEADING.test(line) || FENCE.test(line) || HR.test(line) || QUOTE.test(line) || !!listMark(line);
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function paragraphContent(rawLines: string[]): DocNode[] {
  const content: DocNode[] = [];
  rawLines.forEach((line, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    content.push(...markdownInline(line.trim()));
  });
  return content;
}

/** Items at one indent level; deeper lines recurse as the item's sub-blocks. */
function parseList(lines: string[], start: number): [DocNode, number] {
  const first = listMark(lines[start] ?? '') as ListMark;
  const { indent, ordered, task } = first;
  const items: { text: string[]; sub: string[]; checked: boolean }[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) break;
    const m = listMark(line);
    const last = items[items.length - 1];
    if (m && m.indent === indent && m.ordered === ordered) {
      items.push({ text: [m.text], sub: [], checked: m.checked });
    } else if (m && m.indent > indent && last) {
      last.sub.push(line);
    } else if (!m && /^\s/.test(line) && last) {
      // Lazy continuation of the previous item's text.
      last.text.push(line.trim());
    } else {
      break;
    }
    i += 1;
  }
  const node: DocNode = {
    type: task ? 'taskList' : ordered ? 'orderedList' : 'bulletList',
    content: items.map((item) => ({
      type: task ? 'taskItem' : 'listItem',
      ...(task ? { attrs: { checked: item.checked } } : {}),
      content: [
        { type: 'paragraph', content: paragraphContent(item.text) },
        ...parseBlocks(item.sub),
      ],
    })),
  };
  return [node, i];
}

function parseBlocks(lines: string[]): DocNode[] {
  const out: DocNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      out.push({
        type: 'codeBlock',
        attrs: { language: fence[2] ?? '' },
        content: body.length ? [{ type: 'text', text: body.join('\n') }] : [],
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      // The editor offers levels 1–3; deeper markdown headings clamp to 3.
      out.push({
        type: 'heading',
        attrs: { level: Math.min((heading[1] ?? '#').length, 3) },
        content: markdownInline((heading[2] ?? '').trim()),
      });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push({ type: 'horizontalRule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(QUOTE, ''));
        i += 1;
      }
      out.push({ type: 'blockquote', content: parseBlocks(inner) });
      continue;
    }

    if (line.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(splitRow(lines[i] ?? ''));
        i += 1;
      }
      const cell = (type: string, text: string): DocNode => ({
        type,
        content: [{ type: 'paragraph', content: markdownInline(text) }],
      });
      out.push({
        type: 'table',
        content: [
          { type: 'tableRow', content: header.map((c) => cell('tableHeader', c)) },
          ...rows.map((r) => ({
            type: 'tableRow',
            content: header.map((_, ci) => cell('tableCell', r[ci] ?? '')),
          })),
        ],
      });
      continue;
    }

    if (listMark(line)) {
      const [node, next] = parseList(lines, i);
      out.push(node);
      i = next;
      continue;
    }

    // Paragraph: consecutive lines until a blank line or another block opens.
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && (lines[i] ?? '').trim() && !isBlockStart(lines[i] ?? '')) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    out.push({ type: 'paragraph', content: paragraphContent(para) });
  }
  return out;
}

/** Markdown text → tiptap doc renderable by the app's read-only renderer. */
export function markdownToDoc(md: string): DocNode {
  return { type: 'doc', content: parseBlocks(md.replace(/\r\n/g, '\n').split('\n')) };
}
