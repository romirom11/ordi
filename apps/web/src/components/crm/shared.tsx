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
    'crm.conflict': 'Someone else changed this – refresh and try again.',
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
    'crm.setPrimary': 'Make primary contact',
    'crm.unsetPrimary': 'Unset primary',
    'crm.editContact': 'Edit contact',
    'crm.contactDeleted': 'Contact deleted',
    'crm.deleteContactTitle': 'Delete contact',
    'crm.deleteContactBody': 'Delete “{name}”? This cannot be undone.',
    'crm.noteDeleted': 'Note deleted',
    'crm.deleteNoteTitle': 'Delete note',
    'crm.deleteNoteBody': 'Delete this note? This cannot be undone.',
    'crm.newProjectForClient': 'New project for this client',
    'crm.linkExistingProject': 'Link existing project',
    'crm.linkProject': 'Link project',
    'crm.noUnlinkedProjects': 'Every project already has a client.',
    'crm.files': 'Files',
    'crm.uploadFile': 'Upload',
    'crm.downloadFile': 'Download',
    'crm.fileUploaded': 'File uploaded',
    'crm.uploadFailed': 'Upload failed',
    'crm.fileDeleted': 'File deleted',
    'crm.deleteFileTitle': 'Delete file',
    'crm.deleteFileBody': 'Delete “{name}”? This cannot be undone.',
    'crm.noFiles': 'No files yet',
    'crm.noFilesHint': 'Proposals, briefs and PDFs for this record live here.',
    'crm.storageNotConfigured': 'File storage is not configured (S3)',
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
    'crm.deleteClientsBody': 'Delete {n} clients and all their data? This cannot be undone.',
    'crm.openCompany': 'Open client',
    'crm.openDealNewTab': 'Open deal in new tab',
    'crm.project': 'Project',
    'crm.noProject': 'No project',
    'crm.projectUpdated': 'Project updated',
    'crm.linkProjectHint': 'Which product or delivery project is this lead for?',
    'crm.activity': 'Activity',
    'crm.noActivity': 'No activity yet',
    'crm.expectedClose': 'Expected close',
    'crm.customFields': 'Custom fields',
    'crm.moveToStage': 'Move to stage',
    'crm.dealDeleted': 'Deal deleted',
    'crm.deleteDealTitle': 'Delete deal',
    'crm.deleteDealBody': 'Delete “{name}”? This cannot be undone.',
    'crm.invoices': 'Invoices',
    'crm.newInvoice': 'New invoice',
    'crm.noInvoices': 'No invoices yet',
    'crm.noInvoicesHint': 'Invoices for this client will appear here.',
    'crm.totalOutstanding': 'Total outstanding',
    'crm.paymentTermsShort': 'Terms',
    'crm.owner': 'Owner',
    'crm.client': 'Client',
    'crm.expectedCloseShort': 'Close',
    'crm.noCloseDate': 'No date',
    'crm.openWebsite': 'Open website',
    'crm.openDealsValue': 'open',
    'crm.activity.created': 'created this client',
    'crm.activity.updated': 'updated this client',
    'crm.activity.deleted': 'deleted this client',
    'crm.activity.status_changed': 'changed the status',
    'crm.activity.note_added': 'added a note',
    'crm.activity.empty': 'No activity yet',
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
    'crm.conflict': 'Хтось інший змінив це – оновіть і спробуйте ще раз.',
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
    'crm.setPrimary': 'Зробити основним контактом',
    'crm.unsetPrimary': 'Зняти позначку основного',
    'crm.editContact': 'Редагувати контакт',
    'crm.contactDeleted': 'Контакт видалено',
    'crm.deleteContactTitle': 'Видалити контакт',
    'crm.deleteContactBody': 'Видалити «{name}»? Дію не можна скасувати.',
    'crm.noteDeleted': 'Нотатку видалено',
    'crm.deleteNoteTitle': 'Видалити нотатку',
    'crm.deleteNoteBody': 'Видалити цю нотатку? Дію не можна скасувати.',
    'crm.newProjectForClient': 'Новий проєкт для цього клієнта',
    'crm.linkExistingProject': 'Привʼязати існуючий проєкт',
    'crm.linkProject': 'Привʼязати',
    'crm.noUnlinkedProjects': 'Усі проєкти вже мають клієнта.',
    'crm.files': 'Файли',
    'crm.uploadFile': 'Завантажити',
    'crm.downloadFile': 'Скачати',
    'crm.fileUploaded': 'Файл завантажено',
    'crm.uploadFailed': 'Не вдалося завантажити',
    'crm.fileDeleted': 'Файл видалено',
    'crm.deleteFileTitle': 'Видалити файл',
    'crm.deleteFileBody': 'Видалити «{name}»? Дію не можна скасувати.',
    'crm.noFiles': 'Файлів поки немає',
    'crm.noFilesHint': 'Пропозиції, брифи та PDF цього запису живуть тут.',
    'crm.storageNotConfigured': 'Сховище файлів не налаштоване (S3)',
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
    'crm.deleteClientsBody': 'Видалити клієнтів ({n}) та всі їхні дані? Дію не можна скасувати.',
    'crm.openCompany': 'Відкрити клієнта',
    'crm.openDealNewTab': 'Відкрити угоду в новій вкладці',
    'crm.project': 'Проєкт',
    'crm.noProject': 'Без проєкту',
    'crm.projectUpdated': 'Проєкт оновлено',
    'crm.linkProjectHint': 'До якого продукту чи проєкту цей лід?',
    'crm.activity': 'Активність',
    'crm.noActivity': 'Активності поки немає',
    'crm.expectedClose': 'Очікуване закриття',
    'crm.customFields': 'Кастомні поля',
    'crm.moveToStage': 'Перемістити на етап',
    'crm.dealDeleted': 'Угоду видалено',
    'crm.deleteDealTitle': 'Видалити угоду',
    'crm.deleteDealBody': 'Видалити «{name}»? Дію не можна скасувати.',
    'crm.invoices': 'Рахунки',
    'crm.newInvoice': 'Новий рахунок',
    'crm.noInvoices': 'Рахунків поки немає',
    'crm.noInvoicesHint': 'Тут зʼявлятимуться рахунки цього клієнта.',
    'crm.totalOutstanding': 'Разом до сплати',
    'crm.paymentTermsShort': 'Оплата',
    'crm.owner': 'Відповідальний',
    'crm.client': 'Клієнт',
    'crm.expectedCloseShort': 'Закриття',
    'crm.noCloseDate': 'Без дати',
    'crm.openWebsite': 'Відкрити сайт',
    'crm.openDealsValue': 'у роботі',
    'crm.activity.created': 'створює клієнта',
    'crm.activity.updated': 'оновлює клієнта',
    'crm.activity.deleted': 'видаляє клієнта',
    'crm.activity.status_changed': 'змінює статус',
    'crm.activity.note_added': 'додає нотатку',
    'crm.activity.empty': 'Активності поки немає',
    'finance.status.draft': 'Чернетка',
    'finance.status.sent': 'Надіслано',
    'finance.status.viewed': 'Переглянуто',
    'finance.status.partially_paid': 'Частково оплачено',
    'finance.status.paid': 'Оплачено',
    'finance.status.canceled': 'Скасовано',
    'finance.status.overdue': 'Прострочено',
  },
});

