/**
 * Lightweight i18n (PRD §19.5): uk/en dictionaries, key-based t(), locale from
 * the user profile (users.locale) with localStorage fallback before login.
 * Dates/numbers/currency go through Intl (see fmtMoney/fmtDate in ui.tsx).
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

export type Locale = 'en' | 'uk';

type Dict = Record<string, string>;

const en: Dict = {
  // shell / nav
  'nav.dashboard': 'Dashboard',
  'nav.myTasks': 'My tasks',
  'nav.clients': 'Clients',
  'nav.deals': 'Deals',
  'nav.projects': 'Projects',
  'nav.knowledge': 'Knowledge',
  'nav.time': 'Time',
  'nav.finance': 'Finance',
  'nav.people': 'People',
  'nav.resourcing': 'Resourcing',
  'nav.dashboards': 'Dashboards',
  'nav.settings': 'Settings',
  'nav.search': 'Search',
  'nav.signOut': 'Sign out',
  // common
  'common.create': 'Create',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.saved': 'Saved.',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.add': 'Add',
  'common.send': 'Send',
  'common.close': 'Close',
  'common.name': 'Name',
  'common.status': 'Status',
  'common.actions': 'Actions',
  'common.loading': 'Loading…',
  'common.noAccess': 'You don’t have access to this section.',
  'common.nothingYet': 'Nothing yet',
  'common.today': 'Today',
  'common.total': 'Total',
  'common.search': 'Search',
  'common.all': 'All',
  'common.overdue': 'Overdue',
  'common.upcoming': 'Upcoming',
  'common.error': 'Something went wrong',
  // auth
  'auth.signIn': 'Sign in',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.totp': 'One-time code',
  // tasks
  'tasks.newTask': 'New task',
  'tasks.title': 'Task title',
  'tasks.addTask': 'Add task…',
  'tasks.list': 'List',
  'tasks.board': 'Board',
  'tasks.calendar': 'Calendar',
  'tasks.timeline': 'Timeline',
  'tasks.spreadsheet': 'Spreadsheet',
  'tasks.priority': 'Priority',
  'tasks.assignees': 'Assignees',
  'tasks.dueDate': 'Due date',
  'tasks.comments': 'Comments',
  // finance
  'finance.invoices': 'Invoices',
  'finance.quotes': 'Quotes',
  'finance.expenses': 'Expenses',
  'finance.receivables': 'Receivables',
  'finance.newInvoice': 'New invoice',
  'finance.recordPayment': 'Record payment',
  'finance.downloadPdf': 'Download PDF',
  // people
  'people.employees': 'Employees',
  'people.leave': 'Leave',
  'people.recruiting': 'Recruiting',
  'people.requestLeave': 'Request leave',
  // kb
  'kb.newPage': 'New page',
  'kb.newSpace': 'New space',
  'kb.versions': 'Version history',
  // time
  'time.myWeek': 'My week',
  'time.reports': 'Reports',
  'time.startTimer': 'Start timer',
  'time.stopTimer': 'Stop timer',
};

const uk: Dict = {
  'nav.dashboard': 'Дашборд',
  'nav.myTasks': 'Мої задачі',
  'nav.clients': 'Клієнти',
  'nav.deals': 'Угоди',
  'nav.projects': 'Проєкти',
  'nav.knowledge': 'База знань',
  'nav.time': 'Час',
  'nav.finance': 'Фінанси',
  'nav.people': 'Люди',
  'nav.resourcing': 'Завантаження',
  'nav.dashboards': 'Дашборди',
  'nav.settings': 'Налаштування',
  'nav.search': 'Пошук',
  'nav.signOut': 'Вийти',
  'common.create': 'Створити',
  'common.cancel': 'Скасувати',
  'common.save': 'Зберегти',
  'common.saved': 'Збережено.',
  'common.delete': 'Видалити',
  'common.edit': 'Редагувати',
  'common.add': 'Додати',
  'common.send': 'Надіслати',
  'common.close': 'Закрити',
  'common.name': 'Назва',
  'common.status': 'Статус',
  'common.actions': 'Дії',
  'common.loading': 'Завантаження…',
  'common.noAccess': 'У вас немає доступу до цього розділу.',
  'common.nothingYet': 'Поки нічого',
  'common.today': 'Сьогодні',
  'common.total': 'Разом',
  'common.search': 'Пошук',
  'common.all': 'Всі',
  'common.overdue': 'Прострочені',
  'common.upcoming': 'Найближчі',
  'common.error': 'Щось пішло не так',
  'auth.signIn': 'Увійти',
  'auth.email': 'Email',
  'auth.password': 'Пароль',
  'auth.totp': 'Одноразовий код',
  'tasks.newTask': 'Нова задача',
  'tasks.title': 'Назва задачі',
  'tasks.addTask': 'Додати задачу…',
  'tasks.list': 'Список',
  'tasks.board': 'Дошка',
  'tasks.calendar': 'Календар',
  'tasks.timeline': 'Таймлайн',
  'tasks.spreadsheet': 'Таблиця',
  'tasks.priority': 'Пріоритет',
  'tasks.assignees': 'Виконавці',
  'tasks.dueDate': 'Дедлайн',
  'tasks.comments': 'Коментарі',
  'finance.invoices': 'Рахунки',
  'finance.quotes': 'Пропозиції',
  'finance.expenses': 'Витрати',
  'finance.receivables': 'Дебіторка',
  'finance.newInvoice': 'Новий рахунок',
  'finance.recordPayment': 'Зафіксувати оплату',
  'finance.downloadPdf': 'Завантажити PDF',
  'people.employees': 'Співробітники',
  'people.leave': 'Відпустки',
  'people.recruiting': 'Рекрутинг',
  'people.requestLeave': 'Подати заявку',
  'kb.newPage': 'Нова сторінка',
  'kb.newSpace': 'Новий простір',
  'kb.versions': 'Історія версій',
  'time.myWeek': 'Мій тиждень',
  'time.reports': 'Звіти',
  'time.startTimer': 'Старт таймера',
  'time.stopTimer': 'Стоп таймера',
};

const DICTS: Record<Locale, Dict> = { en, uk };

interface I18n {
  locale: Locale;
  t: (key: string, fallback?: string) => string;
}

const I18nContext = createContext<I18n>({ locale: 'en', t: (k, f) => f ?? k });

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const loc: Locale = locale === 'uk' ? 'uk' : 'en';
  const value = useMemo<I18n>(() => ({
    locale: loc,
    t: (key, fallback) => DICTS[loc][key] ?? DICTS.en[key] ?? fallback ?? key,
  }), [loc]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): (key: string, fallback?: string) => string {
  return useContext(I18nContext).t;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

/** Pre-login locale (login page): browser or last-used. */
export function guessLocale(): Locale {
  try {
    const stored = localStorage.getItem('ordi:locale');
    if (stored === 'uk' || stored === 'en') return stored;
  } catch { /* ignore */ }
  return navigator.language?.startsWith('uk') ? 'uk' : 'en';
}

export function rememberLocale(locale: string): void {
  try { localStorage.setItem('ordi:locale', locale); } catch { /* ignore */ }
}
