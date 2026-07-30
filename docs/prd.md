# Технічне завдання: ordi

Операційна платформа агенції: CRM, проєкти й задачі, knowledge base, тайм-трекінг, фінанси. Референси за модулями: Twenty (CRM, кастомізація даних), Plane (проєкти, цикли, pages, інтеграції), Invoice Ninja (рахунки, quotes, оплати, нагадування). Продукт розробляється одразу як production-ready, без проміжного MVP-скоупу: всі описані модулі входять у реліз 1.0.

Версія документа: 3.2. Назва продукту: ordi. Розділи, що спираються на дослідження референсів, зведені в Додатку A (мапа покриття Plane / Twenty / Invoice Ninja / Frappe HR / Productive). Зміни 3.2: CRM розділено на research leads і кваліфіковані deals; Work став основною робочою поверхнею; sales activities, manual playbooks, ранковий digest і durable email delivery зафіксовані як продуктовий та операційний контракт. Зміни 3.1: усунено суперечність по Resourcing; internal-проєкти через nullable company_id + kind (без фіктивного клієнта); повна механіка кастомних полів (5.5); redaction і політика зберігання чутливого аудиту (14.4); optimistic locking через version (не updated_at); формальні RPO/RTO і PITR (19.2); повна специфікація доставки подій outbox (3.3).

---

## 1. Мета і призначення

### 1.1. Проблема

Операційні дані агенції розкидані по незвʼязаних інструментах: клієнти в CRM, задачі в трекері, документація у вікі, час у таймері, рахунки в білінгу. Наслідки: перемикання контексту, дублювання даних, відсутність наскрізної картини "клієнт → угода → проєкт → задачі → час → рахунок → оплата", крихкий glue-код між чужими API, неможливість контролювати доступ наскрізно (хто бачить фінанси, хто бачить конкретний проєкт).

### 1.2. Рішення

Один застосунок з однією базою, який покриває шість доменів:

1. **CRM**: leads, компанії, контакти, Work-черга, sales activities, playbooks, угоди, нотатки, історія.
2. **Projects**: проєкти, задачі, цикли, звʼязки, воркфлоу, intake.
3. **Knowledge Base**: простори, сторінки, версії, привʼязка до проєктів.
4. **Time**: тайм-трекінг по задачах, ставки, білінг часу.
5. **Finance**: quotes, рахунки, оплати, повторювані, нагадування, витрати, собівартість і прибутковість.
6. **People (HR)**: співробітники, lifecycle, відпустки/відсутності, хайринг, компенсація як cost rate.

Плюс наскрізні: RBAC, git-інтеграції, автоматизації на шині подій, пошук, нотифікації, аудит, MCP-агент.

### 1.3. Ключові принципи

- **Один API як єдиний контракт.** Веб, десктоп (Tauri) і MCP-агент є рівноправними клієнтами одного REST API. Бізнес-логіка живе тільки в доменних сервісах.
- **Модульні домени.** Кожен домен самодостатній: свій зріз схеми, сервіс, ендпоінти, події. Міжмодульна взаємодія: FK у БД, шина подій, спільні контракти. Новий домен не модифікує наявні.
- **RBAC як наскрізний шар.** Права перевіряються на бекенді для кожного запиту; UI лише приховує недоступне. Доступ керується на двох рівнях: можливості (permissions через ролі) і ресурси (членство в проєктах/просторах).
- **Agent-first.** Кожна дія, доступна людині, доступна агенту через API/MCP у межах прав його токена.
- **Кастомізація без міграцій.** Статуси, типи задач, типи проєктів, етапи угод, кастомні поля, ролі, шаблони: все конфігурується даними, а не кодом.
- **Мінімалістичний UX.** Щільний, клавіатурний, command palette, peek-панелі, без візуального шуму.
- **Self-hosted** на Dokploy; зовнішні залежності тільки SMTP і S3-сумісне сховище.

### 1.4. Масштаб

Single-tenant, до 50 користувачів (включно з guest-доступами), до ~1000 клієнтів, ~500 проєктів, ~50 000 задач, ~10 000 рахунків сукупно. Архітектура свідомо не оптимізується під більше: пріоритет у простоті підтримки.

---

## 2. Технологічний стек

| Шар | Технологія | Обґрунтування |
|---|---|---|
| БД | PostgreSQL 16+ | JSONB, FTS, тригери, надійність |
| ORM / міграції | Drizzle ORM + drizzle-kit | Типобезпека, адитивні міграції |
| API | Hono (Node.js 22 LTS, TS) | Легкий, типізовані маршрути, OpenAPI |
| Валідація | Zod (спільні схеми в packages/shared) | Один source of truth для API, UI, MCP |
| Auth | Better Auth | Сесії, 2FA, інтеграція з Drizzle |
| Веб | React 19 + Vite + TanStack Router/Query | Стандартна SPA |
| UI | shadcn/ui + Tailwind | Мінімалізм, повний контроль |
| Rich text | Tiptap (JSON у БД) | Задачі, нотатки, KB-сторінки, коментарі |
| Десктоп | Tauri 2 | Той самий фронт, нативні білди |
| MCP | TypeScript MCP SDK | Агент поверх API |
| PDF | Typst (серверний рендер) | Рахунки, quotes |
| Email | Nodemailer + SMTP | Відправка документів і нагадувань |
| Файли | S3-сумісне (MinIO / R2) | Вкладення, PDF-артефакти |
| Черга | pg-boss поверх Postgres | Нагадування, recurring, вебхуки, email; без Redis |
| Монорепо | pnpm workspaces + Turborepo | Спільні пакети, один CI |
| Деплой | Docker (api, web) на Dokploy | Наявна інфраструктура |

**Архітектурні межі.** Технології нижче не використовуються не тому, що вони погані, а тому, що на цільовому масштабі й за соло-підтримки їхня операційна ціна перевищує користь. Для кожної зафіксовано тригер перегляду й шлях міграції, який не ламає доменні модулі:

| Технологія | Чому не зараз | Тригер перегляду | Шлях міграції |
|---|---|---|---|
| Redis | pg-boss покриває черги; гарячий кеш не потрібен на цих обсягах; мінус один stateful-сервіс в опіці (бекапи, версії, моніторинг) | Горизонтальне масштабування API: SSE fan-out між репліками, або потреба кешу | Redis pub/sub підключається за інтерфейсом EventBroadcaster; черга лишається на pg-boss або мігрує на BullMQ |
| Мікросервіси | Вигода мікросервісів: незалежні релізні цикли кількох команд; ціна: розподілений дебаг, версіонування контрактів, мережеві failure modes. Соло-оператор платить усю ціну без вигоди | Кілька команд з незалежними циклами релізів | Модульний моноліт вже тримає межі доменів: модуль виноситься в сервіс по наявних контрактах |
| GraphQL | REST+OpenAPI дає типізований клієнт кодогенерацією; guard-на-маршрут простіший за field-level authz (RBAC у нас центральний); MCP, вебхуки й публічні сторінки природно RESTові | Треті сторони з потребою гнучких клієнтських запитів | GraphQL-шар поверх тих самих доменних сервісів |
| Окремий realtime-сервер | SSE з API достатній для інвалідації кешу й нотифікацій; окремий WS-процес це ще один деплой і авторизаційний шар | Співредагування/presence (CRDT) або тисячі одночасних зʼєднань | WS-сервіс поверх шини подій |
| Kubernetes | Dokploy+Docker покриває один хост; k8s це податок на оркестрацію без потреби в оркестрації | Мультихост / HA-вимоги | Compose-сервіси мапляться в Helm 1:1 |

### 2.1. Монорепозиторій

```
agency-os/
├── apps/
│   ├── api/          # Hono API, доменні модулі, воркери pg-boss
│   ├── web/          # React SPA
│   └── desktop/      # Tauri-обгортка apps/web
├── packages/
│   ├── db/           # Drizzle-схема, міграції
│   ├── shared/       # Zod-схеми, типи, каталог permissions, константи
│   └── mcp/          # MCP-сервер (клієнт API)
├── docker/
└── turbo.json
```

---

## 3. Загальна архітектура

### 3.1. Шари

```
┌──────────┐ ┌───────────────┐ ┌───────────┐ ┌─────────────────┐
│ Web SPA  │ │ Desktop(Tauri)│ │ MCP-агент │ │ Git-провайдери  │
└────┬─────┘ └──────┬────────┘ └─────┬─────┘ │ (вх. вебхуки)   │
     └──────────────┼────────────────┘       └───────┬─────────┘
                    ▼                                ▼
          ┌───────────────────────────────────────────────┐
          │              REST API (Hono)                  │
          │  auth → RBAC guard → валідація → маршрут      │
          └──────────────────────┬────────────────────────┘
                                 ▼
     ┌────────────────────────────────────────────────────┐
     │                 Доменні модулі                     │
     │ core │ crm │ projects │ kb │ time │ finance │ integ│
     └──────────────────────┬─────────────────────────────┘
                            ▼
                 ┌─────────────────────┐        ┌─────────┐
                 │ Drizzle → Postgres  │◄──────►│ pg-boss │
                 └─────────────────────┘        │ воркери │
                                                └─────────┘
```

Правила шарів (обовʼязкові):

1. Клієнти не містять бізнес-логіки і не є джерелом прав: RBAC на бекенді, UI лише відображає.
2. Доменний модуль не імпортує сервіс іншого модуля напряму: взаємодія через FK, шину подій або read-контракти в shared.
3. SQL тільки в доменних сервісах через Drizzle.
4. Кожен маршрут декларує required permission; кожен сервісний метод, що працює з ресурсом обмеженого доступу, викликає resource-check (див. розділ 4).

### 3.2. Структура доменного модуля

```
projects/
├── schema.ts        # таблиці домену
├── service.ts       # бізнес-логіка
├── access.ts        # ресурсні перевірки домену (canAccessProject тощо)
├── routes.ts        # тонкі маршрути: guard → валідація → сервіс
├── events.ts        # published/subscribed події
├── automations.ts   # обробники подій (напр. git → статус)
└── *.test.ts
```

### 3.3. Шина подій (outbox)

Публікація події в одній транзакції зі зміною даних (таблиця `events`): подія й зміна коммітяться атомарно, тому втратити подію при успішному записі даних неможливо. Окремий воркер (relay) читає неопубліковані події й передає їх обробникам через pg-boss. Типізований каталог подій у shared: кожна подія несе `type`, `aggregate_type`, `aggregate_id` (напр. project:KLD), `payload`, `occurred_at`.

**Гарантія доставки: at-least-once, не exactly-once.** Наслідок обовʼязковий: усі обробники ідемпотентні. Дедуплікація через таблицю `processed_events (consumer, event_id)`: перед обробкою consumer перевіряє, чи вже обробляв цей event_id; повторна доставка стає no-op. Це базовий захист від повторної обробки, а не покладання на "рівно один раз".

**Retry і dead-letter:** невдала обробка ретраїться з експоненційним backoff (напр. 5 спроб: ~10с, 1хв, 5хв, 30хв, 2год). Після вичерпання подія переходить у dead-letter стан (не губиться), пишеться помилка і піднімається алерт у моніторинг. Отруйна подія не блокує чергу для інших.

**Ручний replay:** адмінка (audit.read + settings.manage) показує dead-letter чергу з деталями помилки; дія replay повертає подію в обробку (після фіксу коду/даних). Можливий і повторний прогін уже обробленої події (напр. після багфіксу обробника): виконується через скидання відповідного запису в processed_events, свідома адмінська операція.

**Порядок подій:** глобального total order немає (він дорогий і не потрібен). Гарантується per-aggregate ordering: події з однаковим `aggregate_id` обробляються строго послідовно (серіалізація за ключем агрегату), різні агрегати паралельно. Обробники НЕ покладаються на порядок між різними агрегатами. Для агенційного масштабу серіалізація в межах агрегату не впливає на пропускну здатність. (Крос-агрегатний глобальний порядок свідомо не гарантується, зафіксовано в компромісах 22.)

Ключові події: `deal.stage_changed`, `deal.won`, `project.completed`, `task.created`, `task.status_changed`, `task.assigned`, `comment.mentioned`, `cycle.completed`, `page.published`, `time.entry_created`, `quote.accepted`, `invoice.sent`, `invoice.viewed`, `invoice.overdue`, `payment.recorded`, `git.pr_opened`, `git.pr_merged`, `employee.onboarded`, `employee.exited`, `leave.requested`, `leave.decided`, `applicant.hired`.

Споживачі: нотифікації, activity log, автоматизації (розділ 13.3), зовнішні вебхуки (та сама retry/DLQ-механіка), SSE.

### 3.4. Realtime

SSE-ендпоінт `/api/v1/stream`: сервер пушить події, відфільтровані за правами користувача (подія по приватному проєкту йде тільки його членам). Фронт інвалідовує кеш TanStack Query. Конфлікти редагування: optimistic locking через окреме монотонне числове поле `version` (int, стартує з 1, інкрементиться тригером БД на кожному UPDATE, незалежно від годинника). Клієнт передає відому version у мутації; розбіжність → 409 з поточним станом сутності для перезавантаження. `updated_at` лишається виключно для відображення й сортування, ніколи для контролю конкурентності. Колаборативні курсори/CRDT не реалізуються: одночасне редагування одного rich-text поля вирішується блокуванням "хтось редагує" (advisory lock на 60 с з heartbeat) для KB-сторінок і описів задач.

---

## 4. RBAC: модель доступу

Наскрізний шар. Проєктується перш за домени, бо всі домени від нього залежать.

### 4.1. Дворівнева модель

**Рівень 1: Permissions (що користувач вміє робити).** Каталог permissions зафіксований у коді (shared), ролі є конфігурованими наборами permissions. Користувач має рівно одну глобальну роль.

**Рівень 2: Resource access (до яких обʼєктів має доступ).** Окремі ресурси мають власні списки доступу: проєкти (private/workspace) і KB-простори (private/workspace). Доступ до підлеглих сутностей успадковується від ресурсу: задачі, коментарі, час, сторінки видимі тільки тим, хто має доступ до проєкту/простору.

Фінальне правило авторизації запиту:

```
allowed = hasPermission(user.role, required_permission)
       AND (resource is unrestricted OR isResourceMember(user, resource))
```