extendDict({
  en: {
    'crm.tabWork': 'Work',
    'crm.tabLeads': 'Leads',
    'crm.tabCompanies': 'Companies',
    'crm.newLead': 'New lead',
    'crm.leadCreated': 'Lead created',
    'crm.importResearch': 'Import research',
    'crm.workTitle': 'What needs attention',
    'crm.workHint': 'Sales actions ordered by urgency.',
    'crm.queue.overdue': 'Overdue',
    'crm.queue.today': 'Due today',
    'crm.queue.waiting': 'Waiting for reply',
    'crm.queue.nurture': 'Nurture due',
    'crm.queue.noAction': 'No next action',
    'crm.allCaughtUp': 'No sales work needs attention.',
    'crm.leadsHint': 'Researched prospects that are not qualified opportunities yet.',
    'crm.searchLeads': 'Search leads…',
    'crm.lead': 'Lead',
    'crm.score': 'Score',
    'crm.signal': 'Signal',
    'crm.nextAction': 'Next action',
    'crm.noNextAction': 'No next action',
    'crm.scheduleAction': 'Schedule action',
    'crm.completeAction': 'Complete',
    'crm.activityType': 'Activity type',
    'crm.activityType.review': 'Review',
    'crm.activityType.outreach': 'Outreach',
    'crm.activityType.follow_up': 'Follow-up',
    'crm.activityType.call': 'Call',
    'crm.activityType.meeting': 'Meeting',
    'crm.activityType.proposal': 'Proposal',
    'crm.activityType.nurture': 'Nurture',
    'crm.activityType.other': 'Other',
    'crm.activityStatus.planned': 'Planned',
    'crm.activityStatus.completed': 'Completed',
    'crm.activityStatus.cancelled': 'Cancelled',
    'crm.dueAt': 'Due',
    'crm.channel': 'Channel',
    'crm.outcome': 'Outcome',
    'crm.context': 'Context',
    'crm.followUp': 'Schedule follow-up',
    'crm.salesHistory': 'Sales history',
    'crm.noSalesActivity': 'No sales activity yet.',
    'crm.research': 'Research',
    'crm.painSignal': 'Pain signal',
    'crm.whyFit': 'Why it fits',
    'crm.whyNow': 'Why now',
    'crm.evidence': 'Evidence',
    'crm.caution': 'Caution',
    'crm.source': 'Source',
    'crm.sourceChecked': 'Source checked',
    'crm.suggestedChannel': 'Suggested channel',
    'crm.sources': 'Supporting sources',
    'crm.noContact': 'No contact selected',
    'crm.copyOpener': 'Copy opener',
    'crm.openerCopied': 'Opener copied',
    'crm.opener': 'Opening message',
    'crm.openSource': 'Open source',
    'crm.convertToDeal': 'Convert to deal',
    'crm.converted': 'Lead converted',
    'crm.demoteToLead': 'Move to leads',
    'crm.demoted': 'Deal moved to leads',
    'crm.importPaste': 'Paste the research JSON',
    'crm.previewImport': 'Preview import',
    'crm.confirmImport': 'Import leads',
    'crm.importPreview': '{prospects} prospects · {companies} companies · {leads} leads · {exclusions} exclusions',
    'crm.imported': 'Research imported',
    'crm.invalidJson': 'This is not valid JSON.',
    'crm.importAction.skip': 'Skip duplicate',
    'crm.importAction.create_lead': 'Create lead',
    'crm.importAction.create_company_and_lead': 'Create company and lead',
    'crm.product': 'Product / service',
    'crm.company': 'Company',
    'crm.status.new': 'New',
    'crm.status.needs_review': 'Needs review',
    'crm.status.ready': 'Ready to contact',
    'crm.status.waiting_reply': 'Waiting for reply',
    'crm.status.engaged': 'Engaged',
    'crm.status.nurture': 'Nurture',
    'crm.status.converted': 'Converted',
    'crm.status.disqualified': 'Disqualified',
    'crm.status.no_response': 'No response',
    'crm.unknownValue': 'Value unknown',
    'crm.legacyLeadDeal': 'Legacy pipeline lead',
    'crm.legacyLeadDealHint': 'This record predates the Leads workspace. Keep it as a qualified deal or move it to Leads.',
    'crm.qualifiedFromLead': 'Qualified from a researched lead',
    'crm.viewResearch': 'View original research',
  },
  uk: {
    'crm.tabWork': 'Робота',
    'crm.tabLeads': 'Ліди',
    'crm.tabCompanies': 'Компанії',
    'crm.newLead': 'Новий лід',
    'crm.leadCreated': 'Лід створено',
    'crm.importResearch': 'Імпортувати ресерч',
    'crm.workTitle': 'Що потребує уваги',
    'crm.workHint': 'Наступні дії з продажів за терміновістю.',
    'crm.queue.overdue': 'Прострочено',
    'crm.queue.today': 'На сьогодні',
    'crm.queue.waiting': 'Чекаємо відповіді',
    'crm.queue.nurture': 'Повернутися до ліда',
    'crm.queue.noAction': 'Немає наступної дії',
    'crm.allCaughtUp': 'Зараз немає продажів, що потребують уваги.',
    'crm.leadsHint': 'Знайдені потенційні клієнти, які ще не стали кваліфікованими угодами.',
    'crm.searchLeads': 'Пошук лідів…',
    'crm.lead': 'Лід',
    'crm.score': 'Оцінка',
    'crm.signal': 'Сигнал',
    'crm.nextAction': 'Наступна дія',
    'crm.noNextAction': 'Наступної дії немає',
    'crm.scheduleAction': 'Запланувати дію',
    'crm.completeAction': 'Виконати',
    'crm.activityType': 'Тип дії',
    'crm.activityType.review': 'Перевірка',
    'crm.activityType.outreach': 'Перший контакт',
    'crm.activityType.follow_up': 'Повторний контакт',
    'crm.activityType.call': 'Дзвінок',
    'crm.activityType.meeting': 'Зустріч',
    'crm.activityType.proposal': 'Пропозиція',
    'crm.activityType.nurture': 'Повернення до ліда',
    'crm.activityType.other': 'Інше',
    'crm.activityStatus.planned': 'Заплановано',
    'crm.activityStatus.completed': 'Виконано',
    'crm.activityStatus.cancelled': 'Скасовано',
    'crm.dueAt': 'Коли',
    'crm.channel': 'Канал',
    'crm.outcome': 'Результат',
    'crm.context': 'Контекст',
    'crm.followUp': 'Запланувати фолоу-ап',
    'crm.salesHistory': 'Історія продажу',
    'crm.noSalesActivity': 'Дій з продажу ще немає.',
    'crm.research': 'Ресерч',
    'crm.painSignal': 'Больовий сигнал',
    'crm.whyFit': 'Чому підходить',
    'crm.whyNow': 'Чому зараз',
    'crm.evidence': 'Докази',
    'crm.caution': 'Застереження',
    'crm.source': 'Джерело',
    'crm.sourceChecked': 'Джерело перевірено',
    'crm.suggestedChannel': 'Рекомендований канал',
    'crm.sources': 'Додаткові джерела',
    'crm.noContact': 'Контакт не вибрано',
    'crm.copyOpener': 'Скопіювати повідомлення',
    'crm.openerCopied': 'Текст скопійовано',
    'crm.opener': 'Початкове повідомлення',
    'crm.openSource': 'Відкрити джерело',
    'crm.convertToDeal': 'Створити угоду',
    'crm.converted': 'Лід конвертовано',
    'crm.demoteToLead': 'Перенести в ліди',
    'crm.demoted': 'Угоду перенесено в ліди',
    'crm.importPaste': 'Вставте JSON з ресерчем',
    'crm.previewImport': 'Перевірити імпорт',
    'crm.confirmImport': 'Імпортувати ліди',
    'crm.importPreview': 'Знайдено: {prospects} · компаній: {companies} · лідів: {leads} · виключень: {exclusions}',
    'crm.imported': 'Ресерч імпортовано',
    'crm.invalidJson': 'Це невалідний JSON.',
    'crm.importAction.skip': 'Пропустити дублікат',
    'crm.importAction.create_lead': 'Створити лід',
    'crm.importAction.create_company_and_lead': 'Створити компанію та лід',
    'crm.product': 'Продукт / послуга',
    'crm.company': 'Компанія',
    'crm.status.new': 'Новий',
    'crm.status.needs_review': 'Перевірити',
    'crm.status.ready': 'Готовий до контакту',
    'crm.status.waiting_reply': 'Чекаємо відповіді',
    'crm.status.engaged': 'В діалозі',
    'crm.status.nurture': 'Відкласти',
    'crm.status.converted': 'Конвертовано',
    'crm.status.disqualified': 'Не підходить',
    'crm.status.no_response': 'Без відповіді',
    'crm.unknownValue': 'Сума невідома',
    'crm.legacyLeadDeal': 'Старий лід у пайплайні',
    'crm.legacyLeadDealHint': 'Цей запис створено до нового розділу «Ліди». Залиште як кваліфіковану угоду або перенесіть у ліди.',
    'crm.qualifiedFromLead': 'Кваліфіковано з дослідженого ліда',
    'crm.viewResearch': 'Відкрити початковий ресерч',
  },
});

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'UAH', 'PLN'];
export const COMPANY_STATUSES = ['lead', 'active', 'paused', 'archived'] as const;
export const LEAD_STATUSES = ['new', 'needs_review', 'ready', 'waiting_reply', 'engaged', 'nurture', 'converted', 'disqualified', 'no_response'] as const;
export const LEAD_ACTIVITY_OUTCOME_STATUSES = ['ready', 'waiting_reply', 'engaged', 'nurture', 'disqualified', 'no_response'] as const;
export const SALES_ACTIVITY_TYPES = ['review', 'outreach', 'follow_up', 'call', 'meeting', 'proposal', 'nurture', 'other'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export function salesActivityTypeLabel(t: (key: string, fallback?: string) => string, value: string): string {
  return t(`crm.activityType.${value}`, value.replaceAll('_', ' '));
}

export function salesActivityStatusLabel(t: (key: string, fallback?: string) => string, value: string): string {
  return t(`crm.activityStatus.${value}`, value.replaceAll('_', ' '));
}

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
  id: string; companyId?: string | null; projectId?: string | null; sourceLeadId?: string | null; title: string; stageId: string;
  amount?: string | number | null; currency?: string | null; expectedCloseDate?: string | null;
  ownerId?: string | null; lostReason?: string | null; version?: number;
}

