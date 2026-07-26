# ordi desktop – як це працює (внутрішня документація)

Десктоп-застосунок (Tauri 2, PRD §18) – це **той самий веб-SPA без жодного
окремого UI-коду**. Tauri лише загортає збірку `apps/web/dist` у нативне вікно
і додає системні можливості. Все «десктопне» у веб-коді ізольовано в одному
модулі – `apps/web/src/lib/desktop.ts` – і вмикається тільки коли застосунок
реально працює всередині Tauri.

## 1. Як SPA розуміє, що вона в десктопі

У `tauri.conf.json` увімкнено `app.withGlobalTauri: true` – Tauri інʼєктить
`window.__TAURI__` (core invoke, events, window API) прямо в сторінку, тому
**жодних npm-залежностей Tauri у веб-пакеті немає**. Детекція:

```ts
// apps/web/src/lib/desktop.ts
export const isTauri = '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
```

Кожен нативний виклик – best-effort у `try/catch`: відсутній плагін чи стара
версія рантайму ніколи не ламає застосунок (і тим більше не впливає на веб).

## 2. Перший запуск: URL інстансу

У браузері SPA ходить на same-origin `/api/v1` (nginx проксіює на API). У
Tauri same-origin API немає, тому:

1. `main.tsx` при `isTauri && !getInstanceUrl()` рендерить **InstanceGate** –
   екран «Підключіться до вашого інстансу ordi» (локалізований uk/en).
2. Введений URL валідується запитом `GET {url}/healthz` (таймаут 8 с).
3. Успіх → URL зберігається в `localStorage['ordi:apiUrl']` → reload.
4. API-клієнт (`apps/web/src/lib/api.ts`) будує базу як
   `{збережений URL}/api/v1`; у браузері значення порожнє і все працює
   same-origin, як і раніше.

Змінити інстанс = очистити `ordi:apiUrl` у localStorage (або дані застосунку).

## 3. Автентифікація: чому Bearer, а не cookie

Сесійна cookie має `SameSite=Lax` – з origin `tauri://localhost` (macOS) або
`http://tauri.localhost` (Windows/Linux) вона крос-сайтова і **не буде
надіслана**. Тому:

- `POST /auth/login` повертає в тілі `sessionToken` (той самий токен, що йде в
  cookie). Веб його ігнорує; десктоп (Login.tsx, лише при `isTauri`) зберігає в
  `localStorage['ordi:sessionToken']`.
- API-клієнт додає `Authorization: Bearer <token>` до кожного запиту, коли
  токен збережений.
- Бекенд (`apps/api/src/core/auth.ts`): Bearer спершу шукається серед
  API-токенів (SHA-256-хеш), а якщо не знайдено – серед **сесій** (це і є
  десктопний випадок). Права – повний скоуп ролі, як у cookie-сесії.
- `POST /auth/logout` відкликає сесію і з cookie, і з Bearer-заголовка;
  Shell при виході чистить `ordi:sessionToken`.

CORS: origin десктопа вже у дефолтному allowlist (`tauri://localhost`); для
Windows/Linux додайте `http://tauri.localhost` в `CORS_ORIGINS` інстансу.

## 4. Нативні можливості: де що живе

| Фіча (PRD §18) | Реалізація | Потік |
|---|---|---|
| OS-нотифікації | `lib/sse.ts` → `notifyDesktop()` | SSE-подія з каталогу (призначення, згадка, оплата, quote accepted, рішення по відпустці, PR merged) → `plugin:notification\|notify` |
| Бейдж непрочитаних | `NotificationsBell.tsx` → `setBadge()` | зміна `unread` → `Window.setBadgeCount` (dock/таскбар; трей-іконка і тултіп – з конфігу) |
| Глобальний хоткей quick-add | Rust `main.rs` + `Shell.tsx` | `Cmd/Ctrl+Shift+O` зареєстрований у Rust (`setup`, best-effort) → показ/фокус вікна + emit `ordi://quick-add` → Shell відкриває модалку швидкого створення задачі |
| Deep links `ordi://task/KLD-42` | конфіг `deep-link` + `lib/desktop.ts` | плагін емітить `deep-link://new-url` → парсинг `KEY-N` → `GET /search?q=KEY-N` → навігація на задачу |
| Автозапуск | плагін `autostart` (Rust) | ініціалізований; вмикання – стандартний viклик плагіна |
| Автооновлення | плагін `updater` + CI | підписані артефакти з релізів; endpoint і pubkey – у `tauri.conf.json → plugins.updater` |

Rust-код (`apps/desktop/src-tauri/src/main.rs`) свідомо мінімальний: ініт
плагінів + реєстрація хоткея з обробником. Уся логіка – у веб-шарі, щоб
дифи не потребували перекомпіляції нативної частини.

## 5. Іконки

`apps/desktop/src-tauri/icons/` (32/128/128@2x/512 PNG, `icon.ico`,
`icon.icns`) – згенеровані і **закомічені**; бандлеру нічого не треба
довантажувати. Перегенерація (чистий Node, без залежностей):

```bash
node scripts/gen-desktop-icons.mjs
```

## 6. Збірка і релізи

- **Dev** (потрібен Rust + системні GTK/WebKit-залежності):
  `pnpm --filter @ordi/desktop tauri dev` (сам підніме vite dev-сервер).
- **Релізні білди**: пуш тега `v*` → `.github/workflows/desktop.yml` →
  tauri-action збирає **macOS universal / Windows msi / Linux AppImage+deb**
  і кладе їх у draft-реліз GitHub.
## 5a. Вхід через браузер

Замість вводити пошту й пароль удруге, застосунок відкриває браузер, де
користувач уже залогінений. Схема – PKCE, щоб чужий застосунок, який
перехопить `ordi://`, не міг обміняти код на сесію:

