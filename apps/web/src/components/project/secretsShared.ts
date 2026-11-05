/**
 * What the secret dialog, panel and resource rows share: the API shapes, the
 * wording in both languages, and the small judgements (expiry, environment
 * colour) they must agree on.
 */
import { extendDict } from '../../lib/i18n';

export type SecretEnvironment = 'test' | 'staging' | 'production' | 'other';
export type SecretFieldType = 'text' | 'url' | 'password' | 'api_key' | 'note';
export type AudiencePrincipal = { type: 'project' } | { type: 'user'; id: string } | { type: 'department'; id: string };

export interface SecretFieldMeta {
  key: string; label: string; type: SecretFieldType; hasValue: boolean;
  /** url / text only. */
  value?: string;
  /** api_key only: last four characters. */
  hint?: string;
}

export interface SecretView {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  environment: SecretEnvironment;
  expiresAt: string | null;
  availableToAgents: boolean;
  fields: SecretFieldMeta[];
  audience: AudiencePrincipal[];
  lastRevealedAt: string | null;
  lastRevealedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  version: number;
  access: { reveal: boolean; write: boolean; manage: boolean };
}

export const SECRET_ENVIRONMENTS: SecretEnvironment[] = ['test', 'staging', 'production', 'other'];
export const SECRET_FIELD_TYPES: SecretFieldType[] = ['text', 'url', 'password', 'api_key', 'note'];
export const isSecretValueType = (t: SecretFieldType) => t === 'password' || t === 'api_key' || t === 'note';

export const ENV_TONE: Record<SecretEnvironment, string> = {
  test: 'bg-success/15 text-success',
  staging: 'bg-warning/15 text-warning',
  production: 'bg-destructive/15 text-destructive',
  other: 'bg-muted text-muted-foreground',
};

/** Days until the credential stops working; negative once it has. */
export function daysUntil(date: string | null, today = new Date()): number | null {
  if (!date) return null;
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y!, m! - 1, d!) - start) / 86_400_000);
}

