/**
 * The image node, taught to resolve the paths uploads store.
 *
 * A document holds a root-relative path (`/api/v1/files/<id>/<token>`) rather
 * than an absolute url, so moving the instance to another domain does not break
 * every image ever embedded. That path only resolves by itself in the browser –
 * in the desktop shell it would resolve against tauri://localhost, which serves
 * the app bundle and knows nothing about files. Resolving in renderHTML fixes
 * both the editor and any HTML export in one place, and leaves the stored
 * attribute untouched because getJSON() reads attrs, not the DOM.
 */
import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import { resolveFileSrc } from '../../lib/uploads';

export const ResolvedImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const src = typeof HTMLAttributes.src === 'string' ? HTMLAttributes.src : '';
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      src: resolveFileSrc(src),
      loading: 'lazy',
    })];
  },
});
