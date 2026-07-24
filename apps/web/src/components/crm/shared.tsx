/**
 * Shared CRM primitives: types, i18n keys, status meta, and data hooks used by
 * the Clients table, the Pipeline kanban and the Company detail page.
 */
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';
import { extendDict, useT } from '../../lib/i18n';
import { cn } from '../ui';

extendDict({
  en: {
    'crm.title': 'CRM',
    'crm.subtitleUnified': 'Clients and deal pipeline in one place',
    'crm.tabClients': 'Clients',
    'crm.tabPipeline': 'Pipeline',
    'crm.newDeal': 'New deal',
    'crm.deals': 'Deals',
    'crm.deal': 'Deal',
    'crm.openDeals': 'Open deals',
    'crm.pipelineValue': 'Pipeline value',
    'crm.status.lead': 'Lead',
    'crm.status.active': 'Active',
    'crm.status.paused': 'Paused',
    'crm.status.archived': 'Archived',
    'crm.colDomain': 'Domain',
    'crm.colDeals': 'Deals',
    'crm.noDomain': 'No domain',
    'crm.noOwner': 'Unassigned',
    'crm.weightedShort': 'weighted',
    'crm.wonColumn': 'Won',
    'crm.lostColumn': 'Lost',
    'crm.dropHere': 'Drop deal here',
    'crm.lostReasonTitle': 'Mark deal as lost',
    'crm.lostReasonLabel': 'Reason (optional)',
    'crm.lostReasonPlaceholder': 'Budget, timing, competitor…',
    'crm.markLost': 'Mark as lost',
    'crm.moved': 'Deal moved',
    'crm.dealCreated': 'Deal created',
    'crm.clientCreated': 'Client created',
    'crm.conflict': 'Someone else changed this — refresh and try again.',
    'crm.editName': 'Edit name',
    'crm.changeOwner': 'Change owner',
    'crm.changeStatus': 'Change status',
    'crm.properties': 'Properties',
    'crm.billingEmail': 'Billing email',
    'crm.paymentTerms': 'Payment terms',
    'crm.paymentTermsValue': '{n} days',
    'crm.created': 'Created',
    'crm.linkedProjects': 'Projects',
    'crm.contacts': 'Contacts',
    'crm.notes': 'Notes',
    'crm.overview': 'Overview',
    'crm.addDealForClient': 'New deal',
    'crm.noOpenDeals': 'No open deals',
    'crm.pinNote': 'Pin',
    'crm.unpinNote': 'Unpin',
    'crm.pinned': 'Pinned',
    'crm.saveNote': 'Save note',
    'crm.contactEmail': 'Email contact',
    'crm.contactCall': 'Call contact',
    'crm.primary': 'Primary',
    'crm.position': 'Position',
    'crm.phone': 'Phone',
    'crm.backToCrm': 'CRM',
    'crm.noProjects': 'No projects yet',
    'crm.viewProject': 'Open project',
    'crm.nameUpdated': 'Name updated',
    'crm.ownerUpdated': 'Owner updated',
    'crm.statusUpdated': 'Status updated',
    'crm.searchDeals': 'Search deals…',
    'crm.clientCount': '{n} clients',
    'crm.openInNewTab': 'Open in new tab',
    'crm.copyLink': 'Copy link',
    'crm.linkCopied': 'Link copied',
    'crm.clientDeleted': 'Client deleted',
    'crm.deleteClientTitle': 'Delete client',
    'crm.deleteClientBody': 'Delete “{name}” and all its data? This cannot be undone.',
    'crm.openCompany': 'Open client',
    'crm.moveToStage': 'Move to stage',
    'crm.dealDeleted': 'Deal deleted',
    'crm.deleteDealTitle': 'Delete deal',
    'crm.deleteDealBody': 'Delete “{name}”? This cannot be undone.',
    'crm.invoices': 'Invoices',
    'crm.newInvoice': 'New invoice',
    'crm.noInvoices': 'No invoices yet',
    'crm.noInvoicesHint': 'Invoices for this client will appear here.',
    'crm.totalOutstanding': 'Total outstanding',
    'finance.status.draft': 'Draft',
    'finance.status.sent': 'Sent',
    'finance.status.viewed': 'Viewed',
    'finance.status.partially_paid': 'Partially paid',
    'finance.status.paid': 'Paid',
    'finance.status.canceled': 'Canceled',
    'finance.status.overdue': 'Overdue',
  },
  uk: {
    'crm.title': 'CRM',
    'crm.subtitleUnified': 'Клієнти та пайплайн угод в одному місці',
    'crm.tabClients': 'Клієнти',
    'crm.tabPipeline': 'Пайплайн',
    'crm.newDeal': 'Нова угода',
    'crm.deals': 'Угоди',
    'crm.deal': 'Угода',
    'crm.openDeals': 'Відкриті угоди',
    'crm.pipelineValue': 'Сума пайплайну',
    'crm.status.lead': 'Лід',
    'crm.status.active': 'Активний',
    'crm.status.paused': 'Призупинено',
    'crm.status.archived': 'Архів',
    'crm.colDomain': 'Домен',
    'crm.colDeals': 'Угоди',
    'crm.noDomain': 'Без домену',
    'crm.noOwner': 'Без відповідального',
    'crm.weightedShort': 'зважено',
    'crm.wonColumn': 'Виграно',
    'crm.lostColumn': 'Програно',
    'crm.dropHere': 'Перетягніть угоду сюди',
    'crm.lostReasonTitle': 'Позначити угоду як програну',
    'crm.lostReasonLabel': 'Причина (необовʼязково)',
    'crm.lostReasonPlaceholder': 'Бюджет, терміни, конкурент…',
    'crm.markLost': 'Позначити програною',
    'crm.moved': 'Угоду переміщено',
    'crm.dealCreated': 'Угоду створено',
    'crm.clientCreated': 'Клієнта створено',
    'crm.conflict': 'Хтось інший змінив це — оновіть і спробуйте ще раз.',
    'crm.editName': 'Редагувати назву',
    'crm.changeOwner': 'Змінити відповідального',
    'crm.changeStatus': 'Змінити статус',
    'crm.properties': 'Властивості',
    'crm.billingEmail': 'Email для рахунків',
    'crm.paymentTerms': 'Умови оплати',
    'crm.paymentTermsValue': '{n} дн.',
    'crm.created': 'Створено',
    'crm.linkedProjects': 'Проєкти',
    'crm.contacts': 'Контакти',
    'crm.notes': 'Нотатки',
    'crm.overview': 'Огляд',
    'crm.addDealForClient': 'Нова угода',
    'crm.noOpenDeals': 'Немає відкритих угод',
    'crm.pinNote': 'Закріпити',
    'crm.unpinNote': 'Відкріпити',
    'crm.pinned': 'Закріплено',
    'crm.saveNote': 'Зберегти нотатку',
    'crm.contactEmail': 'Написати контакту',
    'crm.contactCall': 'Зателефонувати',
    'crm.primary': 'Основний',
    'crm.position': 'Посада',
    'crm.phone': 'Телефон',
    'crm.backToCrm': 'CRM',
    'crm.noProjects': 'Проєктів поки немає',
    'crm.viewProject': 'Відкрити проєкт',
    'crm.nameUpdated': 'Назву оновлено',
    'crm.ownerUpdated': 'Відповідального оновлено',
    'crm.statusUpdated': 'Статус оновлено',
    'crm.searchDeals': 'Пошук угод…',
    'crm.clientCount': 'клієнтів: {n}',
    'crm.openInNewTab': 'Відкрити в новій вкладці',
    'crm.copyLink': 'Скопіювати посилання',
    'crm.linkCopied': 'Посилання скопійовано',
    'crm.clientDeleted': 'Клієнта видалено',
    'crm.deleteClientTitle': 'Видалити клієнта',
    'crm.deleteClientBody': 'Видалити «{name}» та всі його дані? Дію не можна скасувати.',
    'crm.openCompany': 'Відкрити клієнта',
    'crm.moveToStage': 'Перемістити на етап',
    'crm.dealDeleted': 'Угоду видалено',
    'crm.deleteDealTitle': 'Видалити угоду',
    'crm.deleteDealBody': 'Видалити «{name}»? Дію не можна скасувати.',
    'crm.invoices': 'Рахунки',
    'crm.newInvoice': 'Новий рахунок',
    'crm.noInvoices': 'Рахунків поки немає',
    'crm.noInvoicesHint': 'Тут зʼявлятимуться рахунки цього клієнта.',
    'crm.totalOutstanding': 'Разом до сплати',
    'finance.status.draft': 'Чернетка',
    'finance.status.sent': 'Надіслано',
    'finance.status.viewed': 'Переглянуто',
    'finance.status.partially_paid': 'Частково оплачено',
    'finance.status.paid': 'Оплачено',
    'finance.status.canceled': 'Скасовано',
    'finance.status.overdue': 'Прострочено',
  },
});

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'UAH', 'PLN'];
export const COMPANY_STATUSES = ['lead', 'active', 'paused', 'archived'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/* Status colour semantics (brief): lead=warning, active=success, paused/archived=faint. */
export const STATUS_TEXT: Record<string, string> = {
  lead: 'text-warning',
  active: 'text-success',
  paused: 'text-faint',
  archived: 'text-faint',
};
export const STATUS_DOT: Record<string, string> = {
  lead: 'bg-warning',
  active: 'bg-success',
  paused: 'bg-faint',
  archived: 'bg-faint',
};

export interface Company {
  id: string;
  name: string;
  domain?: string | null;
  status: string;
  ownerId?: string | null;
  billingEmail?: string | null;
  defaultCurrency?: string | null;
  paymentTermsDays?: number | null;
  createdAt?: string | null;
  version?: number;
}
export interface Stage {
  id: string; name: string; position: number; probability: number; isWon: boolean; isLost: boolean;
}
export interface Deal {
  id: string; companyId?: string | null; title: string; stageId: string;
  amount?: string | number | null; currency?: string | null; expectedCloseDate?: string | null;
  ownerId?: string | null; lostReason?: string | null; version?: number;
}
export interface Contact {
  id: string; firstName?: string | null; lastName?: string | null; email?: string | null;
  phone?: string | null; position?: string | null; isPrimary?: boolean;
}
export interface UserLite { id: string; name: string; avatar?: string | null }

export function useDealStages() {
  return useQuery<Stage[]>({
    queryKey: ['deal-stages'],
    queryFn: () => api.get<{ data: Stage[] }>('/deal-stages').then((r) => r.data),
    select: (rows) => rows.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    staleTime: 5 * 60_000,
  });
}

export function useAllDeals() {
  return useQuery<Deal[]>({
    queryKey: ['deals'],
    queryFn: () => api.get<{ data: Deal[] }>('/deals').then((r) => r.data),
  });
}

export function useCompanies(q = '', status = '') {
  return useQuery<Company[]>({
    queryKey: ['companies', q, status],
    queryFn: () => api.get<{ data: Company[] }>(`/companies${qs({ q, status, limit: 200 })}`).then((r) => r.data),
  });
}

export function useUsersLookup() {
  return useQuery<UserLite[]>({
    queryKey: ['users-lookup'],
    queryFn: () => api.get<{ data: UserLite[] }>('/users/lookup').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const t = useT();
  const label = t(`crm.status.${status}`, status);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', STATUS_TEXT[status] ?? 'text-faint', className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status] ?? 'bg-faint')} />
      {label}
    </span>
  );
}