### 4.2. Каталог permissions

Формат `domain.action`. Повний каталог (версіонується в shared, UI редактора ролей рендериться з нього):

| Домен | Permissions |
|---|---|
| crm | `crm.read`, `crm.write`, `crm.delete`, `crm.export` |
| deals | `deals.read`, `deals.write`, `deals.delete` |
| projects | `projects.read` (бачити workspace-проєкти), `projects.create`, `projects.write` (налаштування проєктів, де член з роллю admin), `projects.delete`, `projects.export` |
| kb | `kb.read`, `kb.write`, `kb.manage_spaces` |
| time | `time.track` (вести свій час), `time.read_all` (бачити чужий час), `time.manage` (редагувати чужі записи, ставки) |
| finance | `finance.read`, `finance.write` (створення/редагування документів), `finance.send`, `finance.payments` (фіксація оплат), `finance.delete`, `finance.settings` (ставки податків, номерація, нагадування), `finance.export`, `finance.read_costs` (собівартість, прибутковість, витрати на ЗП) |
| people | `people.read`, `people.read_sensitive`, `people.read_compensation`, `people.write`, `people.manage_leave`, `people.approve_leave`, `people.recruit` |
| integrations | `integrations.manage` |
| settings | `settings.manage` (реквізити, шаблони, кастомні поля, типи), `users.manage`, `roles.manage`, `audit.read` |

Правило безпеки: невідомий permission = заборонено. Read не мається на увазі write-ом: набори явні.

### 4.3. Ролі

Таблиці `roles` (id, name, description, is_system) і `role_permissions` (role_id, permission). Системні (нередаговані, is_system=true):

- **Owner**: всі permissions, не можна видалити останнього Owner.
- **Admin**: всі, крім managementу Owner.

Преднастроєні редаговані ролі (сід, admin може змінювати/створювати власні через UI-редактор ролей: матриця domain × action):

- **Manager**: все по crm/deals/projects/kb/time включно з read_all, фінанси read+write+send без settings/delete.
- **Member**: crm.read, deals.read/write, projects.read/create, kb.read/write, time.track. Фінансів не бачить взагалі: розділ відсутній у навігації, ендпоінти повертають 403, фінансові поля (сума угоди видима, але таб "Рахунки" у проєкті/клієнті прихований).
- **Finance**: crm.read, finance.* повністю (включно з read_costs), projects.read, time.read_all (для білінгу часу і собівартості), people.read_compensation видається вибірково.
- **HR**: people.* повністю, крім read_compensation (видається окремо вибірково); projects.read для онбординг-задач.
- **Guest** (зовнішній: підрядник або клієнт): жодних глобальних permissions, крім неявних; бачить виключно проєкти і KB-простори, куди доданий членом, у них: задачі read/write (конфігурується на членстві), коментарі, свої time entries. CRM, deals, finance, people, налаштування недоступні повністю.

### 4.4. Ресурсний доступ

**Проєкти.** `projects.visibility`: `workspace` (усі з projects.read) або `private` (тільки члени). Таблиця `project_members` (project_id, user_id, role: admin | member | viewer, can_write_tasks bool для guest-нюансу). Ролі членства:

- **admin**: налаштування проєкту (воркфлоу, типи, члени, git-привʼязка), все з задачами.
- **member**: створення/редагування задач, коментарі, час.
- **viewer**: read-only.

Guest завжди взаємодіє тільки через членство. Створювач проєкту автоматично admin.

`workspace` — це і є "unrestricted" з правила 4.1, тому на такому проєкті рівень задають самі permissions ролі: `projects.read` → viewer, `projects.write` → admin (і, отже, все, що може member). Членство потрібне для `private` і для того, щоб дати доступ вужче, ніж роль. `projects.read` лишається підлогою: без нього проєкт не потрапляє в `accessibleProjectIds`, а отже не відкривається — те, що видно в списку, і те, що відкривається, завжди збігається.

**KB-простори.** `kb_spaces.visibility`: workspace | private; `space_members` (space_id, user_id, role: editor | viewer). Простір, привʼязаний до проєкту, успадковує ефективну роль на проєкті (project admin → editor, member → editor, viewer → viewer) плюс власні додаткові члени. Аналогічно проєктам, на `workspace`-просторі рівень дають permissions: `kb.read` → viewer, `kb.write` → editor.

Рівня, якого не вистачає на ресурсі, який користувач бачить, — це 403 з поясненням, не 404: 404 лишається тільки для ресурсів поза видимістю (без витоку існування).

Ресурсний доступ діє скрізь, де рядок належить проєкту або простору, а не лише в списках самих проєктів: домашня стрічка активності і трейл конкретної сутності (`/audit/entity/:type/:id`), "мої задачі", алокації Resourcing і пошук по KB-сторінках фільтруються через `accessibleProjectIds` / `accessibleSpaceIds`. Permission домену відповідає на питання "чи бачить ця роль активність по задачах взагалі", але не "по яких саме" — тому обидві перевірки обовʼязкові. Виняток — `audit.read`: бачити все і є його призначенням.

**Фінанси.** Ресурсних списків немає: доступ керується виключно permissions (finance.*). Обґрунтування: фінанси або довірені цілком, або приховані цілком; пер-клієнтний фінансовий доступ не реалізується (компроміс у розділі 22).

**CRM.** Аналогічно: permission-рівень без пер-записних ACL. Поле owner на компанії/угоді є організаційним, не обмежувальним.

### 4.5. Механіка виконання

1. Auth-middleware резолвить користувача (сесія або API-токен) → `ctx.user`.
2. RBAC-middleware вантажить permission set ролі (кеш у памʼяті процесу, інвалідація подією `role.updated`).
3. Маршрут декларативно: `guard('finance.read')`. Відсутність декларації валить CI-тест (лінт-правило: кожен маршрут має guard або явний `public()`).
4. Сервіс для ресурсних сутностей викликає `access.assertProject(user, projectId, minRole)`; списки будуються через `accessibleProjectIds(user)` (один кешований запит на реквест).
5. API-токени мають власний скоуп: підмножина permissions власника токена (не можна видати токен ширший за свою роль) плюс прапор read_only.
6. UI отримує permission set і membership у `/api/v1/me` і ховає недоступні розділи/дії; сервер лишається джерелом правди.
7. Кожна відмова 403 пишеться в audit з required permission: полегшує налагодження ролей.

### 4.6. UI управління

Налаштування → Ролі: список ролей, редактор-матриця permissions, лічильник користувачів на ролі. Налаштування → Користувачі: інвайт з роллю, зміна ролі, деактивація. Проєкт → Налаштування → Доступ: visibility, члени, ролі членства. KB-простір → Доступ: аналогічно.

---

## 5. Модель даних

### 5.1. Ядро звʼязків

```
                        users ──< project_members >── projects >── companies <── contacts
                          │              │               │  │          │
roles ──< role_permissions│              │      cycles ──┘  │          ├─< deals >── deal_stages
                          │              │        │         │          ├─< notes
   task_assignees >───────┤            tasks ─────┴─────────┤          └─< invoices ──< invoice_items
        │                 │             │ │ │               │               │   ▲
      tasks ──────────────┼─────────────┘ │ └< task_relations              │   └── quotes ──< quote_items
        │                 │               └──< comments     │              └─< payments
        ├─< time_entries ─┘                                 │
        ├─< git_links                    kb_spaces ─────────┘ (project_id nullable)
        └─< task_labels >── labels          └──< kb_pages (tree) ──< kb_page_versions
```

### 5.2. Наскрізні конвенції

- PK: ULID. Усі таблиці: `created_at`, `updated_at`, `created_by` (nullable для системних).
- **Конкурентність:** усі редаговані бізнес-сутності мають поле `version INTEGER NOT NULL DEFAULT 1`, що інкрементиться тригером БД на кожному UPDATE. Це джерело optimistic locking (3.4), а не `updated_at`.
- Soft delete: `deleted_at` на бізнес-сутностях; кошик у налаштуваннях; hard delete тільки Owner/Admin.
- Кастомні поля: `custom_fields JSONB` на companies, contacts, deals, projects, tasks, invoices, quotes, employees, applicants + реєстр `custom_field_definitions`. Повна механіка (індексація, фільтрація, сортування, зміна типу, дашборди): підрозділ 5.5.
- Гроші: NUMERIC(14,2); валюта ISO-кодом на документі.
- Впорядкування: `position` NUMERIC, fractional indexing.
- FTS: tsvector-колонки з тригерами на companies, contacts, projects, tasks, kb_pages, invoices(number), quotes(number); trigram-індекси на номерах.

### 5.3. Таблиці за доменами

**core:** users (email, name, role_id, avatar, timezone, locale, is_active), sessions/accounts/verifications (Better Auth), api_tokens (user_id, name, hash, scopes JSONB, read_only, last_used_at, revoked_at), roles, role_permissions, custom_field_definitions (entity_type, key, label, type: text/number/date/select/multiselect/checkbox/url/user, options, required, position, show_in_list, is_sortable, indexed), activity_log (entity_type, entity_id, actor_id, actor_type: user|agent|system|integration, action, diff JSONB – з redaction чутливих полів, див. 14.4, sensitivity: normal|sensitive для політики зберігання), notifications (user_id, type, dedupe_key, entity_ref, payload, read_at, emailed_at), email_deliveries (idempotency_key, to, subject, body/html, status: pending|sending|sent|dead, attempts, next_attempt_at, sent_at, last_error), events (outbox: type, aggregate_type, aggregate_id, payload, occurred_at, published_at), processed_events (consumer, event_id – дедуплікація обробки), attachments (entity_type, entity_id, file_key, filename, size, mime), saved_views (user_id nullable для shared, entity_type, name, filters JSONB, sort, layout, is_shared), webhook_subscriptions (url, secret, event_types[], active), webhook_deliveries (лог з retry-статусом, attempt, next_retry_at, status: pending/delivered/failed/dead), dashboards (owner_id, name, visibility: private|workspace), dashboard_widgets (dashboard_id, widget_type, source, config JSONB: фільтри/groupby/метрика, layout: x/y/w/h).

**crm:** companies (name, domain, status: lead/active/paused/archived, owner_id, billing_email, address JSONB, default_currency, payment_terms_days, portal_token, custom_fields), contacts (company_id, first/last name, email, phone, position, is_primary, custom_fields), leads (company_id, contact_id?, title, product, status, score, signal/evidence/fit/timing, sources, suggested_channel, opener, caution, nurture_until, owner_id, source links), deal_stages (name, position, probability, is_won, is_lost), deals (company_id, source_lead_id?, title, stage_id, amount nullable, currency, expected_close_date, owner_id, lost_reason, custom_fields), sales_activities (exactly one lead_id/deal_id, company_id, contact_id?, type, status, channel, subject, context, outcome, due_at, owner_id, message_template_id?, sequence links), sales_message_templates, sales_sequences, sales_sequence_steps, sales_sequence_enrollments, sales_digest_runs (user_id + local_date), notes (company_id, contact_id?, lead_id?, deal_id?, body JSON, pinned).

**projects:** project_types (name, icon, color), project_templates (name, definition JSONB: статуси, типи задач, дефолтні мітки, KB-простір, saved views), projects (company_id nullable, kind: client|internal, name, key, project_type_id?, template_source_id?, status: active/paused/completed/archived, visibility, lead_id, start_date, target_date, description, settings JSONB: estimate_unit hours|points, custom_fields, version), project_members, task_statuses (project_id, name, category: backlog/todo/in_progress/done/canceled, color, position, is_default), task_types (project_id nullable = workspace-рівень, name, icon, color, position), tasks (project_id, number, title, description JSON, status_id, type_id?, priority: none/low/medium/high/urgent, parent_id, due_date, start_date, estimate NUMERIC, cycle_id?, position, custom_fields), task_assignees, task_relations (task_id, related_task_id, type: blocks/duplicates/relates; blocked_by зберігається як інверсія blocks), labels (workspace-рівень: name, color, scope: task|project – окремі словники для задач і проєктів), task_labels, project_labels, comments (task_id, author_id, body JSON, edited_at), cycles (project_id, name, start_date, end_date, status: upcoming/active/completed, goal), cycle_snapshots (cycle_id, date, open_count, open_estimate), task_drafts (user_id, project_id?, payload JSONB), task_links (task_id, url, title), task_templates (project_id nullable = воркспейс, name, definition JSONB: поля + підзадачі), recurring_tasks (project_id, template_id, frequency/cron, next_run, active), intake_items (project_id, source: form/email, requester_name, requester_email, title, description, attachments, status: pending/accepted/declined, decline_reason, created_task_id), intake_settings (project_id, form_token, form_enabled, mailbox JSONB encrypted).

**kb:** kb_spaces (name, icon, project_id nullable, visibility, position), space_members, kb_pages (space_id, parent_id, title, body JSON, icon, position, is_template, published bool, visibility: public|private, locked_by/locked_at), kb_page_comments (page_id, author_id, body JSON), kb_page_versions (page_id, body JSON, title, version_no, author_id, created_at), kb_page_links (page_id, target_type: page/task/company, target_id) для backlinks.

**time:** time_entries (task_id, user_id, project_id денормалізовано, started_at, duration_seconds, note, billable bool, hourly_rate NUMERIC знімок ставки клієнту, cost_rate NUMERIC знімок собівартості години з compensation+overhead на момент запису, invoice_item_id nullable = чим виставлено), project_rates (project_id, user_id nullable = дефолт проєкту, hourly_rate, currency).

**finance:** number_sequences (doc_type, period_key, last_value; атомарно FOR UPDATE), tax_rates (name, rate_percent), quotes (company_id, project_id?, number, status: draft/sent/viewed/accepted/declined/expired, currency, issue_date, valid_until, subtotal, tax_total, total, public_token, accepted_at, converted_invoice_id, custom_fields), quote_items, invoices (company_id, project_id?, quote_id?, number, status: draft/sent/viewed/partially_paid/paid/canceled, is_overdue computed, currency, issue_date, due_date, discount_type/value, subtotal, tax_total, total, amount_paid, notes, terms, public_token, sent_at, reminders_paused bool, language uk|en, custom_fields), invoice_items (description, quantity, unit_price, tax_rate_id?, amount, position, source: manual|time|quote), payments (invoice_id, amount, currency, date, method, reference, notes), recurring_invoices (company_id, project_id?, frequency, next_issue_date, items_template JSONB, auto_send, status), credit_notes (invoice_id, amount, reason, date), expenses (company_id?, project_id?, category_id, amount, currency, date, description, attachment_id), expense_categories, reminder_rules (offset_days signed, template_id, active), email_templates (type, subject, body з плейсхолдерами), reminder_log (invoice_id, rule_id, sent_at).

