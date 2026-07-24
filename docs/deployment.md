# ordi — Deployment guide (production)

Цільова інфраструктура за ТЗ — **self-hosted на Dokploy** (Docker), зовнішні
залежності лише SMTP і S3-сумісне сховище. Той самий стек розгортається й на
будь-якому VPS через `docker compose`.

## 0. Що деплоїться

| Сервіс | Образ | Порт | Примітка |
|---|---|---|---|
| `db` | postgres:16-alpine | 5432 | том `db_data`; PITR — див. operations.md |
| `minio` | minio/minio | 9000/9001 | опційно — замініть на R2/S3 |
| `api` | `docker/Dockerfile.api` | 3000 | сам запускає міграції перед стартом |
| `web` | `docker/Dockerfile.web` | 80 | nginx: статика SPA + проксі `/api/` → `api:3000` |

Назва сервісу API має бути **`api`** — nginx у web-образі проксіює на
`http://api:3000` (див. `docker/nginx.conf`).

## 1. Варіант A — Dokploy (рекомендований)

1. **Створіть проєкт → Compose** і вкажіть цей репозиторій та
   `docker-compose.yml` (Dokploy збере обидва Dockerfile сам).
2. **Environment** (мінімум для прод):
   ```bash
   AUTH_SECRET=$(openssl rand -hex 32)
   ENCRYPTION_KEY=$(openssl rand -hex 32)     # AES-256-GCM для git-креденшелів
   SMTP_URL=smtps://user:pass@smtp.example.com:465
   ```
   і відредагуйте в compose (або винесіть у env) значення під ваш домен:
   `APP_URL=https://ordi.example.com`, `CORS_ORIGINS=https://ordi.example.com,tauri://localhost`.
   `APP_URL` потрапляє в email-и та публічні лінки PDF — він мусить бути
   реальним доменом.
3. **Домен + HTTPS**: у Dokploy привʼяжіть домен до сервісу `web` (порт 80) —
   Traefik видасть сертифікат. API назовні відкривати не потрібно: весь трафік
   (у т.ч. SSE і публічні сторінки) ходить через nginx за шляхом `/api/`.
   Git-вебхуки теж працюють через web-домен: `https://ordi.example.com/api/v1/integrations/git/<provider>/webhook`.
4. **Сховище файлів**: залиште вбудований MinIO (створіть бакет `ordi` у
   консолі на :9001) або приберіть сервіс і вкажіть R2/S3:
   `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`.
5. **Перший запуск** — сід ролей/власника (одноразово):
   ```bash
   docker compose exec api \
     env SEED_OWNER_EMAIL=you@agency.com SEED_OWNER_PASSWORD='строгий-пароль' \
     pnpm --filter @ordi/api seed
   ```
   Далі логін під цим власником; демо-користувачам (`member@ordi.local`)
   змініть пароль або деактивуйте їх у Settings → Users.
6. **Health checks**: `GET /healthz` (liveness) і `GET /readyz` (readiness,
   перевіряє БД) на сервісі `api` — додайте їх у Dokploy/моніторинг.

## 2. Варіант B — голий VPS

```bash
git clone <repo> && cd ordi
cp .env.example .env            # AUTH_SECRET, ENCRYPTION_KEY, SMTP_URL, домени
docker compose up -d --build
docker compose exec api pnpm --filter @ordi/api seed   # одноразово
```
Далі поставте перед `web:8080` будь-який TLS-термінатор (Caddy/Traefik/nginx).

## 3. Оновлення (нові релізи)

Міграції **адитивні** і запускаються автоматично в entrypoint API-контейнера
перед стартом сервера — стандартний цикл: `git pull` → rebuild → restart.
Rollback безпечний: попередній образ працює зі схемою нового (руйнівних DDL
немає). Zero-downtime на одному хості не гарантується (кілька секунд рестарту).

## 3a. Пошта

Один SMTP-транспорт (`SMTP_URL`, `SMTP_FROM`) обслуговує запрошення, надсилання
рахунків і пропозицій (PDF + публічне посилання), нагадування про оплату,
відповіді на заявки з Intake і дублювання сповіщень. Мова листа береться з
локалі отримувача (свої користувачі) або з мови документа (клієнти) — uk/en.
Без `SMTP_URL` листи **не надсилаються**, а лише пишуться в лог.

**Перевірка перед прод.** У `docker-compose.yml` є `mailpit`: задайте
`SMTP_URL=smtp://mailpit:1025` і відкрийте http://localhost:8025 — там видно
кожен лист рівно таким, яким його отримає клієнт (HTML, текстова версія,
вкладення).

**Доставність.** Опублікуйте DNS-записи для домену, з якого шлете, інакше
листи потраплятимуть у спам або відхилятимуться:

| Запис | Приклад | Навіщо |
| --- | --- | --- |
| SPF | `v=spf1 include:_spf.your-provider.com -all` | дозволяє серверам провайдера слати від імені домену |
| DKIM | CNAME/TXT з панелі SMTP-провайдера | криптопідпис листа; провайдер видає селектор |
| DMARC | `v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain` | політика для листів, що не пройшли SPF/DKIM |

Домен у `SMTP_FROM` має збігатися з доменом, для якого налаштовані SPF/DKIM
(інакше DMARC не зійдеться). Дефолтний `no-reply@ordi.local` для прод не
годиться. Обробки повернень (bounce) і списку відписок поки немає — за
репутацією домену слідкуйте в панелі провайдера.

## 4. Обовʼязково для прод (чекліст)

- [ ] `AUTH_SECRET` і `ENCRYPTION_KEY` — випадкові 32-байтові, тільки в env.
- [ ] `APP_URL`/`CORS_ORIGINS` = реальний https-домен.
- [ ] SMTP налаштований (без нього листи лише логуються), `SMTP_FROM` на
      вашому домені, SPF/DKIM/DMARC опубліковані — див. §3a.
- [ ] S3/MinIO з бакетом — інакше вкладення недоступні (presign — заглушка).
- [ ] **Бекапи**: PITR через WAL-G (RPO ≤ 5 хв) + реплікація бакета вкладень —
      покрокова інструкція і runbook відновлення: `docs/operations.md`.
- [ ] Моніторинг: `/healthz`, `/readyz`, глибина dead-letter, лаг WAL —
      SQL-запити для алертів у `docs/operations.md` §5.
- [ ] (Опційно) `SENTRY_DSN` (API) і `VITE_SENTRY_DSN` (web, задається на
      етапі збірки web-образу) для звітів про помилки.
- [ ] (Опційно) **Typst** для брендованого PDF: додайте в `docker/Dockerfile.api`
      установку бінарника (`typst` у PATH). Без нього рахунки генеруються
      вбудованим простим рендером — валідний PDF, але без бренд-верстки.

## 5. Десктоп і MCP

- **Desktop**: пуш тега `v*` у GitHub запускає `.github/workflows/desktop.yml`
  (macOS universal / Windows msi / Linux AppImage+deb через tauri-action).
  Для підписаного апдейтера задайте секрети `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`.
  Перший запуск застосунку питає URL інстансу — ваш `https://ordi.example.com`.
- **MCP-агент**: створіть API-токен у Профілі (скоуп ⊆ вашої ролі) і запускайте
  `pnpm --filter @ordi/mcp start` з `ORDI_API_URL=https://ordi.example.com` та
  `ORDI_API_TOKEN=<токен>` на машині агента.
