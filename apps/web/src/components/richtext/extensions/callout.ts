/**
 * Callout block – the boxed aside Notion uses for notes and warnings.
 *
 * A plain wrapper around `block+` rather than a leaf with a text attribute, so
 * anything can live inside one: lists, code, another paragraph. The tone picks
 * the accent colour and the icon; both are drawn from CSS (richtext.css) so the
 * read-only renderer needs no logic of its own to match the editor.
 */
import { Node, mergeAttributes } from '@tiptap/core';

export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (tone?: CalloutTone) => ReturnType;
      toggleCallout: (tone?: CalloutTone) => ReturnType;
      unsetCallout: () => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  // defining: pasting into an empty callout keeps the callout instead of
  // replacing it, which is what "wrap" blocks are expected to do.
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: 'info' as CalloutTone,
        parseHTML: (el) => {
          const tone = el.getAttribute('data-tone');
          return (CALLOUT_TONES as readonly string[]).includes(tone ?? '') ? tone : 'info';
        },
        renderHTML: (attrs) => ({ 'data-tone': String(attrs.tone ?? 'info') }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0];
  },

  addCommands() {
    return {
      setCallout: (tone = 'info') => ({ commands }) => commands.wrapIn(this.name, { tone }),
      toggleCallout: (tone = 'info') => ({ commands }) => commands.toggleWrap(this.name, { tone }),
      unsetCallout: () => ({ commands }) => commands.lift(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-c': () => this.editor.commands.toggleCallout(),
    };
  },
});
