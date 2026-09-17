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

/** A person a text can address: `@label` in the text becomes a mention node carrying the id. */
export interface DocMention { id: string; label: string }

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One line of text into inline nodes, with every `@label` of a known mention
 * turned into a mention node (longest label first, so "Roman Kudin" is not
 * cut into "Roman" + " Kudin"). `used` collects the ids the line addressed.
 */
function inlineNodes(line: string, mentions: DocMention[], used: Set<string>): Record<string, unknown>[] {
  if (!mentions.length) return [{ type: 'text', text: line }];
  const labels = [...mentions].sort((a, b) => b.label.length - a.label.length).map((m) => escapeRegExp(m.label));
  // Not inside a word on either side: mail@Roman.example is an address, @Romanov is someone else.
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])@(${labels.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  const nodes: Record<string, unknown>[] = [];
  let at = 0;
  for (const m of line.matchAll(re)) {
    const mention = mentions.find((x) => x.label === m[1])!;
    if (m.index! > at) nodes.push({ type: 'text', text: line.slice(at, m.index) });
    nodes.push({ type: 'mention', attrs: { id: mention.id, label: mention.label } });
    used.add(mention.id);
    at = m.index! + m[0].length;
  }
  if (at < line.length) nodes.push({ type: 'text', text: line.slice(at) });
  return nodes;
}

/**
 * Plain text → tiptap doc. Blank lines separate paragraphs, single newlines
 * are hard breaks. With `mentions`, `@label` in the text becomes a real
 * mention (the chip in the editor, the notification on the server); a
 * mentioned person the text never names is put at the start, so a caller
 * that passes an id always addresses them.
 */
export function textToDoc(text: string, opts: { mentions?: DocMention[] } = {}): Record<string, unknown> {
  const mentions = (opts.mentions ?? []).filter((m) => m.id && m.label);
  const used = new Set<string>();
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
      if (line) inline.push(...inlineNodes(line, mentions, used));
      open = true;
    }
    if (open) endParagraph();
  }
  const unnamed = mentions.filter((m) => !used.has(m.id));
  if (unnamed.length) {
    const lead: Record<string, unknown>[] = unnamed.flatMap((m) => [{ type: 'mention', attrs: { id: m.id, label: m.label } }, { type: 'text', text: ' ' }]);
    const first = blocks.find((b) => b.type === 'paragraph') as { content: Record<string, unknown>[] } | undefined;
    if (first) first.content.unshift(...lead);
    else blocks.unshift({ type: 'paragraph', content: lead });
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
