/**
 * Toggle block – Notion's collapsible section.
 *
 * Shape: one node holding `block+`, where the FIRST child is the title and the
 * rest is the body. That beats a summary/content node pair because it keeps the
 * schema flat (one node, one content hole) and therefore lets a single NodeView
 * own both the chevron and the editable content – with two holes ProseMirror
 * allows only one contentDOM and the chevron would have to live outside the
 * node entirely.
 *
 * Collapsing hides every child but the first, via CSS on `data-open`. The state
 * is an attribute, so a collapsed toggle stays collapsed after a reload.
 */
import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggleBlock: {
      setToggleBlock: () => ReturnType;
      toggleToggleBlock: () => ReturnType;
    };
  }
}

export const ToggleBlock = Node.create({
  name: 'toggleBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.getAttribute('data-open') !== 'false',
        renderHTML: (attrs) => ({ 'data-open': attrs.open === false ? 'false' : 'true' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-toggle]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '' }), 0];
  },

  addCommands() {
    return {
      setToggleBlock: () => ({ commands }) => commands.wrapIn(this.name),
      toggleToggleBlock: () => ({ commands }) => commands.toggleWrap(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-t': () => this.editor.commands.toggleToggleBlock(),
    };
  },

  /**
   * The chevron is chrome, not content: it sits before contentDOM and is marked
   * contenteditable=false so the caret can never land in it. Clicking flips the
   * attribute through the editor, which keeps undo working.
   */
  addNodeView() {
    return ({ node, editor, getPos }) => {
      // The closure's `node` is the node as it was when the view was created;
      // ProseMirror reuses the instance and reports changes through update(),
      // so the click handler has to read the tracked copy or a second click
      // would keep writing the same value.
      let current = node;
      const dom = document.createElement('div');
      dom.setAttribute('data-toggle', '');
      dom.setAttribute('data-open', node.attrs.open === false ? 'false' : 'true');

      const chevron = document.createElement('button');
      chevron.type = 'button';
      chevron.contentEditable = 'false';
      chevron.setAttribute('data-toggle-chevron', '');
      chevron.setAttribute('aria-label', 'Toggle');
      chevron.addEventListener('mousedown', (e) => e.preventDefault());
      chevron.addEventListener('click', () => {
        if (!editor.isEditable) {
          // Read-only: still collapsible, just not recorded in the document.
          const open = dom.getAttribute('data-open') !== 'false';
          dom.setAttribute('data-open', open ? 'false' : 'true');
          return;
        }
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        editor.chain().focus(undefined, { scrollIntoView: false })
          .command(({ tr }) => {
            tr.setNodeAttribute(pos, 'open', current.attrs.open === false);
            return true;
          })
          .run();
      });

      const content = document.createElement('div');
      content.setAttribute('data-toggle-body', '');

      dom.append(chevron, content);
      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type.name !== 'toggleBlock') return false;
          current = updated;
          dom.setAttribute('data-open', updated.attrs.open === false ? 'false' : 'true');
          return true;
        },
      };
    };
  },
});