export interface Lead {
  id: string;
  companyId: string;
  companyName?: string;
  contactId?: string | null;
  contact?: Contact | null;
  title: string;
  product?: string | null;
  status: string;
  score?: number | null;
  signal?: string | null;
  painSignal?: string | null;
  evidence?: string | null;
  whyFit?: string | null;
  whyNow?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  signalDate?: string | null;
  sourceCheckedAt?: string | null;
  suggestedChannel?: string | null;
  opener?: string | null;
  caution?: string | null;
  dimensions?: Record<string, number>;
  secondarySources?: Array<{ title: string; url: string; supports?: string }>;
  nurtureUntil?: string | null;
  disqualifiedReason?: string | null;
  ownerId?: string | null;
  convertedDealId?: string | null;
  legacyDealId?: string | null;
  createdAt?: string | null;
  version?: number;
}

export interface SalesActivity {
  id: string;
  leadId?: string | null;
  dealId?: string | null;
  companyId: string;
  contactId?: string | null;
  type: string;
  status: 'planned' | 'completed' | 'cancelled';
  channel?: string | null;
  subject?: string | null;
  context?: string | null;
  outcome?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  ownerId?: string | null;
  createdAt?: string;
  version?: number;
}

export interface SalesWorkItem {
  entityType: 'lead' | 'deal';
  id: string;
  title: string;
  companyId: string;
  companyName: string;
  status: string;
  nurtureUntil?: string | null;
  nextActivity?: SalesActivity | null;
}