extendDict({
  en: {
    'secrets.secret': 'Secret',
    'secrets.add': 'Add secret',
    'secrets.edit': 'Edit secret',
    'secrets.name': 'Name',
    'secrets.nameHint': 'Capital letters and underscores, e.g. STRIPE_TEST. Agents see it as an environment variable.',
    'secrets.description': 'Description',
    'secrets.descriptionPh': 'What it opens, who sent it',
    'secrets.environment': 'Environment',
    'secrets.env.test': 'Test',
    'secrets.env.staging': 'Staging',
    'secrets.env.production': 'Production',
    'secrets.env.other': 'Other',
    'secrets.expires': 'Stops working on',
    'secrets.expiresHint': 'For trial keys, temporary logins, rotating passwords. You get a reminder 14 days before.',
    'secrets.expiresIn': 'expires in {n} d',
    'secrets.expiresToday': 'expires today',
    'secrets.expired': 'expired',
    'secrets.fields': 'Fields',
    'secrets.addField': 'Add field',
    'secrets.fieldLabel': 'Label',
    'secrets.fieldValue': 'Value',
    'secrets.fieldType': 'Type',
    'secrets.loginLabel': 'Login',
    'secrets.keepValue': 'Leave empty to keep the current value',
    'secrets.type.text': 'Text',
    'secrets.type.url': 'URL',
    'secrets.type.password': 'Password',
    'secrets.type.api_key': 'API key',
    'secrets.type.note': 'Secret note',
    'secrets.paste': 'Paste what you were sent',
    'secrets.pastePh': 'login: admin@client.com\npassword: …\nhttps://admin.client.com',
    'secrets.pasteApply': 'Turn into fields',
    'secrets.pasteNothing': 'Nothing to turn into fields.',
    'secrets.pasteDone': '{n} fields proposed – check them before saving',
    'secrets.audience': 'Who can see the values',
    'secrets.audienceProject': 'Everyone on the project',
    'secrets.audiencePeople': 'People',
    'secrets.audienceDepartments': 'Departments',
    'secrets.audienceAdd': 'Add…',
    'secrets.audienceEmpty': 'Choose who can see the values',
    'secrets.previewCount': 'People who can open the values: {n}',
    'secrets.previewNone': 'Nobody would be able to open the values',
    'secrets.previewNote': 'Their role and their place on the project count too.',
    'secrets.agents': 'Available to AI agents',
    'secrets.agentsHint': 'Agent runs in this project get it as an environment variable, never as text. An agent with network access could still send it elsewhere – prefer test keys.',
    'secrets.agentsProduction': 'Only someone with “Change who can access any secret” can give a production secret to agents.',
    'secrets.saved': 'Secret saved',
    'secrets.saveFailed': 'Could not save the secret.',
    'secrets.reveal': 'Show',
    'secrets.hide': 'Hide',
    'secrets.copy': 'Copy',
    'secrets.copied': 'Copied',
    'secrets.copyFailed': 'The browser did not allow copying – use Show instead.',
    'secrets.noValue': 'Not set',
    'secrets.noAccess': 'You can see this secret exists, but not its values.',
    'secrets.lastRevealed': 'Last opened by {who}, {when}',
    'secrets.trail': 'Recent use',
    'secrets.trail.created': 'added it',
    'secrets.trail.updated': 'changed it',
    'secrets.trail.revealed': 'showed {field}',
    'secrets.trail.copied': 'copied {field}',
    'secrets.trail.access_overridden': 'changed who can access it',
    'secrets.delete': 'Delete secret',
    'secrets.deleteBody': 'This permanently deletes {name} and its values.',
    'secrets.deleted': 'Secret deleted',
    'secrets.restricted': 'Restricted',
    'secrets.forAgents': 'Agents',
  },
  uk: {
    'secrets.secret': 'Секрет',
    'secrets.add': 'Додати секрет',
    'secrets.edit': 'Редагувати секрет',
    'secrets.name': 'Назва',
    'secrets.nameHint': 'Великі літери й підкреслення, напр. STRIPE_TEST. Агенти бачать її як змінну середовища.',
    'secrets.description': 'Опис',
    'secrets.descriptionPh': 'Що відкриває, хто надіслав',
    'secrets.environment': 'Середовище',
    'secrets.env.test': 'Тест',
    'secrets.env.staging': 'Staging',
    'secrets.env.production': 'Продакшн',
    'secrets.env.other': 'Інше',
    'secrets.expires': 'Перестає працювати',
    'secrets.expiresHint': 'Для тестових ключів, тимчасових логінів, паролів, що змінюються. Нагадування прийде за 14 днів.',
    'secrets.expiresIn': 'закінчується через {n} дн',
    'secrets.expiresToday': 'закінчується сьогодні',
    'secrets.expired': 'прострочено',
    'secrets.fields': 'Поля',
    'secrets.addField': 'Додати поле',
    'secrets.fieldLabel': 'Назва',
    'secrets.fieldValue': 'Значення',
    'secrets.fieldType': 'Тип',
    'secrets.loginLabel': 'Логін',
    'secrets.keepValue': 'Лишіть порожнім, щоб зберегти поточне значення',
    'secrets.type.text': 'Текст',
    'secrets.type.url': 'URL',
    'secrets.type.password': 'Пароль',
    'secrets.type.api_key': 'API-ключ',
    'secrets.type.note': 'Секретна нотатка',
    'secrets.paste': 'Вставте те, що вам надіслали',
    'secrets.pastePh': 'логін: admin@client.com\nпароль: …\nhttps://admin.client.com',
    'secrets.pasteApply': 'Розкласти на поля',
    'secrets.pasteNothing': 'Немає що розкласти на поля.',
    'secrets.pasteDone': 'Запропоновано полів: {n} – перевірте перед збереженням',
    'secrets.audience': 'Хто бачить значення',
    'secrets.audienceProject': 'Усі в проєкті',
    'secrets.audiencePeople': 'Люди',
    'secrets.audienceDepartments': 'Відділи',
    'secrets.audienceAdd': 'Додати…',
    'secrets.audienceEmpty': 'Оберіть, хто бачить значення',
    'secrets.previewCount': 'Відкрити значення зможуть: {n}',
    'secrets.previewNone': 'Ніхто не зможе відкрити значення',
    'secrets.previewNote': 'Враховано також їхню роль і місце в проєкті.',
    'secrets.agents': 'Доступно AI-агентам',
    'secrets.agentsHint': 'Запуски агентів у цьому проєкті отримують його як змінну середовища, а не як текст. Агент із доступом до мережі все ж може надіслати його деінде – давайте агентам тестові ключі.',
    'secrets.agentsProduction': 'Дати продакшн-секрет агентам може лише той, хто має право «Зміна доступу до будь-якого секрету».',
    'secrets.saved': 'Секрет збережено',
    'secrets.saveFailed': 'Не вдалося зберегти секрет.',
    'secrets.reveal': 'Показати',
    'secrets.hide': 'Сховати',
    'secrets.copy': 'Копіювати',
    'secrets.copied': 'Скопійовано',
    'secrets.copyFailed': 'Браузер не дозволив скопіювати – скористайтеся «Показати».',
    'secrets.noValue': 'Не задано',
    'secrets.noAccess': 'Ви бачите, що секрет існує, але не його значення.',
    'secrets.lastRevealed': 'Востаннє відкрито: {who}, {when}',
    'secrets.trail': 'Останнє використання',
    'secrets.trail.created': 'додає секрет',
    'secrets.trail.updated': 'змінює секрет',
    'secrets.trail.revealed': 'показує {field}',
    'secrets.trail.copied': 'копіює {field}',
    'secrets.trail.access_overridden': 'змінює доступ до секрету',
    'secrets.delete': 'Видалити секрет',
    'secrets.deleteBody': 'Це назавжди видалить {name} та його значення.',
    'secrets.deleted': 'Секрет видалено',
    'secrets.restricted': 'Обмежено',
    'secrets.forAgents': 'Агенти',
  },
});
