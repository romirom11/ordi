/**
 * Plain text ⇄ tiptap JSON. Rich bodies (notes, comments, KB pages) are stored
 * as a document tree; anything that has to read one as text – search snippets,
 * the MCP tools an agent reads notes through – goes through here rather than
 * re-walking the tree in each caller.
 */

/**
 * A line that is exactly one embedded image, in the markdown form docToText
 * emits. Only a whole line counts: an image is a block node in the editor
 * schema, so a marker inside a sentence stays ordinary text.
 */
const IMAGE_LINE = /^!\[([^\]]*)\]\((\S+)\)$/;

/** Plain text → tiptap doc. Blank lines separate paragraphs, single newlines are hard breaks. */
export function textToDoc(text: string): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [];
  for (const chunk of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    let inline: Record<string, unknown>[] = [];
    let open = false;
    const endParagraph = (): void => {
      blocks.push({ type: 'paragraph', content: inline });
      inline = [];
      open = false;
    };
    for (const line of chunk.split('\n')) {
      const image = IMAGE_LINE.exec(line.trim());
      if (image) {
        if (open) endParagraph();
        blocks.push({ type: 'image', attrs: { src: image[2], alt: image[1] || null } });
        continue;
      }
      if (open) inline.push({ type: 'hardBreak' });
      if (line) inline.push({ type: 'text', text: line });
      open = true;
    }
    if (open) endParagraph();
  }
  return { type: 'doc', content: blocks };
}

/**
 * tiptap doc (or anything shaped like one) → plain text, block nodes separated
 * by newlines and top-level blocks by a blank line, so that
 * `docToText(textToDoc(t))` gives `t` back: an agent that reads a body, edits a
 * sentence and writes it back must not lose the paragraph structure on the way
 * through. Nested blocks (list items, table cells) stay one line each.
 *
 * An embedded image becomes an `![name](url)` line, which textToDoc turns back
 * into an image node – without it, a screenshot pasted into a bug report would
 * be invisible to an agent reading the card, and silently destroyed the first
 * time the agent rewrote the body.
 */
export function docToText(doc: unknown): string {
  const lines: string[] = [];
  let current = '';
  const flush = (): void => {
    lines.push(current);
    current = '';
  };
  const walk = (node: any, depth: number): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth);
      return;
    }
    if (node.type === 'text' && typeof node.text === 'string') current += node.text;
    else if (node.type === 'hardBreak') { flush(); }
    else if (node.type === 'mention') current += `@${node.attrs?.label ?? node.attrs?.id ?? ''}`;
    else if (node.type === 'image') {
      if (current) flush();
      current = `![${node.attrs?.alt ?? ''}](${node.attrs?.src ?? ''})`;
      flush();
      if (depth === 1) lines.push('');
    }
    if (Array.isArray(node.content)) {
      const block = node.type && node.type !== 'doc' && node.type !== 'text';
      for (const child of node.content) walk(child, depth + 1);
      if (block) {
        flush();
        if (depth === 1) lines.push('');
      }
    }
  };
  walk(doc, 0);
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
