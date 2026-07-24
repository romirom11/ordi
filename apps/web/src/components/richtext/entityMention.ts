/**
 * "#" entity references for the Tiptap editor (Linear-style).
 *
 * A second suggestion trigger (besides "@" user mentions in mention.ts):
 * typing "#" searches GET /search?q= (tasks, KB pages, companies, invoices)
 * and inserts an `entityMention` node — Mention.extend with its own char,
 * storing { id, kind, url, label }. Rendered as a clickable `.ordi-ref` chip;
 * click navigation is handled by delegated onClick on the prose containers
 * (RichEditor / RichText / RichBody).
 */
import Mention, { type MentionOptions } from '@tiptap/extension-mention';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer, mergeAttributes, type Editor } from '@tiptap/react';
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { api } from '../../lib/api';
import { EntityMentionMenu, type EntityItem, type EntityMenuRef } from './EntityMentionMenu';

export interface EntityMentionAttrs {
  id: string;
  label: string;
  kind: string;
  url: string;
}

/** Node: like Mention but with kind + url attrs and its own name/class. */
export const EntityMention = Mention.extend<MentionOptions<EntityItem, EntityMentionAttrs>>({
  name: 'entityMention',

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-id'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.id ? { 'data-id': attrs.id } : {}),
      },
      label: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.label ? { 'data-label': attrs.label } : {}),
      },
      kind: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-kind'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.kind ? { 'data-kind': attrs.kind } : {}),
      },
      url: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-url'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.url ? { 'data-url': attrs.url } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="entity-mention"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'entity-mention' }, this.options.HTMLAttributes, HTMLAttributes),
      String(node.attrs.label ?? node.attrs.id ?? ''),
    ];
  },

  renderText({ node }) {
    return String(node.attrs.label ?? node.attrs.id ?? '');
  },
});

async function searchEntities(query: string): Promise<EntityItem[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await api.get<{ data: EntityItem[] }>(`/search?q=${encodeURIComponent(q)}`);
    return (res.data ?? []).filter((r) => r.url).slice(0, 8);
  } catch {
    return [];
  }
}

type EntitySuggestion = Omit<SuggestionOptions<EntityItem, EntityMentionAttrs>, 'editor'>;

/** Position the ReactRenderer element (fixed) from the current caret rect. */
function place(el: HTMLElement, rect: DOMRect | null): void {
  if (!rect) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const width = el.offsetWidth || 272;
  const height = el.offsetHeight || 200;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export const entityMentionSuggestion: EntitySuggestion = {
  char: '#',
  pluginKey: new PluginKey('entityMentionSuggestion'),
  allowSpaces: true,
  items: ({ query }) => searchEntities(query),
  command: ({ editor, range, props }) => {
    // Insert the entity node + trailing space (mirrors Mention's default).
    editor
      .chain()
      .focus()
      .insertContentAt(range, [
        { type: 'entityMention', attrs: { id: props.id, label: props.label, kind: props.kind, url: props.url } },
        { type: 'text', text: ' ' },
      ])
      .run();
  },
  render: () => {
    let renderer: ReactRenderer<EntityMenuRef> | null = null;

    const toProps = (props: SuggestionProps<EntityItem, EntityMentionAttrs>) => ({
      items: props.items ?? [],
      query: props.query ?? '',
      command: (item: EntityItem) =>
        props.command({ id: item.id, label: item.title, kind: item.kind, url: item.url }),
    });

    return {
      onStart: (props) => {
        renderer = new ReactRenderer(EntityMentionMenu, {
          editor: props.editor as Editor,
          props: toProps(props),
        });
        const el = renderer.element as HTMLElement;
        el.style.position = 'fixed';
        el.style.zIndex = '60';
        document.body.appendChild(el);
        place(el, props.clientRect?.() ?? null);
      },
      onUpdate: (props) => {
        renderer?.updateProps(toProps(props));
        if (renderer) place(renderer.element as HTMLElement, props.clientRect?.() ?? null);
      },
      onKeyDown: (props: SuggestionKeyDownProps) => {
        if (props.event.key === 'Escape') {
          renderer?.element.remove();
          renderer?.destroy();
          renderer = null;
          return true;
        }
        return renderer?.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        renderer?.element.remove();
        renderer?.destroy();
        renderer = null;
      },
    };
  },
};
