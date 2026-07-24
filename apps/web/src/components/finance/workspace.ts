/**
 * Shared workspace-settings access for finance-facing pages.
 * Exposes the branding (logo + invoiceSettings) consumed by the invoice
 * document views and the `modules.finance` flag used to gate finance UI on the
 * company page. Backed by the ['workspace-settings'] query so it is shared with
 * the rest of the app (Shell, Settings).
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export interface InvoiceSettings {
  accentColor?: string | null;
  footerNote?: string | null;
  paymentDetails?: string | null;
  showLogo?: boolean;
}

export interface WorkspaceSettings {
  id?: string;
  name?: string | null;
  logo?: string | null;
  modules?: Record<string, boolean>;
  invoiceSettings?: InvoiceSettings;
}

export function useWorkspaceSettings() {
  return useQuery<WorkspaceSettings>({
    queryKey: ['workspace-settings'],
    queryFn: () => api.get<WorkspaceSettings>('/settings/workspace'),
    staleTime: 5 * 60_000,
  });
}

/** Finance module is on unless explicitly disabled (missing key = enabled). */
export function financeEnabled(ws?: WorkspaceSettings): boolean {
  return ws?.modules?.finance !== false;
}
