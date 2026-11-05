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
  /** Provider secrets: the provider secret this field reads. */
  ref?: string;
}

/** Where a provider secret's values come from, and whether they can be reached. */
export interface SecretProviderState {
  connectionId: string | null;
  kind: string | null;
  label: string | null;
  state: 'ok' | 'error' | 'disconnected';
  error: string | null;
  /** Provider names that are gone; filled when one secret is opened. */
  missing?: string[];
}

/** A connection a project may add secrets from. */
export interface ProviderConnection {
  id: string;
  kind: 'doppler';
  label: string;
  project: string | null;
  config: string | null;
  status: 'ok' | 'error';
  lastError: string | null;
  checkedAt: string | null;
  createdAt: string;
  projectIds?: string[];
  secretCount?: number;
}

export const PROVIDER_NAME: Record<string, string> = { doppler: 'Doppler' };

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
  source: 'ordi' | 'provider';
  provider: SecretProviderState | null;
}

/** A provider field is always fetched on reveal, whatever its type: ordi holds no value to show. */
export const revealsValue = (secret: Pick<SecretView, 'source'>, type: SecretFieldType) => secret.source === 'provider' || isSecretValueType(type);

/** Guess a field from a provider secret's name: ACME_ADMIN_PASSWORD → Password, password. */
export function fieldFromRef(ref: string): { label: string; type: SecretFieldType } {
  const n = ref.toUpperCase();
  const type: SecretFieldType = /(PASSWORD|PASS|PWD)$/.test(n) ? 'password'
    : /(URL|URI|HOST|ENDPOINT)$/.test(n) ? 'url'
      : /(USER|USERNAME|LOGIN|EMAIL)$/.test(n) ? 'text'
        : 'api_key';
  const last = ref.split('_').filter(Boolean).pop() ?? ref;
  const label = last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
  return { label, type };
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

/** The environment as a dot of colour, where a chip would be too loud (the dialog's switcher). */
export const ENV_DOT: Record<SecretEnvironment, string> = {
  test: 'bg-success',
  staging: 'bg-warning',
  production: 'bg-destructive',
  other: 'bg-faint',
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
    'secrets.nameHint': 'Capital letters, digits and underscores, e.g. STRIPE_TEST.',
    'secrets.envVarHint': 'Agent runs get it as',
    'secrets.optional': 'optional',
    'secrets.labelPh.text': 'Label, e.g. Login',
    'secrets.labelPh.url': 'Label, e.g. Admin panel',
    'secrets.labelPh.password': 'Label, e.g. Password',
    'secrets.labelPh.api_key': 'Label, e.g. Secret key',
    'secrets.labelPh.note': 'Label, e.g. Recovery codes',
    'secrets.valuePh.text': 'admin@client.com',
    'secrets.valuePh.url': 'https://admin.client.com',
    'secrets.valuePh.password': 'Password',
    'secrets.valuePh.api_key': 'sk_test_…',
    'secrets.valuePh.note': 'Anything else they sent',
    'secrets.noFields': 'No fields yet.',
    'secrets.pasteOpen': 'Paste from a message',
    'secrets.pasteIntro': 'Paste what the client sent – logins, passwords, links, keys. It is split into fields for you to check; nothing is saved until you press Save.',
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
    'secrets.trail.used_in_run': 'got it in an agent run',
    'secrets.delete': 'Delete secret',
    'secrets.deleteBody': 'This permanently deletes {name} and its values.',
    'secrets.deleted': 'Secret deleted',
    'secrets.restricted': 'Restricted',
    'secrets.forAgents': 'Agents',
    'secrets.fromProvider': 'From {provider}',
    'secrets.addFromProvider': 'Add from {provider}',
    'secrets.providerIntro': 'Pick the {provider} secrets this one reads. Their values stay in {provider}: ordi asks for them when someone opens a field or an agent run starts, and stores nothing.',
    'secrets.providerRef': '{provider} secret',
    'secrets.providerRefPick': 'Choose…',
    'secrets.providerConnection': 'Connection',
    'secrets.providerNamesFailed': 'Could not load the names from {provider}.',
    'secrets.providerReads': 'reads {ref}',
    'secrets.providerState.error': '{provider} could not be reached: {error}',
    'secrets.providerState.disconnected': 'Disconnected: {error}. The name and fields stay; values cannot be opened until it is linked again.',
    'secrets.providerState.missing': '{provider} has no secret named {names} – renamed or deleted there. Edit the secret to point at the new name.',
    'secrets.providerRelink': 'Link to a connection',
  },
  uk: {
    'secrets.secret': 'Секрет',
    'secrets.add': 'Додати секрет',
    'secrets.edit': 'Редагувати секрет',
    'secrets.name': 'Назва',
    'secrets.nameHint': 'Великі літери, цифри й підкреслення, напр. STRIPE_TEST.',
    'secrets.envVarHint': 'Запуски агентів отримують його як',
    'secrets.optional': 'необов’язково',
    'secrets.labelPh.text': 'Назва, напр. Логін',
    'secrets.labelPh.url': 'Назва, напр. Адмінка',
    'secrets.labelPh.password': 'Назва, напр. Пароль',
    'secrets.labelPh.api_key': 'Назва, напр. Секретний ключ',
    'secrets.labelPh.note': 'Назва, напр. Коди відновлення',
    'secrets.valuePh.text': 'admin@client.com',
    'secrets.valuePh.url': 'https://admin.client.com',
    'secrets.valuePh.password': 'Пароль',
    'secrets.valuePh.api_key': 'sk_test_…',
    'secrets.valuePh.note': 'Усе інше, що надіслали',
    'secrets.noFields': 'Полів ще немає.',
    'secrets.pasteOpen': 'Вставити з повідомлення',
    'secrets.pasteIntro': 'Вставте те, що надіслав клієнт: логіни, паролі, посилання, ключі. Текст розкладеться на поля, які ви перевірите; нічого не збережеться, доки ви не натиснете «Зберегти».',
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
    'secrets.trail.used_in_run': 'отримує його в запуску агента',
    'secrets.delete': 'Видалити секрет',
    'secrets.deleteBody': 'Це назавжди видалить {name} та його значення.',
    'secrets.deleted': 'Секрет видалено',
    'secrets.restricted': 'Обмежено',
    'secrets.forAgents': 'Агенти',
    'secrets.fromProvider': 'З {provider}',
    'secrets.addFromProvider': 'Додати з {provider}',
    'secrets.providerIntro': 'Оберіть секрети {provider}, які він читає. Значення лишаються в {provider}: ordi запитує їх, коли хтось відкриває поле або стартує запуск агента, і нічого не зберігає.',
    'secrets.providerRef': 'Секрет у {provider}',
    'secrets.providerRefPick': 'Оберіть…',
    'secrets.providerConnection': 'Підключення',
    'secrets.providerNamesFailed': 'Не вдалося завантажити назви з {provider}.',
    'secrets.providerReads': 'читає {ref}',
    'secrets.providerState.error': '{provider} недоступний: {error}',
    'secrets.providerState.disconnected': 'Відключено: {error}. Назва й поля лишаються; значення не відкриються, доки його не прив’яжуть знову.',
    'secrets.providerState.missing': 'У {provider} немає секрету {names} – його там перейменували чи видалили. Відредагуйте секрет і вкажіть нову назву.',
    'secrets.providerRelink': 'Прив’язати до підключення',
  },
});
