/**
 * Read-only tiptap rendering for comments and previews.
 *
 * Kept as its own module because a dozen call sites import it, but it is a thin
 * pass-through to richtext/RichText. It used to be a SECOND renderer with its
 * own switch statement, which meant every block added to the editor had to be
 * taught twice – and the copies had already drifted (this one never learned
 * tables, callouts, colour or highlighting). One renderer, one behaviour.
 */
import { RichText } from '../richtext/RichText';

export function RichBody({ doc, className }: { doc: unknown; className?: string }) {
  // RichText treats anything without visible content as empty and renders
  // nothing; the old implementation additionally required a `doc` root, so
  // preserve that check for callers relying on it.
  const root = doc as { type?: string } | null;
  if (!root || root.type !== 'doc') return null;
  return <RichText doc={doc} className={className} />;
}
