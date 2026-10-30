/**
 * Which sidebar destination a route belongs to.
 *
 * CRM records live at their own top-level URLs (/companies/:id, /leads/:id,
 * /deals/:id) rather than under /crm, so a plain "path starts with the nav
 * item's url" test left the sidebar with nothing selected on every CRM detail
 * page. Those segments are mapped back to /crm here, once, for the sidebar's
 * highlight and its aria-current.
 */
const OWNER_OF_SEGMENT: Record<string, string> = {
  companies: '/crm',
  leads: '/crm',
  deals: '/crm',
};

/** True when `path` is inside the sidebar destination `navTo`. */
export function isNavActive(navTo: string, path: string): boolean {
  const clean = path.split(/[?#]/)[0]!;
  if (navTo === '/') return clean === '/';
  const owner = OWNER_OF_SEGMENT[clean.split('/')[1] ?? ''];
  if (owner) return navTo === owner;
  return clean === navTo || clean.startsWith(`${navTo}/`);
}
