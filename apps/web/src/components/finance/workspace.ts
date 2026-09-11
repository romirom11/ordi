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
  defaultCurrency?: string | null;
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

/**
 * The currency a new money record starts in. Every finance form seeds from the
 * workspace default instead of a hardcoded USD, so a UAH workspace stops
 * booking its expenses in dollars.
 */
export function useDefaultCurrency(): string {
  return useWorkspaceSettings().data?.defaultCurrency || 'USD';
}

/** Finance module is on unless explicitly disabled (missing key = enabled). */
export function financeEnabled(ws?: WorkspaceSettings): boolean {
  return ws?.modules?.finance !== false;
}