**integrations:** git_connections (provider: github/gitlab/gitea, installation/credentials JSONB encrypted, webhook_secret, installation_id + account_login для GitHub App, status: connected/revoked/suspended), git_repositories (connection_id, external_id, full_name, default_branch), project_repositories (project_id, repository_id), git_links (task_id, repository_id, type: branch/commit/pr/mr, external_ref, title, url, state: open/merged/closed, author, updated_at), git_automation_rules (project_id, trigger: pr_opened/pr_merged/pr_closed/branch_created, target_status_id).

### 5.4. Зафіксовані кардинальності (найдорожчі рішення)

- **project N–1 company, nullable + `kind: client | internal`.** Клієнтський проєкт має company_id і kind=client. Внутрішній проєкт має company_id=NULL і kind=internal (без фіктивного клієнта). `kind` (не наявність company_id) є канонічним прапорцем для фільтрів, прав і звітів; company_id NULL просто відображає відсутність клієнта. Наслідки, зафіксовані явно: CRM-списки, aging і profitability-виручка працюють лише над kind=client (internal ніколи не протікає в клієнтські звіти); фінансова аналітика собівартості (11.10) враховує kind=internal проєкти як чисту вартість без revenue (саме це потрібно для overhead-обліку: внутрішній час це небіллабельна собівартість). Рахунок не можна привʼязати до internal-проєкту (валідація: invoice.project_id повинен вести на kind=client).
- **project 1–N tasks; безпроєктних задач немає.** Оперативка й задачі, не привʼязані до клієнтської роботи, живуть у internal-проєкті (напр. "Inbox" або "Operations"), який є звичайним kind=internal проєктом без company_id, а не службовим винятком.
- task parent_id: дерево підзадач, максимум 5 рівнів (перевірка сервісом).
- task N–N users (виконавці); task N–N labels; task N–N tasks (relations).
- invoice N–1 company, N–1 project (nullable), N–1 quote (nullable); payment N–N немає: payment N–1 invoice, часткові оплати списком платежів.
- contact N–1 company (людина у двох клієнтах = два записи; компроміс у 22).
- kb_space N–1 project (nullable: workspace-простори існують без проєкту).

### 5.5. Кастомні поля: механіка

Кастомні поля зберігаються в `custom_fields JSONB` на сутності, а їхня схема (тип, опції, прапорці) у реєстрі `custom_field_definitions`. JSONB обрано за гнучкість без міграцій, але це вимагає явних правил для індексації, запитів, зміни типу й агрегації, інакше "динамічні поля" стають нехтованою дірою в продуктивності й коректності.

**Індексація.** Два рівні. (1) Базовий GIN-індекс на колонці `custom_fields` кожної сутності: покриває existence- і containment-фільтри (`custom_fields ? 'key'`, `custom_fields @> '{"key":val}'`), достатньо для нечастих фільтрів. (2) Для полів, які реально фільтрують/сортують часто (definition має прапорець `indexed`), створюється точковий B-tree expression-індекс на витягнутому й типізованому значенні, напр. `CREATE INDEX ON tasks (((custom_fields->>'budget')::numeric))`. Створення/зняття такого індексу керується прапорцем у реєстрі й виконується міграційним воркером асинхронно (CONCURRENTLY), а не в запиті користувача.

**Сортування.** JSONB-значення без типу сортуються як текст, що ламає числа й дати. Тому для полів з прапорцем `is_sortable` значення проєктується в типізований вираз на рівні запиту (`(custom_fields->>'key')::numeric | ::date | ::text` за типом з реєстру), і саме за ним іде ORDER BY; expression-індекс (вище) робить це дешевим. Сортування дозволене лише для типів number/date/select/text; multiselect/checkbox/url/user як ключ сортування недоступні (валідація на рівні API).

**Фільтрація.** Клієнт ніколи не шле сирий SQL. API приймає структурований фільтр `{ field_key, op, value }`; сервіс звіряє field_key з реєстром, бере тип, валідує op під тип (number: eq/gt/lt/between; select: in; text: contains; date: before/after/between; checkbox: eq) і будує параметризований предикат над JSONB. Невідомий ключ або невалідний під тип op → 400. Це закриває і продуктивність (через indexed-поля), і інʼєкції.

**Зміна типу поля.** Руйнівна зміна семантики типу на льоту заборонена (не буває "ALTER поля text→number" над наявними даними). Дозволено: (а) редагувати label, опції select (додавання; видалення опції, що використовується, блокується або веде через міграцію значень), порядок, required, показ у списку, прапорці indexed/sortable; (б) для фактичної зміни типу створюється НОВЕ поле потрібного типу, дані переносяться керованою міграцією (з валідацією і звітом про непереносні значення), старе поле деприкейтиться й ховається. Тобто той самий принцип, що й усюди в ТЗ: адитивно, а не хірургія над семантикою. `required` вмикається лише після заповнення наявних записів (інакше валідація ретроактивно ламає старі сутності): майстер показує, скільки записів порожні.

**Дашборди й агрегація.** Віджет може групувати/агрегувати лише за кастомними полями агрегованих типів: number (сума/середнє/мін/макс), select/multiselect (кількість за значенням), date (кількість за періодом), checkbox (кількість true/false). Text/url/user як метрика недоступні (лише як фільтр). Значення для агрегації беруться через той самий типізований каст; віджет над polем без прапорця indexed на великому обсязі попереджає про можливу вартість. Права: кастомне поле сутності, недоступної користувачу (напр. поле на employees без people.read), у конструкторі віджета не пропонується.

**Реєстр (доповнення до 5.3):** `custom_field_definitions` несе, окрім entity_type/key/label/type/options/required/position/show_in_list, ще `is_sortable` і `indexed` (керують поведінкою вище). Ключ незмінний після створення (перейменування = новий ключ + міграція), бо на нього зіпертий JSONB-доступ і індекси.

---

## 6. Auth і користувачі

- Вхід email + пароль; користувачів створює Admin (інвайт-лінк на email, встановлення пароля). Опційна TOTP 2FA. Self-signup відсутній.
- Сесії cookie-based (web/desktop); API-токени для MCP/інтеграцій: створюються в профілі, скоуп ⊆ permissions власника, read_only-прапор, показ секрету один раз, відкликання, last_used_at.
- Профіль: імʼя, аватар, часовий пояс, мова (uk/en), налаштування email-нотифікацій за типами, активні сесії з можливістю завершити.
- Rate limit на auth: 10 спроб/хв/IP; блокування акаунта після 20 невдач з розблокуванням адміном або за часом.
- Деактивація користувача: сесії і токени відкликаються, історичні записи лишаються (FK не рвуться), задачі пропонується переасайнити майстром деактивації.

---

## 7. Модуль CRM (референс: Twenty)

### 7.1. Призначення

Джерело правди про шлях від знайденого prospect до клієнта. Компанія лишається стабільним хабом для контактів, leads, угод, проєктів, документів і рахунків; lead описує ще не кваліфікований sales pursuit, а deal — підтверджену комерційну можливість. CRM за замовчуванням відкриває Work і відповідає не лише «що є», а й «що робити далі».

### 7.2. Компанії

- CRUD; статуси lead → active → paused → archived (перехід вільний, пишеться в activity).
- Картка: шапка (назва, домен з фавіконом, статус, owner, теги-мітки), таби: Огляд / Контакти / Leads / Угоди / Проєкти / Рахунки і Quotes (видимі тільки з finance.read) / Нотатки / Файли / Активність.
- Огляд: обчислені бекендом показники: виставлено/сплачено/дебіторка (за валютами), активні проєкти й відкриті задачі, незабільлений час (з time, для finance.read), останні події; для користувача без finance.read фінансові плитки відсутні у відповіді API (не приховані на фронті, а не віддані).
- Реквізити: billing_email, адреса, валюта, платіжні умови (днів), portal_token (розділ 11.8).
- Кастомні поля з реєстру; конфігуровані колонки списку включно з кастомними.

### 7.3. Контакти

CRUD у межах компанії; is_primary (дефолтний отримувач документів); швидке створення з картки; пошук по контактах у глобальній палеті.

### 7.4. Leads і Work

- Lead належить компанії, може мати запропонований контакт і owner, зберігає product/service pursuit та нотатки кваліфікації: signal, evidence, fit, timing, score, джерела й дату перевірки, suggested channel, opener і caution. Заводиться вручну через UI, REST або MCP.
- Статуси lead: `new`, `needs_review`, `ready`, `waiting_reply`, `engaged`, `nurture`, `converted`, `disqualified`, `no_response`. `nurture` вимагає валідну дату повернення `YYYY-MM-DD`; планування нової активності атомарно повертає lead у `ready`.
- Sales activity належить рівно одному lead або deal і має тип, status `planned|completed|cancelled`, канал, тему/context, owner, обовʼязковий `due_at`, outcome та звʼязки з template/sequence. Complete може змінити lead status і створити наступну активність в одній транзакції.
- `/crm` відкриває Work: `overdue`, `dueToday`, `upcoming`, `waitingReply`, `nurtureDue`, `noNextAction` — саме в такому порядку, бо це порядок робочого дня. `upcoming` тримає записи із запланованою наступною дією пізніше сьогодні: без нього повністю розпланований тиждень показував порожню чергу. Дію на рядку визначає bucket: завершити прострочене й сьогоднішнє, запланувати нерозплановане, решту лише читати. Ранковий дайджест шле тільки те, що потребує дії (`overdue + dueToday + nurtureDue + noNextAction`). Межі «сьогодні» рахуються у timezone користувача. Дефолтний scope — власні та ніким не призначені записи; team scope явний. Кожен bucket повертає точний total незалежно від ліміту рядків.
- Конверсія lead → deal і зворотна демоція legacy Lead-stage deal виконуються транзакційно та переносять notes, files, activities, active sequence і source links без втрати історії.

### 7.5. Угоди (пайплайн)

- deal_stages конфігуруються: назва, порядок, probability %, прапорці won/lost (мінімум по одному won і lost).
- Kanban містить лише кваліфіковані можливості, має drag-and-drop, список із фільтрами та сумарні значення й weighted-суми (amount × probability) по етапах. `amount` може бути невідомим; змішані валюти не підсумовуються в одне число.
- Угода: назва, компанія, сума+валюта, очікувана дата, owner, кастомні поля, нотатки, файли, активність.
- Перенос у lost: обовʼязкова причина. Перенос у won: подія `deal.won` → автоматизація пропонує створити проєкт (pre-filled клієнт/назва) і/або quote.
- Конверсія: кнопки "Створити проєкт з угоди", "Створити quote з угоди" (з сумою одним рядком).

### 7.6. Playbooks

- Message templates зберігають activity type, channel, subject і body. Доступні змінні: `{{companyName}}`, `{{contactFirstName}}`, `{{contactName}}`, `{{ownerName}}`, `{{leadTitle}}`.
- Sequence — впорядкований список ручних кроків із delay у днях та optional template. Enrollment дозволений лише для одного lead або deal і створює першу planned activity; complete поточного кроку планує наступний, terminal/nurture state або закриття deal зупиняє enrollment.
- Sequence ніколи не надсилає email або LinkedIn-повідомлення автоматично. Вона лише створює контрольовану наступну дію для людини.
- Після першого використання steps immutable; назву, description і active-прапорець можна змінювати з optimistic locking.

### 7.7. Нотатки й активність

Rich-text нотатки на компанії/контакті/lead/угоді, pinned. Активність: автоматична стрічка з activity_log: зміни статусів та етапів, sales activity lifecycle, sequence enrollment, конверсії, створення проєктів, документи, оплати, нотатки. Audit diff містить лише поля, які реально змінювались, і не дублює message context без потреби.

---

## 8. Модуль Projects (референс: Plane)

### 8.1. Проєкти

- Обовʼязкові: назва, key (2-5 літер, унікальний), kind (client|internal). Для kind=client клієнт обовʼязковий; для kind=internal клієнта немає (company_id NULL). Опційно: тип проєкту (project_types: конфігурований довідник з іконкою/кольором: Website, Retainer…), шаблон.
- Створення з шаблону (project_templates): шаблон розгортає воркфлоу статусів, типи задач, мітки, привʼязаний KB-простір зі стартовими сторінками, дефолтні saved views. Шаблони створюються з нуля або "зберегти поточний проєкт як шаблон".
- Статуси проєкту: active/paused/completed/archived. `project.completed` → автоматизації: підказка "є незабільлений час / немає рахунку → створити рахунок?", пропозиція закрити активний цикл.
- Visibility: workspace | private (розділ 4.4). Сторінка: шапка (клієнт, lead, тип, дати, прогрес), таби: Задачі / Цикли / Огляд / Сторінки (KB-простір проєкту) / Час (з time.read_all або свої) / Рахунки (finance.read) / Файли / Налаштування (project admin).

### 8.2. Воркфлоу статусів задач

- task_statuses пер-проєкт: створення/перейменування/колір/порядок/видалення (з міграцією задач у вказаний статус). Кожен статус у категорії backlog/todo/in_progress/done/canceled: категорії дають системі семантику (прогрес, фільтри "відкриті", автоматизації), назви й кількість статусів довільні.
- Дефолтний воркфлоу нового проєкту: з шаблону або воркспейс-дефолт (Налаштування → Проєкти → Дефолтний воркфлоу).

### 8.3. Задачі