export interface SalesWork {
  overdue: SalesWorkItem[];
  dueToday: SalesWorkItem[];
  waitingReply: SalesWorkItem[];
  nurtureDue: SalesWorkItem[];
  noNextAction: SalesWorkItem[];
}

export interface ProjectLite { id: string; name: string; key?: string | null }

/** Projects for deal linking – the "which offering is this lead for" dimension. */
export function useProjectsLookup() {
  return useQuery<ProjectLite[]>({
    queryKey: ['projects', 'lookup'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects').then((r) => r.data.map((p: any) => ({ id: p.id, name: p.name, key: p.key }))),
    staleTime: 5 * 60_000,
  });
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

export function useLeads(params: { q?: string; status?: string; companyId?: string } = {}) {
  return useQuery<Lead[]>({
    queryKey: ['leads', params],
    queryFn: () => api.get<{ data: Lead[] }>(`/leads${qs(params)}`).then((r) => r.data),
  });
}

export function useLead(id?: string | null, enabled = true) {
  return useQuery<Lead>({
    queryKey: ['lead', id],
    queryFn: () => api.get<Lead>(`/leads/${id!}`),
    enabled: !!id && enabled,
  });
}

export function useContacts(companyId?: string | null) {
  return useQuery<Contact[]>({
    queryKey: ['contacts', companyId],
    queryFn: () => api.get<{ data: Contact[] }>(`/contacts${qs({ companyId })}`).then((r) => r.data),
    enabled: !!companyId,
  });
}

export function useSalesActivities(params: { leadId?: string; dealId?: string; companyId?: string; status?: string }) {
  return useQuery<SalesActivity[]>({
    queryKey: ['sales-activities', params],
    queryFn: () => api.get<{ data: SalesActivity[] }>(`/sales-activities${qs(params)}`).then((r) => r.data),
  });
}

export function useSalesWork() {
  return useQuery<SalesWork>({
    queryKey: ['sales-work'],
    queryFn: () => api.get<SalesWork>('/sales-work'),
  });
}

export function useCompanies(q = '', status = '') {
  return useQuery<Company[]>({
    queryKey: ['companies', q, status],
    queryFn: () => api.get<{ data: Company[] }>(`/companies${qs({ q, status, limit: 200 })}`).then((r) => r.data),
  });
}

export { useUsersLookup } from '../../lib/queries';

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
