/**
 * Plain text ⇄ tiptap JSON. Rich bodies (notes, comments, KB pages) are stored
 * as a document tree; anything that has to read one as text – search snippets,
 * the MCP tools an agent reads notes through – goes through here rather than
 * re-walking the tree in each caller.
 */

/** Plain text → tiptap doc. Blank lines separate paragraphs, single newlines are hard breaks. */
export function textToDoc(text: string): Record<string, unknown> {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((para) => {
    const content: Record<string, unknown>[] = [];
    para.split('\n').forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content };
  });
  return { type: 'doc', content: paragraphs };
}

/** tiptap doc (or anything shaped like one) → plain text, block nodes separated by newlines. */
export function docToText(doc: unknown): string {
  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    lines.push(current);
    current = '';
  };
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.type === 'text' && typeof node.text === 'string') current += node.text;
    else if (node.type === 'hardBreak') { flush(); }
    else if (node.type === 'mention') current += `@${node.attrs?.label ?? node.attrs?.id ?? ''}`;
    if (Array.isArray(node.content)) {
      const block = node.type && node.type !== 'doc' && node.type !== 'text';
      for (const child of node.content) walk(child);
      if (block) flush();
    }
  };
  walk(doc);
  if (current) flush();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A window of `text` around the first match of `query`, for list rows and
 * search hits – a note is often several paragraphs, and the useful part is
 * whichever line the query landed on.
 */
export function snippet(text: string, query: string, radius = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const at = query ? flat.toLowerCase().indexOf(query.toLowerCase().trim()) : -1;
  if (at < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