- Номер `KEY-42` (тригер БД, per-project sequence). Поля: назва, опис (rich text), статус, тип (task_types: конфігуровані, воркспейс-рівень + пер-проєктні перевизначення: Task/Bug/Feature/Request…), пріоритет (none/low/medium/high/urgent: фіксований набір), виконавці (множинні), дати start/due, estimate (одиниця з налаштувань проєкту: години або поінти), цикл, мітки, підзадачі (дерево до 5 рівнів, прогрес батька рахується по дітях), звʼязки, вкладення, кастомні поля.
- **Звʼязки і залежності (task_relations):** розділені за семантикою, як у Plane. Залежності планування: blocks / blocked by: впливають на порядок робіт, рендеряться конекторами в Timeline, порушені залежності (блокер завершується пізніше за залежну задачу) підсвічуються; blocked-задача маркується у списках, закриття з незакритими блокерами дає попередження (не заборону). Контекстні звʼязки: relates to / duplicates: лише навігаційний контекст у панелі. Кастомні типи звʼязків не реалізуються (компроміс, 22).
- **Зовнішні лінки:** довільні URL на задачі (title + url): специфікації, дизайни, тікети клієнта.
- **Вигляди:** List (групування статус/пріоритет/виконавець/тип/мітка, inline quick-add рядок: назва + Enter створює задачу з дефолтами), Board (kanban за статусами або виконавцями, drag-and-drop), Calendar (за due), Timeline (Gantt: смуги start→due, drag для змін дат, конектори залежностей), Spreadsheet (грід з инлайн-редагуванням полів у клітинках, масове редагування колонки). Вигляд+фільтри+групування зберігаються в saved_views: особисті, shared і workspace-рівня (крос-проєктні, для projects.read).
- **Драфти:** недописана задача (закрив модалку, обірвався звʼязок) автозберігається в чернетки користувача (без номера); розділ Drafts у сайдбарі, продовження редагування або відкидання. Номер видається при публікації.
- **Активність задачі:** таби Все / Коментарі / Історія (системні зміни полів з actor) / Worklogs (записи часу з модуля Time).
- Фільтри: статус (і категорія), тип, пріоритет, виконавець, мітки, цикл, дати (прострочені, цей тиждень…), текст. В API `GET /tasks` вікно дат — це `dueFrom`/`dueTo` за due_date (задача без дати в нього не потрапляє, як і має бути для календарного зрізу), а `label` приймає список через кому і звужує: задача повинна нести всі перелічені мітки. Масові дії: статус, виконавець, мітки, цикл, пріоритет.
- Peek-панель справа + повна сторінка `/projects/KEY/tasks/42`. Коментарі rich text зі згадками @user (нотифікація), реакціями-емодзі, edited-позначкою.
- Швидке створення: глобальний хоткей C, парсинг швидкого синтаксису в назві (`!high`, `#label`, `@user`, `%type`), створення прямо в колонці борда, конвертація коментаря в задачу.
- Дублювання задачі; переміщення задачі між проєктами (номер видається новий, старий лишається редиректом); архів задач (окремий фільтр).

### 8.4. Цикли

- Пер-проєктні таймбокси: назва, start/end, goal. Одночасно один active цикл на проєкт; upcoming → active автоматично за датою (воркер) або вручну.
- Задача належить максимум одному циклу. Борд/список фільтруються за циклом; сторінка циклу: прогрес (done/усі, за estimate якщо ведеться), burndown-графік (знімок відкритого обсягу щодня: таблиця cycle_snapshots, воркер опівночі), розбивка за виконавцями.
- Завершення циклу: підсумок + майстер перенесення незакритих задач (у наступний цикл / у backlog). `cycle.completed` подія.

### 8.5. Крос-проєктні екрани

- **Мої задачі:** всі проєкти, групування прострочені/сьогодні/тиждень/пізніше + свої створені без виконавця.
- **Всі задачі** (для projects.read): глобальний список з фільтром за проєктами, збережені вигляди.

### 8.6. Intake (вхідні запити)

Референс: Plane Intake. Канал структурованого входу запитів від клієнтів і команди без прямого доступу до проєкту:

- **Джерела:** публічна форма `/intake/{form_token}` (пер-проєктний токен, вмикається в налаштуваннях проєкту: поля назва/опис/email/вкладення, брендінг з реквізитів воркспейсу) і опційна поштова скринька (IMAP-полінг воркером: лист → intake-запит, вкладення переносяться).
- **Тріаж:** черга Intake у проєкті (бачать project admin/member): pending-запити з превʼю; дії: Accept (відкривається пре-заповнена модалка створення задачі: тип, статус, виконавець; запит отримує created_task_id) або Decline (з причиною; за наявності email запитувача: опційний лист-відповідь з шаблону).
- Запитувач за email отримує підтвердження прийому і, опційно, нотифікацію про прийняття (без деталей внутрішньої задачі).
- Anti-abuse: rate limit на форму, honeypot-поле, регенерація токена.

### 8.7. Шаблони задач і повторювані задачі

- **Шаблони задач** (воркспейс + пер-проєктні): пре-заповнені назва-патерн, опис, тип, пріоритет, мітки, естімейт, набір підзадач. Використання: з модалки створення, з intake-accept, з повторюваних.
- **Повторювані задачі:** правило: проєкт + шаблон + частота (daily/weekly/monthly/custom cron) + наступний запуск + активність. Щоденний воркер створює задачу із шаблону (ідемпотентно), зсуває next_run. Кейси: регулярні чеклісти підтримки, щомісячні звіти клієнтам.

---

## 9. Модуль Knowledge Base (референс: Plane Pages)

### 9.1. Призначення

Документація агенції і проєктів: брифи, процеси, онбординги, специфікації. Живе поруч із задачами, привʼязується до проєктів, з контролем доступу.

### 9.2. Простори

- kb_spaces: воркспейс-рівня (напр. "Процеси агенції", "HR") і проєктні (створюється автоматично разом з проєктом за прапорцем шаблону або вручну; project_id заповнений).
- Доступ: workspace-простори за visibility+space_members; проєктні успадковують членство проєкту (4.4). kb.manage_spaces: створення/видалення просторів воркспейс-рівня.

### 9.3. Сторінки

- Дерево сторінок у просторі (вкладеність без жорсткого ліміту, drag-переміщення в дереві, переміщення між просторами з перевіркою прав).
- Редактор Tiptap: заголовки, списки, чекбокси, таблиці, код-блоки з підсвіткою, callout, зображення (S3), вбудовування файлів, роздільники, toggle-блоки.
- **Згадки:** `@user` (нотифікація), `#KEY-42` (лінк на задачу з живим статусом), `[[назва сторінки]]` (лінк на сторінку). Всі згадки пишуться в kb_page_links → секція Backlinks на задачі і сторінці ("де це згадується").
- **Версії:** кожні збереження (дебаунс 30 с) створює kb_page_versions; історія версій з diff-переглядом і відновленням. Redo-safe: відновлення створює нову версію.
- **Блокування:** відкриття в режимі редагування ставить soft-lock (locked_by, heartbeat); інший користувач бачить "редагує X", може відкрити read-only або перехопити (lock старіший 2 хв).
- Шаблони сторінок (is_template): "Створити з шаблону"; шаблони в межах простору і глобальні.
- Публікація: draft/published прапорець: draft бачать editor-и простору, published усі, хто має доступ до простору.
- **Видимість на рівні сторінки** (модель Plane): public (усі з доступом до простору) або private (автор + admin-и простору). Видимість не успадковується автоматично: приватна дочірня сторінка невидима читачам публічного батька; дерево рендериться з фільтрацією прав.
- **Коментарі до сторінки:** тред коментарів під сторінкою (rich text, згадки), для обговорення без правок тіла.
- **Конвертація в задачу:** виділений блок сторінки → "Створити задачу" (модалка з пре-заповненим описом і зворотним лінком на сторінку): нотатки зустрічі стають задачами без виходу з документа.
- Експорт сторінки в Markdown; повнотекстовий пошук по тілу (tsvector з JSON-тіла) інтегрований у глобальну палету з ранжуванням.

---

## 10. Модуль Time (тайм-трекінг)

### 10.1. Призначення

Облік часу по задачах для двох цілей: внутрішня картина завантаження і білінг клієнтам за годинною моделлю.

### 10.2. Функціонал

- **Таймер:** старт/стоп на задачі (один активний таймер на користувача; старт нового зупиняє попередній); індикатор активного таймера в топбарі всюди; нотатка до запису.
- **Ручні записи:** дата, тривалість, задача, нотатка; редагування своїх записів; time.manage: редагування чужих.
- **Billable:** прапорець (дефолт з налаштувань проєкту); hourly_rate знімається в запис у момент створення з project_rates (персональна ставка → дефолт проєкту → 0).
- **Ставки:** project_rates у налаштуваннях проєкту (валюта = валюта клієнта): дефолтна ставка проєкту + перевизначення на користувача. Редагує project admin з finance.settings або time.manage.
- **Звіти (time.read_all):** зведення за період: за проєктами / людьми / клієнтами; billable vs non-billable; незабільлений billable-час (invoice_item_id IS NULL) як окремий зріз. Експорт CSV.
- **Мій час:** тижнева сітка своїх записів, редагування инлайн.

### 10.3. Звʼязка з фінансами

Генерація рахунку з часу (finance.write): майстер "Виставити час": клієнт → період → вибір проєктів → перегляд незабільлених записів (групування: за задачею / за користувачем / одним рядком) → створюється draft-рахунок, invoice_items з source=time, записи отримують invoice_item_id. Скасування рахунку або видалення позиції відвʼязує записи (стають знову незабільленими). Записи, привʼязані до позиції, блокуються від редагування тривалості.

---

## 11. Модуль Finance (референс: Invoice Ninja)

### 11.1. Межі

Операційні фінанси: quotes, рахунки, оплати, дебіторка, нагадування, витрати. Не бухгалтерія: подвійний запис, податкова звітність і легальний e-invoicing compliance поза системою (зовнішні інструменти); за потреби legal-інтеграція додається окремим модулем через шину подій без зміни моделі.

### 11.2. Quotes (комерційні пропозиції)

- Життєвий цикл: draft → sent → viewed → accepted | declined | expired (expired: воркер по valid_until).
- Структура ідентична рахунку (позиції, податки, знижка, PDF, публічна сторінка `/q/{token}`).
- На публічній сторінці клієнт натискає Accept/Decline (з коментарем): подія `quote.accepted` → нотифікація owner-у + автоматизація пропонує конвертувати.
- Конвертація в рахунок: копіює позиції, ставить quote_id, quote отримує converted_invoice_id. Quote після sent не редагується: тільки дублювання новою версією.

### 11.3. Рахунки

- Створення: з нуля / з проєкту (pre-filled) / з quote / з часу (10.3) / дублюванням / recurring-шаблоном.
- Номерація: конфігурований шаблон `INV-{YYYY}-{seq:4}` (окремі послідовності для invoices/quotes, атомарні, reset-період none/year).
- Позиції: опис, кількість, ціна, податкова ставка з довідника; суми рахує тільки сервер. Знижка рахунку: відсоток або фіксована, до чи після податків (налаштування). Мова документа uk/en (шаблон PDF локалізований).
- **Життєвий цикл:** draft → sent → viewed → partially_paid → paid; canceled з будь-якого несплаченого; is_overdue: обчислюваний прапорець (due_date < today і не paid/canceled). Всі переходи через сервіс з валідацією матриці переходів; після sent позиції незмінні: правки через cancel + duplicate (пишеться звʼязок).
- **PDF:** Typst-шаблон, один мінімалістичний дизайн: логотип, реквізити агенції (з налаштувань), реквізити клієнта, позиції, підсумки, terms/notes, QR з посиланням на публічну сторінку. Артефакт кожної відправки імутабельно в S3.
- **Відправка:** email (шаблон з email_templates) на billing_email/обраний контакт, PDF у вкладенні + публічний лінк. Повторна відправка можлива.
- **Публічна сторінка** `/i/{public_token}`: перегляд, завантаження PDF; перше відкриття → viewed + подія. Місце під кнопку онлайн-оплати зарезервовано (платіжний провайдер: окремий майбутній модуль).

### 11.4. Оплати і кредит-ноти

- Фіксація платежу: сума, дата, метод (bank/card/cash/other), референс. Часткові: список платежів, amount_paid і статус перераховуються. Переплата заборонена (Σ payments + Σ credit_notes ≤ total).
- Кредит-нота: зменшення заборгованості по рахунку (сума, причина); враховується в балансі рахунку і дебіторці.
- Видалення платежу (finance.payments + підтвердження): відкат статусу, activity з diff.

### 11.5. Повторювані рахунки

Шаблон: клієнт, проєкт, позиції, частота (weekly/monthly/quarterly/yearly), next_issue_date, auto_send, кінець (дата/кількість/безстроково). Щоденний воркер: створює draft або одразу відправляє, зсуває next_issue_date, подія `invoice.created(source=recurring)`. Пауза/відновлення.

### 11.6. Нагадування

reminder_rules: зсуви від due_date (напр. -3, +1, +7, +14 днів), кожне зі своїм email-шаблоном (плейсхолдери: {client}, {number}, {total}, {due_date}, {link}). Щоденний воркер: ідемпотентно через reminder_log; reminders_paused на рахунку вимикає. Ручна відправка нагадування з рахунку. Late fees не реалізуються (компроміс, 22).

### 11.7. Витрати

Журнал: сума, валюта, дата, категорія (довідник), опційно клієнт/проєкт, вкладення-чек, опис. У огляді проєкту (finance.read): витрати проти виставленого. Не бухгалтерія: без ПДВ-обліку витрат.

### 11.8. Клієнтський портал (легкий)

Сторінка `/portal/{company.portal_token}` без автентифікації (unguessable token, регенерується): список документів клієнта: рахунки (статуси, суми, лінки на публічні сторінки) і quotes. Дає клієнту одну постійну адресу замість розсипу лінків. Вимикається пер-клієнтно. Повноцінний портал з логіном не реалізується (компроміс, 22).

### 11.9. Фінансовий дашборд і списки

Дашборд (finance.read): дебіторка сумарно і aging 0-30/31-60/61-90/90+ (за валютами), виставлено/сплачено за період, прострочені списком, очікувані оплати за due_date, топ боржників, незабільлений billable-час (місток у 10.3). Списки рахунків/quotes: фільтри статус/клієнт/проєкт/період, підсумки під фільтром, масові нагадування, експорт CSV.

### 11.10. Собівартість і прибутковість (cost & profitability)

