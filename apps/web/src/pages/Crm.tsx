/**
 * Unified CRM page: clients (companies) + deals pipeline in one place.
 * Route: /crm (also serves /companies and /deals for old links).
 * Placeholder scaffold — full implementation lands with the CRM merge feature.
 */
import { CompaniesPage } from './Companies';

export function CrmPage({ tab }: { tab?: string }) {
  void tab;
  return <CompaniesPage />;
}