1. Десктоп генерує `verifier` (лишає в себе) і `state`, шле на
   `POST /auth/desktop/start` тільки `sha256(verifier)`, потім відкриває в
   системному браузері `{instance}/desktop-auth?state=…`.
2. Сторінка `/desktop-auth` вимагає логіну (якщо ні – кидає на
   `/login?next=…` і повертає назад), показує назву пристрою та акаунт і
   просить підтвердження.
3. `POST /auth/desktop/approve` (з кукою браузера) створює одноразовий код.
4. Браузер віддає код через `ordi://auth?code=…&state=…`; код також показано
   на екрані, бо deep links спрацьовують не на кожному Linux-десктопі.
5. Десктоп шле `POST /auth/desktop/exchange` з кодом і `verifier`; сервер
   звіряє хеш, створює сесію і **видаляє** запит – код одноразовий.

Запити живуть 10 хвилин; прострочені чистяться при кожному новому старті.
Слухач deep link для цього флоу живе в `pages/Login.tsx`, а не в `Shell`,
бо на екрані входу шел ще не змонтований.

Чотири речі, без яких вхід зривається з «Вхід через браузер не завершився»:

- **PKCE-хеш не залежить від `crypto.subtle`.** Він існує лише в secure
  context, а десктоп працює на origin `tauri://localhost`, який частина
  платформ таким не вважає – тоді падав найперший крок і браузер навіть не
  відкривався. Є власна реалізація SHA-256 (`lib/sha256.ts`) як запасна.

- **`tauri-plugin-single-instance` реєструється першим.** На Windows і Linux
  `ordi://…` запускає *новий* процес; плагін перехоплює його, віддає argv
  запущеному екземпляру і той емітить `deep-link://new-url`. Без нього вікно,
  яке чекає на код, не дізнається про нього ніколи.
- **`verifier` лежить у `localStorage`, не в `sessionStorage`.** Deep link
  може перезапустити застосунок, а новий webview не побачив би
  `sessionStorage` попереднього – і не мав би чим викупити код.
- **Холодний старт читає URL запуску** (`plugin:deep-link|get_current`):
  якщо застосунок був закритий, посилання приходить аргументом, а не подією.

Плюс на екрані входу є поле «вставте код» – остання лінія оборони, якщо
deep link усе одно не спрацював (типово для частини Linux-десктопів).

## 5b. Завантаження застосунку з вебу

`GET /api/v1/desktop/latest` віддає версію і посилання на інсталятори,
беручи їх з GitHub Releases і кешуючи на годину. Сторінка `/download`
(пункт «Завантажити застосунок» у меню воркспейсу, приховано в самому
десктопі) визначає платформу й ставить потрібну кнопку першою.

Репозиторій налаштовується через `DESKTOP_RELEASES_REPO` – форк вкаже свій.
Якщо інстанс без вихідної мережі, ендпоінт віддає порожній список і сторінка
показує посилання на сторінку релізів.

## 6a. Автооновлення

Увімкнене і працює через GitHub-релізи:

- `bundle.createUpdaterArtifacts: true` – tauri-action кладе в реліз підписані
  артефакти оновлення разом із `latest.json`.
- **`app` обовʼязково має бути в `bundle.targets`**: на macOS пакет оновлення
  робиться саме з `.app`-бандла. Без нього збірка дає лише `.dmg` для ручної
  установки, а в `latest.json` не буде платформ `darwin-*` – і Mac-клієнти
  мовчки ніколи не побачать оновлення. Перевірка після релізу:
  `curl -sSL .../releases/latest/download/latest.json | jq '.platforms | keys'`
  має містити `darwin-aarch64` і `darwin-x86_64`.
- `plugins.updater.endpoints` вказує на
  `https://github.com/romirom11/ordi/releases/latest/download/latest.json`
  (працює, бо репозиторій публічний).
- `plugins.updater.pubkey` – публічний ключ; приватний лежить у секреті
  репозиторію `TAURI_SIGNING_PRIVATE_KEY` (без пароля, тому
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` порожній). Оновлення без валідного
  підпису застосунок відхиляє.
- Потік: на старті Rust (`stage_update` у `src/main.rs`) фоново перевіряє
  оновлення, завантажує і встановлює його, після чого емітить подію
  `ordi://update-ready`. Веб-шар показує тост із кнопкою «Перезапустити»,
  яка викликає `process.relaunch()`.

Ротація ключа: `pnpm --filter @ordi/desktop exec tauri signer generate`,
новий публічний ключ у `tauri.conf.json`, новий приватний – у секрет.
Клієнти зі старим ключем перестануть приймати оновлення, тому нову версію
доведеться поставити вручну.

## 6b. Дозволи (capabilities)

Tauri 2 не дає веб-шару нічого без capability-файлу, тому
`src-tauri/capabilities/default.json` явно дозволяє: `core:default` (події),
`core:window:allow-set-badge-count` (бейдж), `notification:default`,
`updater:default`, `process:allow-restart`, `deep-link:default`. Без цього
файлу нативні сповіщення, бейдж і deep links мовчки не працюють.

## 7. Статус верифікації

Перевірено наживо в цьому репозиторії (без компіляції Rust):
- bearer-цикл: login → `/me` 200 → logout → 401 (curl);
- повна симуляція Tauri-рантайму в headless-Chromium (інʼєкція
  `window.__TAURI__` до завантаження): InstanceGate → валідація → логін →
  токен збережено → застосунок працює крос-оріджн, 0 помилок консолі.

**Не перевірено тут** (немає GTK/WebKit-тулчейна): компіляція Rust і самі
бінарники – це робить CI на тегу. Якщо перший прогін workflow десь
спіткнеться, правки очікуються точкові (версії плагінів/сигнатури), не
архітектурні.