Референс: Productive.io (agency-management: cost rates, overhead, project/client profit). Це відповідь на "бачити витрати по ЗП і т.п." на рівні бізнесу: не скільки нарахувати людині (payroll, якого нема), а скільки нам коштує робота і скільки ми на ній заробляємо. Доступ: `finance.read_costs` (окреме від finance.read: можна бачити рахунки й дебіторку, але не собівартість і ЗП).

- **Вартість години праці:** бере cost rate співробітника (12.5) + overhead per hour (12.5, якщо ввімкнено) як знімок на момент запису часу; тому кожен time-entry має not лише billable-суму (ставка клієнту), а й cost-суму (собівартість). Історичність компенсації (versioned) гарантує коректність минулих періодів.
- **Прибутковість проєкту:** revenue (виставлено або billable-час за ставками клієнта) мінус витрати (собівартість відпрацьованих годин + небіллабельні витрати проєкту з expenses + біллабельні витрати без маркапу) = маржа проєкту (сума і %). Зріз на картці проєкту (таб Огляд, за finance.read_costs) і в звіті.
- **Прибутковість клієнта:** та сама модель, агрегована по всіх проєктах клієнта: показує, хто приносить прибуток, а хто в мінусі (ключова цінність Productive-класу).
- **Витрати на ЗП (labor cost):** агрегований звіт: собівартість праці за період, розбивка за співробітником / командою / проєктом / клієнтом; billable vs non-billable години у грошах (скільки коштує небіллабельний час). Це і є "витрати по ЗП" в операційному сенсі.
- **Utilization:** % біллабельних годин від доступних (з урахуванням відсутностей з 12.2) per людина/команда: показує, наскільки завантаження конвертується у виставлене.
- **Звіти-конструктор:** profit згрупований за клієнтом/проєктом/періодом з фільтрами, як у Productive; експорт CSV; ці ж метрики доступні віджетами кастомних дашбордів (джерело "profitability", лише з finance.read_costs).

Межа: це управлінська аналітика на основі cost rate і годин, а не бухгалтерський P&L і не payroll. Точні нарахування ЗП, податки, відомості – поза ordi (зовнішній інструмент), як і legal-частина Finance (11.1).

---

## 12. Модуль People (HR)

Референс: Frappe HR (open-source HRMS: lifecycle, leaves, attendance, recruitment). Береться модель і термінологія, адаптовані під масштаб агенції. Свідомо НЕ береться: payroll-движок з формульними компонентами і регіональним податковим compliance (генерація зарплатних відомостей, слабів, податкові слаби) – це бухгалтерсько-юридична зона, яку ordi не покриває (та сама межа, що й у Finance, розділ 11.1). Зарплата в ordi присутня як атрибут вартості співробітника для аналітики (12.5 + 11.x), а не як розрахунковий движок нарахувань.

Доступ до модуля керується окремим доменом permissions `people.*` (нижче), бо HR-дані чутливі й не мають бути видимі всім із доступом до проєктів.

### 12.1. Співробітники (employee records, lifecycle)

- **Картка співробітника:** привʼязка до user (nullable: можна вести підрядника без облікового запису), імʼя, контакти, посада, відділ/команда, тип зайнятості (full-time/part-time/contractor), менеджер (self-reference), дати join/probation-end/exit, статус (active/on_leave/terminated), емердженсі-контакт, кастомні поля, документи (вкладення: контракт, скани). Persona-поля (дата народження, адреса тощо) видимі лише за `people.read_sensitive`.
- **Lifecycle:** статусні переходи з подіями (`employee.onboarded`, `employee.exited`). Онбординг/офбординг як чеклісти: шаблон онбордингу (набір задач) при найманні автоматично створює задачі у внутрішньому HR-проєкті (kind=internal) і асайнить відповідальних (місток у Projects через шину, як у Frappe HR, де boarding auto-створює задачі).
- **Довідник відділів/команд і посад** (конфігуровані); оргструктура через поле менеджера (дерево).

### 12.2. Відпустки і відсутності (leaves)

- **Типи відсутностей** (конфігуровані): щорічна відпустка, лікарняний (sick leave), відгул, неоплачувана, компенсаційний, кастомні. Параметри типу: оплачувана/ні, чи потребує апруву, чи зменшує баланс, чи дозволений half-day, річна квота, перенос залишку (carry-forward) з лімітом і терміном згорання.
- **Баланси:** нарахування квоти на період (річне, помісячне-earned), таблиця leave_balances per співробітник per тип; перегляд балансу співробітником.
- **Заявки (request → approval):** співробітник подає заявку (тип, діапазон дат або half-day, коментар, опційне вкладення напр. довідка); маршрут апруву: менеджер співробітника, з фолбеком на роль `people.approve_leave`. Стани: pending → approved | rejected | canceled. Апрув списує баланс; скасування повертає. Конфлікт (перекриття з наявною заявкою) блокується.
- **Календар відсутностей:** командний календар хто коли відсутній (з урахуванням прав); інтеграція в резолвінг завантаження (Resourcing, 12.4) і попередження при асайні задачі на людину у відпустці.
- **Holiday calendars:** конфігуровані святкові календарі (пер-регіон/офіс), призначаються співробітникам; впливають на робочі дні в розрахунках і календарі.
- Нотифікації: подання заявки → менеджеру; рішення → співробітнику; наближення відпустки → команді (опційно).

### 12.3. Хайринг (recruitment)

- **Вакансії (job openings):** назва, відділ, тип зайнятості, опис, статус (draft/open/on_hold/closed), кількість позицій, гайрінг-менеджер, опційно вилка ЗП (діапазон, видима лише `people.read_sensitive`).
- **Публічна сторінка вакансії** `/careers/{token}` (опційно вмикається): опис + форма відгуку (імʼя, email, résumé-вкладення, супровідний текст). Anti-abuse як в intake (rate limit, honeypot).
- **Кандидати (applicants) і пайплайн:** kanban за етапами (конфігуровані: Applied → Screening → Interview → Offer → Hired / Rejected), картка кандидата (контакти, résumé, звʼязок з вакансією, оцінки інтервʼюерів, нотатки, історія). Перетягування між етапами; rejected з причиною. Дублікат-детект за email.
- **Інтервʼю:** запис інтервʼю (кандидат, інтервʼюери, дата/час, тип, підсумок/скоркард). Нагадування інтервʼюерам.
- **Найм:** етап Hired на кандидаті → дія "Створити співробітника" (пре-заповнена картка employee з даних кандидата, запускається онбординг-чекліст 12.1). Подія `applicant.hired`.

### 12.4. Resourcing (завантаження команди)

Шар планування завантаження (аналог Resourcing у Productive, спрощений: повний capacity-planning з прогнозними плейсхолдерами не робимо, див. компроміс у 22). Тижневий вигляд хто на які проєкти алоцений, з урахуванням відсутностей (12.2). Джерело алокацій: призначення задач із дедлайнами + явні алокації (allocation: user, project, годин/тиждень, період). Мета: бачити перевантаження і вікна, і живити utilization-аналітику (11.10). Входить у 1.0 як повноцінний модуль; поза скоупом лишаються лише прогнозні плейсхолдери (алокація на ще-не-найнятого) і сценарне forecasting, що зафіксовано в компромісах.

### 12.5. Компенсація співробітника (cost rate) – містковий підрозділ між People і Finance

Тут живе твоє "бачити ЗП і витрати по ЗП". Це свідомо НЕ payroll (нарахування/слаби/податки), а вартісна ставка людини для розрахунку собівартості й прибутковості. Модель – з Productive (cost rate + overhead), не з Frappe payroll:

- **compensation** per співробітник: тип (місячна ЗП / годинна ставка / контракторський рейт), сума, валюта, період дії (versioned: історія змін ЗП з датами, тому собівартість минулих періодів рахується коректно). Видима лише за `people.read_compensation` (найвужче право, окреме від решти HR).
- **Cost rate (годинна собівартість):** обчислюється з компенсації і норми годин (робочі години/тиждень з налаштувань). Для контрактора – прямий рейт. Cost rate – це те, що множиться на відпрацьовані години з модуля Time для собівартості.
- **Overhead (опційно):** company overhead per hour (фасіліті + внутрішні/небіллабельні витрати), як у Productive: конфігурована місячна база накладних розкидається на робочі години й додається поверх cost rate. Дає "справжню" собівартість години.

Ці дані споживає фінансова аналітика (нижче) і собівартість проєкту. Самі суми ЗП ніде, крім карток за правом `people.read_compensation` і агрегованих звітів за правом `finance.read_costs`, не показуються.

### 12.6. HR-дашборд і звіти

За правами: headcount (активні/у відпустці/нові/exits за період), майбутні відсутності (календар), відкриті вакансії і стан пайплайну кандидатів, найближчі кінці probation. Звіти: leave balances по команді, attendance-зведення (якщо ведеться), recruitment-воронка. Компенсаційні/costs-звіти – окремо, за `finance.read_costs` (12.5 + розділ 11.x).

### 12.7. Модель даних (People)

departments (name, parent_id), positions (title), employees (user_id?, first/last name, contacts, position_id, department_id, employment_type, manager_id, join_date, probation_end, exit_date, status, emergency_contact JSONB, sensitive JSONB, custom_fields), employee_documents (employee_id, attachment_id, type), leave_types (name, is_paid, needs_approval, affects_balance, allow_half_day, annual_quota, carry_forward_limit, carry_forward_expiry), leave_balances (employee_id, leave_type_id, period, allocated, used, carried), leave_requests (employee_id, leave_type_id, from_date, to_date, half_day bool, reason, attachment_id?, status, approver_id, decided_at), holiday_calendars (name), holidays (calendar_id, date, name), employee_holiday_calendar (employee_id, calendar_id), job_openings (title, department_id, employment_type, description, status, positions_count, hiring_manager_id, salary_range JSONB, public_token, public_enabled), applicants (job_opening_id, name, email, phone, resume_attachment_id, cover_text, stage, rejected_reason, source, created_from: form/manual), applicant_stages (name, position, is_hired, is_rejected), interviews (applicant_id, scheduled_at, type, interviewers JSONB, scorecard JSONB, summary), allocations (user_id, project_id, hours_per_week, from_date, to_date) [12.4], compensation (employee_id, comp_type, amount, currency, effective_from, effective_to), overhead_settings (monthly_base, currency, working_hours_per_week, effective_from).

### 12.8. Permissions (People) і чутливість

Окремий домен, бо HR-дані не мають розтікатися:

| Permission | Дає |
|---|---|
| `people.read` | Базовий довідник співробітників, оргструктура, публічні поля |
| `people.read_sensitive` | Persona-поля (д.н., адреса, документи), вилки ЗП у вакансіях |
| `people.read_compensation` | Компенсація співробітників (ЗП, ставки) – найвужче |
| `people.write` | Редагування карток, lifecycle |
| `people.manage_leave` | Налаштування типів/квот/календарів |
| `people.approve_leave` | Апрув заявок поза лінією менеджера |
| `people.recruit` | Вакансії, кандидати, інтервʼю, найм |
| `finance.read_costs` | Агреговані costs/ЗП-звіти й собівартість (у домені finance, бо це гроші) |

Системні ролі оновлюються: Owner/Admin – все. Преднастроєна роль **Sales** покриває sales workspace: `crm.*`, `deals.read/write`, плюс read-only на проєкти та фінанси (продавцю потрібно бачити, що доставляється і що оплачено, але не змінювати ні того, ні іншого). Нова преднастроєна роль **HR** (people.* повністю крім read_compensation, яку дають вибірково). Роль **Finance** отримує `finance.read_costs` (бачить агреговані витрати на ЗП, але не обовʼязково поіменні ставки: read_compensation видається окремо). Member/guest – жодних people.*: розділ People відсутній у навігації.

Кожен доступ до compensation і read_sensitive додатково пишеться в audit (хто дивився ЗП).

---

## 13. Інтеграції

### 13.1. Git (GitHub, GitLab, Gitea)

**Призначення:** задачі звʼязані з реальним кодом: гілки, коміти, PR/MR видимі з задачі, статуси рухаються автоматично.

**Підключення (integrations.manage):**
- GitHub: GitHub App через manifest flow – ordi створює App одним кліком
  (POST маніфеста → GitHub повертає креденшели через одноразовий код);
  вебхук і права реєструються централізовано, installation-вебхуки самі
  створюють підключення і синхронізують repo-список. Креденшели App
  (app id, приватний ключ, webhook-секрет) зберігаються у
  workspace_settings.integrations (секрети AES-GCM). Legacy-шлях (OAuth
  app / PAT) лишається робочим.
- GitLab / Gitea (включно з self-hosted): URL інстансу + access token; вебхук на repo/групу з секретом.
- Креденшели шифруються (AES-GCM, ключ у env). Налаштування → Інтеграції: статус підключення, перелік репозиторіїв, health останніх вебхуків.

**Привʼязка:** project_repositories: у налаштуваннях проєкту project admin привʼязує один чи кілька репозиторіїв підключення.

**Автолінкування (вхідні вебхуки `/api/v1/integrations/git/{provider}/webhook`, перевірка підпису):**
- Парсинг патерну `KEY-\d+` у назві гілки, повідомленнях комітів, назві/описі PR/MR.
- Знайдений збіг у привʼязаному до проєкту репозиторії → git_links (branch/commit/pr) на задачі; стан PR оновлюється подіями (open/merge/close).
- Панель задачі: секція Git: гілки, останні коміти, PR зі статусом і лінком.

**Зі сторони задачі:** кнопка "Copy branch name": генерує `{type-prefix}/{key-42}-{slug}` (шаблон конфігурується на проєкті).

**Автоматизації статусів (git_automation_rules, пер-проєкт):** конфігурована мапа: branch_created → In Progress; pr_opened → In Review (якщо статус існує); pr_merged → Done; pr_closed без merge → нічого/конфігуровано. Виконується через шину (`git.pr_merged` → обробник у projects/automations.ts); зміна статусу пишеться в activity з actor_type=integration.

**Надійність:** вебхуки кладуться в pg-boss і обробляються ідемпотентно (dedup за delivery id); ручний ресинк лінків задачі.

### 13.2. Вихідні вебхуки

