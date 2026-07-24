/**
 * Delegated click handler for "#" entity-reference chips inside a prose
 * container. Shared by RichEditor, the read-only RichText renderer and the
 * task RichBody so every surface navigates the same way: plain click routes
 * in-app, Ctrl/Cmd+click opens an in-app new tab (when the tabs provider is
 * mounted).
 */
import { useContext, type MouseEvent } from 'react';
import { NewTabContext, useNavigate } from '../../lib/router';

export function useEntityRefClick(): (e: MouseEvent<HTMLElement>) => void {
  const navigate = useNavigate();
  const openInNewTab = useContext(NewTabContext);
  return (e) => {
    const target = e.target as HTMLElement | null;
    const el = target?.closest?.('[data-type="entity-mention"]');
    if (!el) return;
    const url = el.getAttribute('data-url');
    if (!url) return;
    e.preventDefault();
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && openInNewTab) openInNewTab(url);
    else navigate(url);
  };
}
