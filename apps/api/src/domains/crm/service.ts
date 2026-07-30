/**
 * The CRM service surface, re-exported from one place so routes and workers keep
 * a single import. The implementations live per entity:
 *
 *   companies.ts  – companies, contacts, overview, portal token
 *   deals.ts      – pipeline stages, deals, stage moves
 *   leads.ts      – leads and lead → deal conversion
 *   activities.ts – sales activities
 *   work.ts       – the Work queue
 *   playbooks.ts  – message templates and manual sequences (imported directly)
 *   common.ts     – the few helpers more than one of the above needs
 *
 * This file was a 1100-line pile of all of it; the split is behaviour-neutral.
 */
export {
  listCompanies,
  createCompany,
  getCompany,
  updateCompany,
  rotatePortalToken,
  softDeleteCompany,
  companyOverview,
  listContacts,
  getContact,
  createContact,
  updateContact,
  softDeleteContact,
} from './companies';

export {
  requirePipelineStage,
  assertProjectExists,
  listDeals,
  getDeal,
  createDeal,
  updateDeal,
  moveDeal,
  softDeleteDeal,
} from './deals';

export {
  listLeads,
  getLead,
  createLead,
  updateLead,
  softDeleteLead,
  convertLead,
} from './leads';

export {
  listSalesActivities,
  nextSalesActivities,
  getSalesActivity,
  createSalesActivity,
  updateSalesActivity,
  completeSalesActivity,
  cancelSalesActivity,
} from './activities';

export { salesWork } from './work';