webhook_subscriptions (settings): URL + secret + перелік подій з каталогу 3.3. Доставка воркером: HMAC-SHA256 підпис, retry з backoff (5 спроб), лог доставок з відповіддю. Це шлях для зовнішніх систем (Telegram-бот, n8n) без опитувань.

### 13.3. Внутрішні автоматизації (вбудовані правила)

Не конструктор автоматизацій (компроміс, 22), а фіксований набір конфігурованих правил, кожне вкл/викл у налаштуваннях:
- deal.won → пропозиція створити проєкт/quote.
- project.completed → пропозиція рахунку при незабільленому часі.
- quote.accepted → пропозиція конвертації.
- git-правила (13.1).
- invoice.overdue → нагадування (11.6).
- cycle end date настав → пропозиція завершення циклу.
- applicant.hired → створити співробітника + запустити онбординг-чекліст (12.3).
- leave_request submitted → нотифікація менеджеру; рішення → співробітнику (12.2).

---

## 14. Наскрізні підсистеми

### 14.1. Дашборд (стартовий екран)

Віджети за правами: Мої задачі сьогодні/прострочені; активний цикл мого основного проєкту; дебіторка і прострочені (finance.read); угоди за етапами (deals.read); стрічка останніх подій (відфільтрована за доступом). Одна відповідь `/api/v1/dashboard`.

**Кастомні дашборди** (референс: Plane Dashboards). Окрім стартового: користувацькі дашборди з віджетами на сітці (drag/resize). Віджет: конфігурований запит виду "для цих сутностей, згрупованих за X, показати метрику Y": типи bar / line / pie / число / таблиця; джерела: задачі (фільтри як у списках), рахунки, угоди, час; groupby: статус/тип/пріоритет/виконавець/проєкт/клієнт/період; метрика: кількість / сума (amount, estimate, тривалість). Видимість дашборда: private | workspace. Дані віджета обчислює бекенд одним ендпоінтом з примусовим накладанням прав (accessibleProjectIds + permission домену джерела: віджет по рахунках без finance.read не рендериться).

### 14.2. Command palette і пошук

`Cmd/Ctrl+K`: сутності (компанії, контакти, угоди, проєкти, задачі за номером/текстом, KB-сторінки, рахунки/quotes за номером), дії ("Створити…", "Перейти…", "Старт таймера…"), нещодавні. Результати фільтруються правами (пошуковий сервіс приймає accessibleProjectIds/space ids). Бекенд: FTS + trigram, ранжування: точний номер > заголовок > тіло.

### 14.3. Нотифікації

In-app (дзвіночок, read/unread, перехід до сутності) + email-дублювання за типами з профілю. Типи: згадка, призначення, коментар у моїй задачі, зміна статусу моєї задачі, quote accepted, оплата, прострочення, дедлайн сьогодні, git PR merged у моїй задачі, sales work digest.

Sales work digest запускається щогодини, але для кожного активного human-користувача з `crm.read` створюється не більше одного разу за його локальну дату й лише у локальному вікні 08:00–18:00. Summary включає overdue, due today, waiting reply, nurture due і no next action; deal work додається лише з `deals.read`. Ledger `sales_digest_runs(user_id, local_date)` записує також порожній ранок, щоб пізніша активність не породила другий «ранковий» digest. Email-копія керується окремим preference `sales.work_digest`.

Фонові notification/reminder emails не виконують SMTP I/O всередині outbox consumer. Consumer атомарно записує notification та ідемпотентний `email_deliveries` row, а окремий worker відправляє його з retry і stale-claim recovery. Інтерактивні document sends, де користувачу потрібен негайний результат, лишаються синхронними.

### 14.4. Activity log і чутливі дані

Кожна мутація сервісів пише запис: actor (user/agent/system/integration), action, diff (старі/нові значення змінених полів). Таб Активність на компанії/угоді/проєкті/задачі/рахунку; глобальна стрічка (audit.read) з фільтрами за actor/типом/періодом. Записи незмінювані.

Повний diff небезпечний: без обмежень він продублює ЗП, персональні дані й секрети у вічну незмінну таблицю. Тому:

- **Redaction-реєстр.** Поля, позначені чутливими (compensation.amount, employees.sensitive, salary_range у вакансіях, будь-які поля під people.read_compensation/read_sensitive), у diff НЕ пишуть значення. Пишеться лише факт зміни: `field: "compensation.amount", action: "changed"`, без старого/нового значення. Читач історії бачить, що ЗП змінили, коли і хто, але не суми.
- **Токени й секрети – ніколи.** api_tokens.hash, webhook.secret, git-креденшели, паролі не потрапляють у diff за жодних умов (виключені на рівні серіалізатора, не лише redacted): для них навіть факт-запис не містить матеріалу.
- **Позначка чутливості запису.** Записи, що стосуються HR/compensation-сутностей, мають `sensitivity: sensitive`. Це керує (а) видимістю (такі записи в загальній стрічці видно лише з people.read_sensitive/compensation, а не будь-кому з audit.read) і (б) політикою зберігання.
- **Політика зберігання.** Звичайний audit зберігається безстроково (аудит бізнес-дій цінний). Sensitive-audit має окреме, коротше вікно зберігання (конфігурується, напр. 24 міс) з наступним прибиранням значень-фактів понад строк: мінімізація чутливого сліду. Сам факт доступу до compensation/sensitive-полів (перегляд, не лише зміна) теж пишеться в sensitive-audit (хто дивився ЗП), як зазначено в 12.8.

Redaction застосовується централізовано в шарі, що формує diff (один серіалізатор з реєстром чутливих ключів), тому новий чутливий атрибут закривається доповненням реєстру, а не правками по всіх сервісах.

### 14.5. Файли

Presigned upload у S3, реєстрація attachment, ліміт 25 МБ, превʼю зображень/PDF, антивірусна перевірка не реалізується (компроміс), розширення виконуваних файлів блокуються.

### 14.6. Імпорт/експорт

Імпорт CSV: компанії, контакти, задачі (мапінг колонок, dry-run зі звітом помилок, транзакційне застосування). Експорт CSV: будь-який список у відфільтрованому стані (permission export відповідного домену). Експорт KB: Markdown-архів простору. Повне резервування (PITR БД + реплікація вкладень) і цілі RPO/RTO: розділ 19.2.

### 14.7. Налаштування (мапа розділів)

| Розділ | Зміст | Permission |
|---|---|---|
| Воркспейс | Назва, логотип, реквізити для PDF, робочі дні | settings.manage |
| Користувачі | Інвайти, ролі, деактивація | users.manage |
| Ролі | Редактор матриці permissions | roles.manage |
| Проєкти | Типи проєктів, шаблони, дефолтний воркфлоу, типи задач (воркспейс), мітки | settings.manage |
| CRM | Етапи угод, статуси компаній (лейбли) | settings.manage |
| Кастомні поля | Реєстр за сутностями | settings.manage |
| Фінанси | Номерація, податкові ставки, категорії витрат, правила нагадувань, email-шаблони, валюта за замовчуванням | finance.settings |
| Час | Дефолт billable, одиниці естімейтів | settings.manage |
| People (HR) | Відділи, посади, типи відсутностей і квоти, святкові календарі, етапи рекрутингу, шаблони онбордингу | people.manage_leave / people.recruit |
| Компенсація і накладні | Overhead-база, робочі години/тиждень, ставки | finance.settings + people.read_compensation |
| Інтеграції | Git-підключення, вихідні вебхуки | integrations.manage |
| API-токени | Свої токени | будь-хто (свої) |
| Аудит | Глобальна стрічка | audit.read |
| Кошик | Soft-deleted, відновлення/hard delete | settings.manage |

### 14.8. Кастомізація (зведення можливостей)

Все нижче: дані, не код: статуси задач пер-проєкт (+ воркспейс-дефолт), типи задач (воркспейс + пер-проєкт), типи проєктів, шаблони проєктів (повний blueprint), шаблони задач, повторювані задачі, intake-форми пер-проєкт, шаблони KB-сторінок, видимість сторінок, етапи пайплайну з probability, типи відсутностей і квоти, святкові календарі, етапи рекрутинг-пайплайну, шаблони онбордингу, кастомні поля 8 типів на сутностях (включно з employees/applicants), кастомні ролі з матрицею permissions, saved views особисті/shared/workspace, кастомні дашборди з віджетами, формат номерації документів, email-шаблони, правила нагадувань, git-автоматизації пер-проєкт, шаблон назви гілки, ставки часу пер-проєкт/пер-користувач, overhead, мова PDF пер-документ.

---

## 15. REST API

### 15.1. Конвенції

- База `/api/v1`, JSON; auth: cookie або Bearer-токен. Кожен маршрут: guard(permission) або public().
- Ресурсні CRUD + дієслівні операції: `POST /invoices/:id/send`, `POST /quotes/:id/convert`, `POST /tasks/:id/move`, `POST /cycles/:id/complete`, `POST /time/timer/start|stop`.
- Пагінація cursor-based; фільтри плоскими query-параметрами; `include=`-параметр для дозованих звʼязків (task?include=assignees,labels,git_links).
- Помилки `{error:{code,message,details}}`: 400 (Zod details), 401, 403 (з кодом required permission), 404 (і для ресурсів поза доступом: без витоку існування), 409 (конфлікт версій: мутація несе відому `version`, розбіжність повертає поточний стан), 422 (доменні правила).
- OpenAPI генерується з Zod (hono-openapi), публікується на `/api/docs`: контракт для MCP і зовнішніх інтеграцій.
- SSE `/api/v1/stream` з правами; публічні: `/i/:token`, `/q/:token`, `/portal/:token`, git-вебхуки.

### 15.2. Зріз ендпоінтів за доменами (повний перелік: OpenAPI)

