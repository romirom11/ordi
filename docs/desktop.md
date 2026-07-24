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
- **Підписаний updater**: секрети `TAURI_SIGNING_PRIVATE_KEY` і
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` у GitHub + реальний endpoint у
  `tauri.conf.json → plugins.updater.endpoints` (зараз плейсхолдер).

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