core: auth/*, me (профіль+permissions+memberships+notification preferences), users, roles, search, dashboard, dashboards (+widgets, +widget-data), notifications, attachments (presign/register), custom-fields, saved-views, webhooks, audit, stream.
crm: companies (+overview), contacts, leads (+convert), sales-work, sales-activities (+complete/+cancel), sales-message-templates, sales-sequences (+enroll/+stop), deals (+move), deal-stages, notes.
projects: projects (+members, +repositories, +templates apply/save), task-statuses, task-types, project-types, tasks (+move, +relations, +links, +duplicate, +transfer), drafts, task-templates, recurring-tasks, intake (+accept, +decline, налаштування; публічна форма `/intake/:token`), comments, labels, cycles (+complete, +snapshots), me/tasks.
kb: spaces (+members), pages (tree, +versions, +restore, +lock, +export), templates.
time: entries CRUD, timer start/stop, rates, reports, unbilled.
finance: quotes (+send/accept-internal/convert/pdf), invoices (+send/cancel/duplicate/pdf/from-time), payments, credit-notes, recurring, expenses (+categories), tax-rates, reminder-rules, email-templates, finance/dashboard, finance/profitability (проєкт/клієнт/labor, лише finance.read_costs).
people: employees (+lifecycle, +documents), departments, positions, leave-types, leave-requests (+approve/reject), leave-balances, holiday-calendars, job-openings (+public `/careers/:token`), applicants (+move/hire), interviews, allocations, compensation (finance.read_costs/people.read_compensation), overhead-settings, people/dashboard.
integrations: git connections/repositories, project bindings, automation rules, resync.

---

## 16. MCP-сервер

Пакет packages/mcp: автентифікація API-токеном, всі виклики через REST (жодного прямого доступу до БД); права агента = скоуп токена, тому "агент бачить фінанси" вирішується так само, як для людини: роллю власника токена і скоупом.

Інструменти (обгортки 1-2 викликів зі стислими описами і Zod-схемами з shared):
- Читання: search (включно з тілами CRM-нотаток), list_projects (фільтр `key` — проєкт знаходиться за коротким кодом, напр. CONTENT), get_project_schema (статуси, типи задач, мітки задач і кастомні поля проєкту — словник, який приймають write-інструменти), list_tasks (вікно дат за dueDate, статус, мітки, тип, підрядок назви і кастомні поля; відповідь у календарному порядку), get_task (повна картка: текст, дата, статус, мітки, кастомні поля, виконавці, зовнішні посилання, коментарі і актуальна version), list_companies, list_contacts, list_deals, list_deal_stages, list_notes, list_custom_fields, list_users, list_kb_spaces, list_kb_pages, get_kb_page, get_company, get_contact, get_deal, get_company_overview, list_my_tasks, get_project_status, get_cycle_progress, list_overdue_invoices, get_receivables_aging, list_unbilled_time, find_kb_page. Кожен запис читається окремо і в списках повертається customFields: те, що агент записав, він має прочитати назад, не змінюючи запис заради читання. list_* — точка входу для отримання id: решта інструментів приймають projectId/companyId/dealId/stageId, які агенту більше не треба вгадувати; статуси, типи й мітки задач приймаються ще й назвами, а невідома назва повертає перелік наявних. Відповіді всіх інструментів проходять scrub: службові поля (version, deletedAt, templateSourceId) і секрети (portalToken) до контексту моделі не потрапляють — крім `version` у задачних інструментах, бо саме її агент повертає назад у запис.
- Дії: create_task (уся картка одним викликом: назва, текст, дата, статус, тип, мітки, кастомні поля, посилання), update_task (перезапис картки; expectedVersion з get_task — і чужа правка не затирається, а повертає 409 з поточною версією), upsert_task (створення-або-оновлення за власним унікальним ключем: ключ лежить у кастомному полі, тож повторний запуск тієї самої генерації оновлює ту саму задачу, а не заводить другу; якщо назву, текст, дату чи статус змінили в Ordi після останнього запису — відмова замість затирання, поки не передано force), add_task_link (джерело тренду до публікації, permalink опублікованого поста після; той самий url удруге — no-op), update_task_status, assign_task, comment_on_task, log_time, create_invoice_from_time, create_invoice_from_project, send_invoice, record_payment, send_payment_reminder, create_quote, create_note, update_note, create_company (відмовляє на дублікаті імені/домену), update_company, create_contact, update_contact, create_deal, update_deal (ownerId — і в create, і в update, id беруться з list_users), move_deal (разом зі структурованою причиною через customFields), create_custom_field і update_custom_field (потребують settings.manage у скоупі; замість видалення — deprecated), create_kb_page, update_kb_page, request_leave, approve_leave, create_job_opening, move_applicant. У всіх update-інструментах customFields мержаться по ключах: правка одного поля не стирає решту. Кожен write-інструмент має свою пару на читання і на переписування (нотатка, KB-сторінка, задача): те, що агент може записати, він може прочитати і виправити, інакше дублікати і застарілі записи нічим прибрати.
- CRM sales loop: `list_leads`, `get_lead`, `create_lead`, `update_lead`, `get_sales_work`, `list_sales_activities`, `schedule_sales_activity`, `update_sales_activity`, `complete_sales_activity`, `cancel_sales_activity`, `convert_lead`, `list_sales_playbooks`, `save_sales_message_template`, `save_sales_sequence`, `manage_sales_sequence`. `schedule_sales_activity` приймає `templateId` і рендерить placeholders на API; sequence enrollment планує ручні дії, але не надсилає повідомлення.
- Помилки інструменту несуть код API (not_found, forbidden, version_conflict, validation_error) і дію, якою це лікується: конфлікт версій каже перечитати задачу через get_task і накласти зміну на актуальну версію, дубль — назву й ref наявного запису, відсутній доступ — що бракує саме скоупу токена.
- Читання (People/costs, лише в межах прав токена): list_pending_leave, get_team_availability, get_recruitment_pipeline, get_project_profitability, get_labor_cost (останні два вимагають finance.read_costs у скоупі токена; без нього інструмент недоступний).

Generic delete та незворотні адміністративні операції через MCP не виставляються. `cancel_sales_activity` є явною, аудитованою lifecycle-командою для planned activity, а не generic delete. Всі дії пишуться в activity з actor_type=agent (службовий користувач Agent): у UI завжди видно, що зробив агент, з diff-ом.

---

## 17. UX-специфікація

### 17.1. Принципи

1. Щільність без тісноти: рядок списку ~40px, Inter, один акцентний колір, семантичні кольори тільки статуси/пріоритети.
2. Клавіатура як першоклас: Cmd+K палета; C нова задача; T старт/стоп таймера; G потім D/P/C/F/K навігація (дашборд/проєкти/клієнти/фінанси/KB); J/K по списку, Enter відкрити, E статус, A асайн, L мітки. Хоткеї в тултіпах і палеті.
3. Peek-панелі замість переходів (задача, рахунок, контакт, запис часу); прямий URL існує завжди.
4. Оптимістичні оновлення з відкатом і тостом.
5. Порожні стани навчають: речення + первинна дія + хоткей.
6. Модалки тільки для швидкого створення і підтверджень; редагування инлайн/панель.
7. Права формують інтерфейс: розділи і дії без доступу відсутні (не disabled), щоб member без finance.read взагалі не бачив грошей у навігації, табах і віджетах.

### 17.2. Навігація

```
┌──────────┬─────────────────────────────────────────┐
│ Дашборд  │  Заголовок + фільтри + перемикач вигляду│
│ Мої      │  ┌───────────────────────────┬────────┐ │
│  задачі  │  │ List/Board/Calendar/      │ Peek-  │ │
│ Клієнти  │  │ Timeline / картки / KB    │ панель │ │
│ Угоди    │  │                           │        │ │
│ Проєкти  │  └───────────────────────────┴────────┘ │
│  ├ KLD   │   [⏱ активний таймер: KLD-42 00:47]     │
│  └ APR   │                                         │
│ KB       │                                         │
│ Час      │                                         │
│ Фінанси  │  ← відсутній без finance.read           │
│ Люди     │  ← відсутній без people.read            │
│ ───────  │                                         │
│ Пошук ⌘K │                                         │
│ Налашт.  │                                         │
└──────────┴─────────────────────────────────────────┘
```

Sidebar згортається; активні проєкти пінляться; guest бачить тільки свої проєкти і простори. Мобільно: responsive ті самі екрани, нижня навігація; окремий мобільний застосунок не розробляється.

### 17.3. Ключові екрани

Дашборд; Мої задачі; Клієнти (список, картка з табами); Угоди (kanban, список); Проєкти (список; проєкт: задачі у 4 виглядах + peek, цикли з burndown, сторінки-дерево з редактором, час, налаштування з воркфлоу-редактором, доступом, git); KB (простори, дерево, редактор з версіями); Час (мій тиждень, звіти); Фінанси (дашборд, списки, редактор рахунку/quote: форма зліва + живий PDF-preview справа, прибутковість проєкта/клієнта за finance.read_costs); People (співробітники зі списком і карткою lifecycle, календар відсутностей і заявки, рекрутинг-канбан з картками кандидатів, HR-дашборд); публічні сторінки (invoice, quote з Accept/Decline, портал, intake-форма, careers-форма); Налаштування (14.7); Профіль.

### 17.4. Стани

Кожен список: loading (скелетони) / empty (навчальний) / error (retry) / data. Довгі операції (PDF, імпорт, експорт): серверні, з прогресом і можливістю піти. Деструктивні дії: підтвердження з імʼям сутності. 403 всередині сесії (роль змінили): екран "немає доступу" з поясненням, не білий екран.

---

## 18. Десктоп (Tauri)

Tauri 2 загортає білд apps/web; окремого UI-коду немає. Нативне: трей з лічильником нотифікацій; OS-нотифікації з SSE; глобальний хоткей quick-add (мале always-on-top вікно: задача або таймер); автозапуск; deep links `ordi://task/KLD-42`; updater з підписаними релізами з CI. Білди: macOS universal, Windows msi, Linux AppImage/deb. Перший запуск: URL інстансу API.

---

## 19. Нефункціональні вимоги

### 19.1. Безпека

HTTPS всюди (проксі Dokploy); паролі за Better Auth; API-токени SHA-256-хешами; git-креденшели AES-GCM. Zod на межі; параметризовані запити; санітизація rich-text на рендері; CSP. CSRF для cookie; CORS allowlist (web-домен, tauri://). Публічні токени 128-біт, rate limit, без перелічуваності; 404 замість 403 для чужих ресурсів. Секрети тільки env. RBAC-інваріанти покриті тестами (розділ 20).

### 19.2. Надійність, резервування і відновлення

**Формальні цілі (обовʼязкові вимоги, не побажання):**
- **RPO ≤ 5 хвилин** (максимум допустимих втрачених даних). Голого нічного дампа для цього недостатньо (втрата до доби). Механізм: continuous archiving / point-in-time recovery: стрімінг WAL-сегментів у S3-сумісне сховище безперервно, плюс періодичний base backup. Це дозволяє відновитися на будь-яку точку в часі з втратою не більше кількох хвилин.
- **RTO ≤ 1 година** (максимум часу до відновлення роботи). Механізм: документована й відрепетована runbook-процедура: підняти новий інстанс Postgres, відновити з останнього base backup + програти WAL до цільової точки, відновити вкладення з S3-бакета (він реплікований окремо), перемкнути застосунок. Процедура репетується щоквартально з заміром фактичного RTO; якщо замір перевищує ціль, це блокер.

**Резервування вкладень (S3):** окремо від БД, з версіюванням обʼєктів і крос-регіональною реплікацією бакета; RPO вкладень визначається лагом реплікації (близький до нуля).

**Черга/події:** таблиці `events`, `processed_events`, dead-letter входять у той самий PITR-периметр БД, тому подія, зафіксована перед збоєм, переживає відновлення (не втрачається і не дублюється завдяки processed_events).

**Інше:** міграції адитивні, окремий крок деплою перед перемиканням трафіку; ідемпотентні воркери (reminder_log, dedup вебхуків, processed_events); `/healthz` (liveness), `/readyz` (БД доступна); інтеграція з наявним моніторингом (OneUptime) з алертами на глибину dead-letter черги, лаг WAL-архівації і провал health-перевірок.

### 19.3. Продуктивність

P95 списків ≤ 300 мс на цільових обсягах (індекси за фільтрами, accessibleProjectIds одним запитом); перше завантаження SPA ≤ 2 с, code splitting за маршрутами; PDF ≤ 3 с; пошук ≤ 200 мс.

### 19.4. Спостережуваність

pino JSON-логи з request_id і actor; метрики: латентність за маршрутами, глибина черг, помилки воркерів, доставка вебхуків; Sentry для фронту й бекенду.

### 19.5. Локалізація

UI uk/en (i18n-ключі з першого дня); Intl для дат/чисел/валют; PDF пер-документна мова.

---

## 20. Тестування

- **Юніт (Vitest):** статусні матриці (invoice, quote, задачі, leave_request, applicant), гроші (підсумки, податки, знижки, часткові оплати, кредит-ноти, переплата), собівартість (cost_rate знімок, overhead per hour, маржа проєкту/клієнта, internal-проєкт як чиста вартість без revenue), номерні послідовності, aging, burndown-знімки, leave-баланси (нарахування, carry-forward, списання/повернення), парсер git-згадок, RBAC-резолвер, побудова фільтрів/сортування кастомних полів за реєстром (валідація op під тип), redaction-серіалізатор diff (чутливі поля без значень, токени виключені повністю).
- **Інтеграційні API (testcontainers + Postgres):** контракти маршрутів; **матриця прав**: для кожної ролі з сіда прогін ключових ендпоінтів на 200/403/404 (генерується з каталогу permissions: нова permission без тесту валить CI); **ізоляція чутливих даних**: member/guest не бачать people.* ніде (навігація, пошук, API, дашборд-віджети); compensation недоступна без people.read_compensation, costs-звіти без finance.read_costs; sensitive-audit невидимий без відповідного права; кожен доступ до compensation пише audit; **version-locking** (паралельний UPDATE з застарілою version → 409); **internal-проєкти** (kind=internal без company_id не течуть у CRM/aging/profitability-revenue; рахунок на internal-проєкт відхиляється); ресурсний доступ (private проєкт невидимий не-члену включно з пошуком, SSE, дашбордом); вебхуки з підписами.
- **Обробка подій (outbox):** ідемпотентність (повторна доставка того самого event_id не дублює ефект), retry→dead-letter після вичерпання, per-aggregate порядок (події одного aggregate_id обробляються послідовно), replay з DLQ.
- **E2E (Playwright):** логін; клієнт → угода → won → проєкт з шаблону → задачі по борду → цикл; час → рахунок з часу → відправка → часткова і фінальна оплата; quote → accept на публічній сторінці → конвертація; KB: сторінка, версія, відновлення, згадка задачі; вакансія → кандидат → hire → створення співробітника з онбордингом; заявка на відпустку → апрув → баланс списано; member не бачить розділів People і Фінанси; git-вебхук (мок) рухає статус.
- **DR-репетиція (у hardening):** прогін відновлення з PITR + вкладень із заміром фактичних RPO/RTO проти цілей 19.2.
- CI: lint, tsc, тести, збірка образів і Tauri; деплой тегованих релізів на Dokploy; сід демо-даних.

---

## 21. План поставки

Без MVP: все входить у 1.0. Порядок за залежностями, кожен етап: працюючий інкремент на staging:

1. **Фундамент:** монорепо, CI, core-схема, auth, **RBAC цілком** (каталог, ролі, guard-и, матричний тест), каркас API і SPA (навігація, палета, дизайн-система), деплой.
2. **CRM:** компанії, контакти, нотатки, активність, списки/картка, saved views, пошук.
3. **Projects, ядро:** проєкти, воркфлоу, типи, задачі (List/Board/Calendar/Spreadsheet), драфти, inline quick-add, підзадачі, коментарі, мітки, лінки, Мої задачі, нотифікації, members/visibility.
4. **Projects, розширення:** цикли з burndown, relations/dependencies, Timeline, шаблони проєктів і задач, повторювані задачі, intake (форма + IMAP), перенос/дублювання.
5. **KB:** простори, дерево, редактор, версії, згадки/backlinks, шаблони, експорт.
6. **Time:** таймер, записи, ставки, звіти.
7. **Finance:** рахунки повний цикл, PDF, публічні сторінки, оплати, кредит-ноти, quotes з accept, recurring, нагадування, витрати, рахунок з часу, портал, фін-дашборд.
8. **People (HR):** співробітники і lifecycle, відпустки/відсутності з апрувами і балансами, святкові календарі, рекрутинг (вакансії, кандидати, інтервʼю, найм), онбординг-чеклісти, HR-дашборд, домен permissions people.*.
9. **Costs & profitability:** компенсація і overhead, cost_rate у time-entry, собівартість і прибутковість проєкту/клієнта, labor-cost і utilization звіти, finance.read_costs.
10. **Deals + стартовий дашборд + кастомні дашборди + імпорт/експорт.**
11. **Інтеграції:** git (усі три провайдери), автоматизації, вихідні вебхуки, SSE-realtime.
12. **MCP-сервер.**
13. **Desktop:** трей, нотифікації, quick-add, updater.
14. **Hardening:** e2e-повнота, прогін бекап/відновлення, security-аудит (включно з RBAC-фазингом і перевіркою ізоляції HR/costs-даних), i18n-повнота, документація (оператор: розгортання/env/бекапи; користувач: короткий гайд).

Критерій 1.0: агенція веде в системі клієнтів, угоди, всі проєкти, документацію, час, персонал (штат, відпустки, хайринг), собівартість і прибутковість, і 100% виставлення; зовнішні трекер/CRM/вікі/таймер/білінг/HR-таблиці виведені.

---

## 22. Свідомі компроміси (залишкові)

| Рішення | Компроміс | Чому прийнятно |
|---|---|---|
| Немає онлайн-оплати на публічних сторінках | Оплата переказом поза системою, фіксація ручна | Модель payments готова; платіжний провайдер = майбутній модуль без зміни схеми |
| Немає бухгалтерії і legal e-invoicing | Compliance у зовнішніх інструментах | Свідома межа; інтеграція через події/вебхуки за потреби |
| Фінанси без пер-записних ACL | Не можна дати доступ до фінансів одного клієнта | Роль Finance або нічого; пер-клієнтний фінансовий доступ різко ускладнює модель заради рідкісного кейсу |
| Легкий портал за токеном, без логіна клієнтів | Клієнт не має особистого кабінету з автентифікацією | Портал-токен покриває 90% цінності; повноцінний клієнтський логін = окремий великий модуль |
| Вбудовані правила замість конструктора автоматизацій | Не можна малювати довільні сценарії в UI | Конструктор = найдорожча фіча класу; довільні сценарії робляться зовнішньо через вебхуки + API (n8n/агент) |
| Contact N–1 company | Людина у двох клієнтах = два записи | Рідкісний кейс; many-to-many всюди дорожчий |
| Optimistic locking (version) + soft-lock замість CRDT | Немає одночасного співредагування одного тексту | Команда ≤ 50; version-конфлікт (409) + soft-lock на KB/описах покривають реальний ризик втрат |
| Один PDF-шаблон | Немає конструктора шаблонів | Бренд-шаблон достатній; конструктор Invoice Ninja = найменш цінна тут фіча |
| Late fees відсутні | Пеня не нараховується автоматично | Нагадування покривають кейс; пеня в наших договорах рідкість |
| pg-boss замість Redis | Черга ділить ресурси з БД | Обсяги мізерні; мінус компонент інфраструктури |
| Epics / Initiatives / Modules / Milestones / Teamspaces (Plane) відсутні | Немає рівнів угруповання над проєктом і циклом | На масштабі агенції проєкт + цикл достатні; epic за потреби додається таблицею-угрупованням поверх tasks без зміни ядра |
| Approval-воркфлоу і скрипти переходів (Plane Business) відсутні | Перехід статусу не блокується правилами й не запускає довільні скрипти | Governance-фіча великих організацій; наші автоматизації покривають типові пост-дії; тригер перегляду: поява ролей затвердження |
| Фіксовані типи звʼязків задач | Немає кастомних relation types (Mitigates, Supersedes…) | blocks/duplicates/relates покривають агенційні кейси; тип = enum, розширюється міграцією |
| Payroll-движок відсутній (People) | ordi не нараховує ЗП, не генерує зарплатні слаби, не рахує податки | Бухгалтерсько-юридична зона (та сама межа, що Finance 11.1); ЗП присутня як cost rate для аналітики; тригер: рішення вести розрахунок ЗП усередині → окремий payroll-модуль або інтеграція |
| Attendance/shifts/geo-checkin (Frappe HR) не в 1.0 | Немає обліку робочого часу через чек-іни і змінних графіків | Агенція облікує час через тайм-трекінг (модуль Time), а не через табель прихід/вихід; attendance додається як окремий підмодуль People без зміни ядра |
| Performance/appraisals (Frappe HR) не в 1.0 | Немає циклів оцінки й KPI | Поза початковою потребою; додається таблицями в People |
| Cost/profitability це управлінська аналітика, не бухгалтерія | Немає подвійного запису, P&L, звірки з банком | Модель Productive-класу на cost rate + години; бухгалтерія зовнішня |
| Пер-записний доступ до ЗП відсутній | Не можна дати доступ до компенсації окремих людей вибірково | people.read_compensation = все або нічого; вибірковий доступ ускладнює модель заради рідкісного кейсу |
| Глобальний total-order подій не гарантується | Крос-агрегатний строгий порядок обробки відсутній (тільки per-aggregate) | Глобальний порядок дорогий і не потрібен; події одного проєкту/клієнта серіалізовані між собою, обробники не покладаються на крос-агрегатний порядок (3.3) |
| Прогнозний capacity-planning (Resourcing) відсутній | Немає плейсхолдерів на ще-не-найнятих і сценарного forecasting | Фактичне завантаження й utilization є (12.4, 11.10); прогнозне планування додається таблицями без зміни ядра |

Кожен пункт таблиці має шлях розширення, який не ламає модель даних: це критерій, за яким компроміс дозволений.

---

## 23. Глосарій

- **Permission**: атомарне право виду domain.action; **роль**: конфігурований набір permissions; **membership**: доступ до конкретного ресурсу (проєкт, простір).
- **Peek-панель**: бічна панель деталей поверх списку без переходу.
- **Outbox**: подія пишеться в БД в одній транзакції з даними, обробляється асинхронно окремим relay.
- **At-least-once**: гарантія, що подія доставиться хоч раз (можливий повтор), тому обробники ідемпотентні.
- **Dead-letter**: стан події, що не обробилася після всіх ретраїв: відкладена окремо, не втрачена, з ручним replay.
- **Per-aggregate ordering**: події з однаковим aggregate_id обробляються послідовно; різні агрегати паралельно; глобального порядку немає.
- **Optimistic locking**: контроль конкурентного редагування через поле version (не блокування рядка): застаріла version → 409.
- **PITR (point-in-time recovery)**: відновлення БД на будь-яку точку в часі з base backup + WAL.
- **RPO / RTO**: макс. допустимі втрата даних / час до відновлення (тут 5 хв / 1 год).
- **Redaction**: приховування значень чутливих полів (ЗП, персональні дані) в аудиті: фіксується факт зміни без самого значення.
- **Fractional indexing**: дробові позиції для вставки між сусідами без перенумерації.
- **Aging**: розбивка дебіторки за давністю (0-30/31-60/61-90/90+).
- **Burndown**: графік залишку обсягу циклу за днями (щоденні знімки).
- **Backlink**: зворотне посилання: де сутність згадана (сторінки, задачі).

---

## Додаток A. Мапа покриття референсів

Досліджені джерела: docs.plane.so (core concepts, work items, nested pages, dashboards, analytics), plane.so (work-items, work-item-types, wiki, pro, changelog 2025-2026), twenty.com і огляди Twenty 2.x, invoiceninja.com і функціональні огляди, frappe.io/hr і frappe/hrms (модулі leaves/attendance/recruitment/payroll), productive.io (cost rates, overhead, profitability, agency management). Позначки: ✅ включено, 🔧 адаптовано під скоуп ordi, ❌ виключено свідомо (обґрунтування в розділі 22 або тут).

### A.1. Plane → ordi (Projects, KB)

| Фіча Plane | ordi | Коментар |
|---|---|---|
| Work items: title+state мінімум, множинні асайні, пріоритети, мітки, дати, естімейти | ✅ | 8.3 |
| Custom states з категоріями (backlog/unstarted/started/completed/cancelled) | ✅ | категорії backlog/todo/in_progress/done/canceled, 8.2 |
| Work item types з іконками/кольорами | 🔧 | типи є; пер-типові набори properties і пер-типові воркфлоу не робимо: custom fields спільні на сутність |
| 5 layouts: List, Board, Calendar, Spreadsheet, Gantt | ✅ | 8.3 |
| Views (збережені) на рівні проєкту і воркспейсу | ✅ | saved_views особисті/shared/workspace |
| Sub-work items | ✅ | дерево до 5 рівнів |
| Relations vs dependencies, конектори в Timeline, порушені залежності | ✅ | 8.3 |
| Custom relation types | ❌ | розділ 22 |
| Drafts (автозбереження недописаних) | ✅ | 8.3 |
| Links, attachments, linked pages | ✅ | лінки 8.3, вкладення 14.5, звʼязок сторінок через згадки 9.3 |
| Activity tabs (All/Comments/History/Worklogs) | ✅ | 8.3 |
| Quick-add inline row, peek side/modal/full | ✅ | 8.3, 17.1 |
| Copy branch name | ✅ | 13.1 |
| Cycles: burndown, перенесення незакритих, active cycle | ✅ | 8.4 |
| Velocity-порівняння циклів | ❌ | агенційні цикли нерегулярні; знімки є, метрика додається віджетом дашборда |
| Modules / Epics / Initiatives / Milestones / Releases / Teamspaces | ❌ | розділ 22: рівні понад проєкт+цикл |
| Intake: форма, email-capture, тріаж accept/decline | ✅ | 8.6 |
| Work item templates, recurring work items | ✅ | 8.7 |
| Pages/Wiki: вкладені сторінки, версії з diff, локи, page-level visibility | ✅ | 9.3 |
| Inline-коментарі в тексті сторінки | 🔧 | коментарі тредом під сторінкою; inline-анкери не робимо |
| Real-time co-editing сторінок | ❌ | soft-lock + версії, розділ 22 |
| Embeds (Figma/Loom/Draw.io), LaTeX | 🔧 | зображення, файли, код; iframe-embeds і LaTeX не в 1.0: додаються розширеннями Tiptap без зміни моделі |
| Конвертація нотаток у задачі | ✅ | 9.3 |
| Custom dashboards з віджетами | ✅ | 14.1, спрощена модель віджета |
| Analytics-розділ | 🔧 | покривається кастомними дашбордами і фін-дашбордом |
| Workflows/approvals, pre-validation і post-action скрипти | ❌ | розділ 22; типові пост-дії: вбудовані автоматизації 13.3 |
| Публікація pages/views назовні | 🔧 | назовні публікуються рахунки/quotes/портал/intake-форма; сторінки KB назовні не публікуються |
| AI-фічі Plane (Pi, агенти) | 🔧 | замість вбудованого AI: MCP-сервер, агент зовнішній (16) |
| Importers (Jira тощо) | ❌ | імпорт CSV достатній: міграція з чужих систем разова, робиться скриптом через API |

### A.2. Twenty → ordi (CRM)

| Фіча Twenty | ordi | Коментар |
|---|---|---|
| Companies / People / Opportunities | ✅ | companies / contacts / deals |
| Кастомні обʼєкти (нові сутності на рантаймі) | ❌ | найважче рішення відхилення: метамодель = інший клас складності; custom fields на 7 сутностях покривають агенційні кейси; нова сутність = міграція (дешева в моностеку) |
| Кастомні поля через UI | ✅ | 8 типів, реєстр, 5.2 |
| Views: фільтри, сортування, kanban/table | ✅ | saved_views, списки, kanban угод |
| Workflows (тригер-дія) | 🔧 | вбудовані правила 13.3 + вихідні вебхуки замість конструктора |
| GraphQL/REST API + вебхуки | 🔧 | REST + вебхуки; GraphQL: тригер у 2.x-таблиці |
| Нативний MCP | ✅ | 16 |
| Email-синк і календар | ❌ | глибока інтеграція пошти поза скоупом 1.0; звʼязок з клієнтом ведеться нотатками й активністю; тригер перегляду: реальна потреба листування в картці |
| Row-level permissions (Enterprise) | 🔧 | ресурсний доступ на проєктах/просторах; пер-записний ACL у CRM/фінансах: розділ 22 |

### A.3. Invoice Ninja → ordi (Finance)

| Фіча Invoice Ninja | ordi | Коментар |
|---|---|---|
| Invoices: позиції, податки, знижки, статуси | ✅ | 11.3 |
| Quotes з accept/decline і конвертацією | ✅ | 11.2 |
| Часткові оплати, кредит-ноти | ✅ | 11.4 |
| Recurring invoices з auto-send | ✅ | 11.5 |
| Нагадування за розкладом, шаблони листів | ✅ | 11.6 |
| Late fees | ❌ | розділ 22 |
| Client portal з логіном | 🔧 | токен-портал 11.8 без автентифікації; повний портал: розділ 22 |
| Онлайн-оплати (Stripe і 40+ шлюзів) | ❌ | зарезервоване місце на публічній сторінці; окремий майбутній модуль |
| Expenses, категорії | ✅ | 11.7 |
| Vendors, purchase orders | ❌ | закупівельний цикл поза потребою агенції |
| Конструктор PDF-шаблонів | ❌ | розділ 22: один бренд-шаблон |
| Time tracking → інвойс | ✅ | модуль Time, 10.3 |
| Мультивалютність | 🔧 | валюта пер-документ без конвертації, 11.3 |
| Податкова звітність / e-invoicing | ❌ | межа скоупу 11.1 |

### A.4. Frappe HR → ordi (People) і Productive → ordi (costs/profitability)

| Фіча Frappe HR | ordi | Коментар |
|---|---|---|
| Employee lifecycle (онбординг → промоції/трансфери → exit) | ✅ | 12.1, онбординг-чеклісти auto-створюють задачі (як у Frappe) |
| Leave types і policies (carry-forward, earned, LWP, half-day, encashment) | 🔧 | типи/квоти/carry-forward/half-day є (12.2); encashment (грошова компенсація невикористаних) – ні, бо це payroll |
| Leave requests з апрувами, баланси, календар | ✅ | 12.2 |
| Holiday calendars регіональні | ✅ | 12.2 |
| Recruitment: вакансії, кандидати, інтервʼю, найм | ✅ | 12.3, публічна careers-форма |
| Attendance, shifts, roster, geo check-in | ❌ | розділ 22: агенція облікує час через Time, не табель |
| Payroll: salary structures, компоненти, слаби, податки, регіональний compliance | ❌ | розділ 22: бухгалтерсько-юридична зона; ЗП присутня як cost rate (12.5) |
| Performance/appraisals, KPI | ❌ | розділ 22 |
| Expense claims співробітників | 🔧 | покривається expenses у Finance (11.7) з привʼязкою до співробітника |
| Employee self-service (mobile PWA) | 🔧 | самообслуговування через ту саму SPA/десктоп (баланси, заявки); окремого mobile-app немає |
| Fleet/training/loans модулі | ❌ | поза потребою агенції |

| Фіча Productive | ordi | Коментар |
|---|---|---|
| Cost rate співробітника (з ЗП і норми годин) | ✅ | 12.5, versioned |
| Overhead per hour (фасіліті + внутрішні витрати) | ✅ | 12.5, опційно |
| Project profitability (revenue − cost, маржа %) | ✅ | 11.10 |
| Client profitability | ✅ | 11.10 |
| Labor cost звіти (за людиною/командою/проєктом/клієнтом) | ✅ | 11.10 – це і є "витрати по ЗП" |
| Utilization (billable %) з урахуванням відсутностей | ✅ | 11.10 + 12.2 |
| Custom rate cards (ставки за сервісом/клієнтом) | 🔧 | ставки пер-проєкт/пер-користувач (Time); повні rate cards за сервісами не робимо |
| Budgets і budget burn з алертами | 🔧 | естімейти проєкту й прибутковість є; окремих бюджетів із burn-алертами в 1.0 немає – тригер: потреба фікс-бюджетного контролю |
| Resource scheduling / forecasting з плейсхолдерами | 🔧 | легкий Resourcing (12.4) без прогнозних плейсхолдерів |
| Нативний MCP-сервер | ✅ | 16 |
| Xero/QuickBooks-синк бухгалтерії | ❌ | бухгалтерія зовнішня; звʼязок через експорт/вебхуки |
