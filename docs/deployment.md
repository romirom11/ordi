# ordi – Deployment guide (production)

The target infrastructure per the spec is **self-hosted on Dokploy** (Docker);
the only external dependencies are SMTP and S3-compatible storage. The same
stack deploys on any VPS with `docker compose`.

## 0. What gets deployed

| Service | Image | Port | Note |
|---|---|---|---|
| `db` | postgres:16-alpine | 5432 | volume `db_data`; PITR – see operations.md |
| `s3` | rustfs/rustfs | 9000 | optional (profile `s3`) – built-in S3 storage; swap it for R2/S3 if you prefer |
| `api` | `ghcr.io/romirom11/ordi` | 3000 | **the whole application**: migrations, API, workers and the built web app |

The `api` image is published automatically on every release
(`.github/workflows/image.yml`, `linux/amd64`): `docker pull
ghcr.io/romirom11/ordi:latest` works without any GitHub authentication, and
every release also has a version tag (`ghcr.io/romirom11/ordi:1.36.1`) – pin
to that (`ORDI_VERSION=1.36.1` in env) and roll back to it. The server builds
nothing: `pnpm install` and the web build happen once, in CI. You only need to
build the image locally for a fork or a change to `docker/Dockerfile.api` –
the `docker-compose.build.yml` overlay exists for that.

Since v1.6.0 **one container is the whole application**: `api` itself serves
the SPA, `/api/*`, SSE and the OAuth discovery for MCP (`/.well-known/*`).
There is no separate web server and nothing to configure between containers.
(The old nginx image `docker/Dockerfile.web` – deprecated since v1.6.0 – has
been removed; if you still pinned it, see step 3 below.)

## 1. Option A – Dokploy (recommended)

1. **Create a project → Compose** and point it at this repository and
   **`docker-compose.prod.yml`**. Dokploy builds nothing: the `api` service
   pulls the published `ghcr.io/romirom11/ordi` image (`pull_policy:
   always`, so every Redeploy in the panel installs the current image for the
   tag). Without `ORDI_VERSION` that is `latest`; to pin to a release, set
   `ORDI_VERSION=1.36.1` in Environment.
   The `docker-compose.yml` in the root is for running locally: it hard-wires
   values to `localhost` and publishes ports to the host.
2. **Environment** (the minimum for production):
   ```bash
   AUTH_SECRET=$(openssl rand -hex 32)
   ENCRYPTION_KEY=$(openssl rand -hex 32)     # AES-256-GCM for every stored credential, §3c
   AGENT_WORKER_SECRET=$(openssl rand -hex 32) # api ↔ agent-worker, §3b
   SMTP_URL=smtps://user:pass@smtp.example.com:465
   ```
   and edit the values in the compose file (or move them to env) to match your
   domain: `APP_URL=https://ordi.example.com`, `CORS_ORIGINS=https://ordi.example.com,tauri://localhost`.
   `APP_URL` ends up in emails and public PDF links – it must be a real
   domain.
3. **Domain + HTTPS**: in Dokploy, attach the domain to the **`api`** service
   (**port 3000**, Path `/`) – Traefik will issue the certificate. No other
   routing rules: this same service serves the site, `/api/*` (including
   SSE) and `/.well-known/*` for MCP connectors.
   Git webhooks: `https://ordi.example.com/api/v1/integrations/git/<provider>/webhook`.
   For GitHub this webhook is registered automatically if the connection was
   created via a GitHub App (Settings → Integrations → Create GitHub App); you
   only need to add it by hand for GitLab/Gitea or legacy token connections.

   **Upgrading from a version before v1.6.0?** Move the domain from the `web`
   service (port 80) to `api` (port 3000), delete the `web` service and any
   manual nginx config mount you made for it. No new env.
4. **File storage** – two paths, both via variables:
   - *External S3/R2*: set `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`,
     `S3_SECRET_KEY`, `S3_REGION`.
   - *Built-in storage* (the `s3` service, RustFS image): add
     `COMPOSE_PROFILES=s3`, `S3_ENDPOINT=http://ordi-s3:9000` and the same
     `S3_ACCESS_KEY`/`S3_SECRET_KEY` pair – it also becomes the storage's root
     credentials, so the api and the storage physically cannot drift apart.
     The api creates the bucket itself on startup (no init container), and it
     waits patiently while the storage container comes up. The address is
     `ordi-s3`, not `s3`: on a shared PaaS network (Dokploy/Coolify) the api
     sees other projects' containers, and a generic alias can resolve to a
     neighbouring project.

   The storage is not exposed externally at all: the browser uploads and reads
   files through the API, and the API talks to the bucket over the internal
   network. The storage needs no public domain, no CORS and no console.

   **Were you on the built-in MinIO (before v1.35.1)?** MinIO stopped serving
   its images anonymously – first on Docker Hub, then on quay.io – and
   `docker compose pull` on a host without a cached image failed with
   `unauthorized`. So the `minio` service (and the `minio-init` init container
   with the `minio/mc` image) has been replaced by `s3` with the RustFS image:
   the same S3 API, Apache-2.0, published on Docker Hub. The old values
   `COMPOSE_PROFILES=minio` and `S3_ENDPOINT=http://ordi-minio:9000` keep
   working (the profile and the network alias are preserved), but MinIO's data
   sits in the `minio_data` volume in its own format, and RustFS cannot read
   it. Move the files while the old MinIO container is still running (its
   cached image on the host has not gone anywhere):

   ```bash
   # 1. Bring up the new storage next to the old one (the minio profile is still active,
   #    the old `minio` container runs from the cached image):
   docker compose -f docker-compose.prod.yml up -d s3
   # 2. Copy the bucket over the S3 protocol (replace the network with the name of
   #    your stack's network – `docker network ls`; the keys are the same on both sides):
   docker run --rm --network <stack_network> rclone/rclone sync \
     :s3,provider=Minio,endpoint=http://ordi-minio:9000,access_key_id=$S3_ACCESS_KEY,secret_access_key=$S3_SECRET_KEY:ordi \
     :s3,provider=Other,endpoint=http://ordi-s3:9000,access_key_id=$S3_ACCESS_KEY,secret_access_key=$S3_SECRET_KEY:ordi
   # 3. Switch the api over: S3_ENDPOINT=http://ordi-s3:9000, COMPOSE_PROFILES=s3,
   #    docker compose up -d. The old minio container then disappears from the
   #    stack; the minio_data volume stays until you delete it yourself.
   ```

   While the old and new containers run at the same time, the `ordi-minio`
   alias resolves to one of them – so in step 2 copy before stopping the old
   one, and check `rclone size` on both sides before switching. Attachments
   that are missing from the new storage are honestly reported by the API as
   "File is missing from storage"; nothing is lost silently.
5. **First run** – seed the roles/owner (one-off):
   ```bash
   docker compose exec api \
     env SEED_OWNER_EMAIL=you@agency.com SEED_OWNER_PASSWORD='a-strong-password' \
     pnpm --filter @ordi/api seed
   ```
   Then log in as that owner; change the password of the demo users
   (`member@ordi.local`) or deactivate them in Settings → Users.
6. **Health checks**: `GET /healthz` (liveness) and `GET /readyz` (readiness,
   checks the DB) on the `api` service – add them to Dokploy/your monitoring.

## 2. Option B – bare VPS

```bash
mkdir ordi && cd ordi
curl -fsSLO https://raw.githubusercontent.com/romirom11/ordi/master/docker-compose.prod.yml
# .env: POSTGRES_PASSWORD, AUTH_SECRET, ENCRYPTION_KEY, AGENT_WORKER_SECRET, APP_URL, SMTP_URL, S3_*
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec api pnpm --filter @ordi/api seed   # one-off
```
There is no need to clone the repository – the image is already built. Or,
without S3 and a domain, to try it out on `localhost:8080`: the same recipe
with `docker-compose.yml` from the README.
Then put any TLS terminator (Caddy/Traefik/nginx) in front of `api` (host
port 8080 or 3000) – it proxies everything to a single port, with no separate
rules.

<a id="updating"></a>

## 3. Updating (new releases)

The standard cycle – no building on the server:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

On Dokploy the **Redeploy** button does the same (the image is pulled on
every `up`). Pinned to a version (`ORDI_VERSION=1.36.1`)? Change the value to
the new version and repeat. Rolling back is the same operation with the
previous version: `ORDI_VERSION=1.36.0 docker compose -f docker-compose.prod.yml up -d`.
The tags of every release: `1.36.1`, `1.36`, `1`, `latest`.

Migrations are **additive** and run automatically in the API container's
entrypoint before the server starts – there are no separate steps. Rollback is
safe: the previous image works with the new schema (there is no destructive
DDL). Zero downtime on a single host is not guaranteed (a few seconds of
restart).

The server reports its version in `GET /healthz`, and the application checks
it against its own:

- **Web**: after the server is updated, open tabs show a "New version
  available" banner with a reload button.
- **Desktop** updates itself via GitHub releases, but it ships its UI with it,
  so the reverse check matters too: if the server is *older* than the app, a
  warning appears with a link here. Seen it? Time to run
  `docker compose pull && docker compose up -d` on the server.
- **Settings** shows the current version at the bottom of the navigation, and
  for administrators also a link to the newer release as soon as it comes out.

## 3a. Email

Mail goes out from **senders**: each is a "From" address, an optional
Reply-To and the SMTP login it is sent through. One sender is the
**system** sender: invites, password resets, replies to Intake submissions and
notification copies. Another (or the same one) is **for invoices**: invoices
and quotes (PDF + public link) go out from it by default, and in the send
dialog you can pick any other. Payment reminders go out from the same address
the invoice itself was sent from. The language of an email comes from the
recipient's locale (your own users) or from the document's language
(clients) – uk/en. Without SMTP configured, emails **are not sent**; they are
only written to the log.

Sending a document interactively happens immediately, so the user gets success
or an error in the same request. System notifications, payment reminders and
the sales-work digest first land in `email_deliveries`: a built-in worker in
the same `api` container sends them in the background, retries after errors
and recovers abandoned claims after a restart. There is no separate queue
service or process to configure. Monitoring of pending/dead/stale rows is
described in [`docs/operations.md`](operations.md).

**Where to configure it.** In the app: **Settings → Email**. There you get the
list of senders, the roles ("System", "Invoices") and, for each one, "Test
connection" (whether the port opens at all) and "Send test email" (an
end-to-end check of delivery from that exact address). Passwords are stored
encrypted and are never sent back to the client.

`SMTP_URL` and `SMTP_FROM` in `.env` are shown in the same place as the
"Server .env" sender, read-only. While the UI has no senders, it is the
system sender; as soon as the first one is added, that one becomes the system
sender (you can change this in the row menu).
SMTP settings from versions before 1.40 automatically become the "Default"
sender.

> The most common reason mail does not go out is that **the hosting provider
> blocks outbound SMTP ports** (25/465/587). In that case "Test connection"
> will show `ETIMEDOUT`. Ask the provider to open the ports, or use a mail
> service with an API over HTTPS.

**Checking before production.** `docker-compose.yml` includes `mailpit`: set
`SMTP_URL=smtp://mailpit:1025` and open http://localhost:8025 – there you can
see every email exactly as the client will receive it (HTML, text version,
attachments).

**Deliverability.** Publish DNS records for the domain you send from,
otherwise emails will land in spam or be rejected:

| Record | Example | Why |
| --- | --- | --- |
| SPF | `v=spf1 include:_spf.your-provider.com -all` | allows the provider's servers to send on behalf of the domain |
| DKIM | CNAME/TXT from the SMTP provider's panel | cryptographic signature of the email; the provider issues the selector |
| DMARC | `v=DMARC1; p=quarantine; rua=mailto:dmarc@your-domain` | policy for emails that failed SPF/DKIM |

The domain in `SMTP_FROM` must match the domain SPF/DKIM are set up for
(otherwise DMARC will not align). The default `no-reply@ordi.local` is not fit
for production. There is no handling of bounces or an unsubscribe list yet –
keep an eye on the domain's reputation in the provider's panel.

## 3b. Agents (Claude Code)

An agent employee is a user with `actor_type = 'agent'`: tasks are assigned to
it just as to a person, and the platform runs Claude Code against the
project's repository and carries the work through to a pull request. Runs are
executed by **a separate `agent-worker` service** – it is in both compose
files and starts along with everything else, with nothing to configure: the
same image, a different command, and from the environment only the API
address and the shared secret `AGENT_WORKER_SECRET`. This is the only place in
ordi where code written by the model is executed, so this container has no
`DATABASE_URL`, no `ENCRYPTION_KEY` and no `AUTH_SECRET` (details below). For
this the image includes `git`, and the Claude Code runtime itself comes with
the SDK (`@anthropic-ai/claude-agent-sdk`); the image build fails if the
binary does not resolve, so "installed but doesn't work" cannot happen here.

**Environment variables**

| Variable | Where | Default | Why |
|---|---|---|---|
| `AGENT_WORKER_SECRET` | `api` and `agent-worker` | – (required in `docker-compose.prod.yml`) | shared secret, any random string (`openssl rand -hex 32`); the worker uses it to authenticate on `/api/v1/agent-worker/*`. Without it the API answers these routes with 503 |
| `ORDI_API_URL` | `agent-worker` | `http://ordi-api:3000` in compose | the API address from inside the network; compose already sets it |
| `AGENT_WORKER_CONCURRENCY` | `agent-worker` | `2` | how many runs this process holds at once; each agent also has its own `concurrency` limit |
| `AGENT_WORK_DIR` | `agent-worker` | `/data/agent-work` | `tasks/<taskId>/checkout` – a fresh clone for every run, deleted when it finishes; `tasks/<taskId>/harness` – Claude Code's home with the session transcript, kept so that a follow-up and Retry continue the same conversation; cleaned up 30 days after the task's last run |
| `AGENT_WORKER_ENABLED` | `api` | `0` in compose (`1` if the variable is not set) | the built-in worker inside the API process. In compose it is disabled because runs are executed by `agent-worker`; `1` is only needed for running without compose (`pnpm dev`) or if you deliberately want everything in one container |
| `ANTHROPIC_API_KEY` | `api` | – | a fallback source **for the API key only**, so a PaaS can configure Claude without going into the UI; in Settings → Agents it shows as a read-only card. It stays on the API: the worker receives access for each run separately |

**Volume for working copies.** Both compose files mount the named volume
`agent_work:/data/agent-work` **on the `agent-worker` service** (the API does
not need it). During a run it holds a full clone of the repository, so size
the volume as `AGENT_WORKER_CONCURRENCY` × the repository size, with headroom;
between runs only the session transcripts remain (megabytes per task, 30
days). The volume must be one and the same for all workers, otherwise a Retry
on another host will not find the session and will start the task from the
branch again (see [`docs/operations.md`](operations.md)).

**Connecting Claude.** **Settings → Agents** – one workspace, one credential
for all agents. Two equally valid options:

- **Subscription.** On your own machine run `claude setup-token` (requires a
  Pro/Max/Team/Enterprise plan) and paste the resulting token – it lasts a
  year, and ordi will remind the `agents.manage` holders 14 days before it
  expires.
- **Anthropic API key.** The same dialog, a different type.

The secret is encrypted with AES-GCM (`ENCRYPTION_KEY`) and is never sent back
to the client; the card shows **who connected it** and when, because agent
runs consume that person's plan. The "Verify" button makes a minimal request
and records the result.

**GitHub App: new permissions.** The manifest now requests `contents: write`
and `pull_requests: write` – the agent pushes its branch and opens the PR with
the installation token. New apps are created with them already; **GitHub does
not extend an existing installation by itself** – the organisation owner has
to accept the new permissions (GitHub will send a request, and the state is
visible in Settings → Integrations). Until they do, reads and webhooks work,
but the agent's push fails.

**MCP connectors.** Connectors are connected in **Settings → Connectors**
(the `integrations.manage` permission), and the agent's card is where you mark
which ones it is allowed to use. The agent does not reach them directly but
through the ordi gateway (`POST /api/v1/mcp-connectors/:slug/mcp`), so no
upstream secret ever reaches the agent's process. Connectors with OAuth need a
publicly reachable callback:

```
APP_URL/api/v1/mcp-connectors/oauth/callback
```

It has to open **in the browser of the administrator** giving consent, which
means `APP_URL` again must be a real https domain (as for MCP discovery too,
§5). A local instance without a public domain cannot connect such connectors.

**Permissions.** Everything to do with agents – Claude access, creating
agents, limits, the assignment policy, the list of allowed connectors,
cancelling runs – is under the new `agents.manage` permission. Owner and Admin
get it automatically (the `0035_ai_agents.sql` migration backfills it into
these two roles); it can be granted to any custom role in the role matrix. The
agent itself works under an ordinary role – the `Agent` preset (projects.read,
projects.write, kb.read) – and sees only the projects it is a member of.

**Project secrets in runs.** A project secret with *Available to AI agents* on
reaches the run of an agent that is a member of the project as environment
variables, decrypted by the API and handed to the worker with the run, like
the Claude credential. The agent's instructions name the variables, never the
values. The values are redacted from the run log and from everything the run
writes back to ordi, and a branch whose commits contain one is not pushed.
An agent with network access could still send a value elsewhere: give agents
test keys, and keep production secrets switched off unless a run needs them.

**Why the worker is a separate container.** An agent run is the only place in
ordi where code written by the model is executed. The child process already
gets a rebuilt environment without `DATABASE_URL`, `ENCRYPTION_KEY`,
`AUTH_SECRET`, S3 and SMTP, the run token is revoked at the end, and there are
allow and deny lists of tools – but the blast radius of an escape from this
process equals the container it lives in, and the `api` container holds
everything.

So the worker runs **as a separate process without a database**: it talks to
the API only over HTTP (`/api/v1/agent-worker/*`) and holds only what a single
run needs – the Claude credential, the repository token, its own run token
and the project secrets switched on for agents, each of which is scoped or
revoked. The worker must have no `DATABASE_URL`,
`ENCRYPTION_KEY` or `AUTH_SECRET` – it will not ask for them, and if a PaaS
injects them into every container of the project, the worker writes a warning
about it to the log. Runs are taken from the queue via `FOR UPDATE SKIP
LOCKED` on the API side, so the same run will not execute twice, even if
`AGENT_WORKER_ENABLED=1` is mistakenly turned on on the API. You can give the
worker its own CPU/memory limits, a separate network (it only needs the API,
GitHub and Anthropic), and eventually its own virtual machine – the API does
not know about any of this. The worker's state is visible in
**Settings → Agents** (heartbeat every 15 seconds).

**Upgrading from v1.33 or older?** Add `AGENT_WORKER_SECRET` to the
environment – without it `docker-compose.prod.yml` now does not come up. If
you had already uncommented `agent-worker` yourself, remove your copy: the
service is now in the file. If `api` had `AGENT_WORKER_ENABLED=1` in env,
delete it, so that it does not pick up runs alongside the worker. The
`agent_work` volume is the same, so session transcripts do not go anywhere.

**Everything in one container.** Not recommended, but possible: on `api` set
`AGENT_WORKER_ENABLED=1`, mount `agent_work:/data/agent-work` on it and bring
it up with `--scale agent-worker=0`. The worker inside `api` calls the same
functions directly.

## 3c. Encryption key

`ENCRYPTION_KEY` encrypts every credential ordi stores: git, Slack and SMTP
passwords and tokens, the GitHub App key, mailbox passwords, the workspace
Claude credential and MCP connector secrets. Anyone holding a database dump
*and* the key can read them, so keep the key out of the database host's
backups and treat it like the database password.

**Production refuses to start** without a key, with one that is not 64
hexadecimal characters, or with the all-zero development key – the server
logs what to do and exits. Generate a key with `openssl rand -hex 32`.

**Where the key comes from**, first match wins:

1. `ENCRYPTION_KEY` – the key itself.
2. `ENCRYPTION_KEY_FILE` – a file holding it. If the file does not exist, the
   api generates a random key into it on first start (mode `0600`). The
   quick-start `docker-compose.yml` uses this with the `ordi_keys` volume, so
   a fresh install has a real key with nothing to configure. **Back up that
   volume together with the database** – without it, stored credentials
   cannot be read.
3. Outside production only, the all-zero development key.

Do not use `ENCRYPTION_KEY_FILE` on a platform without persistent volumes:
the next redeploy would generate a different key. Set `ENCRYPTION_KEY` there.

**Rotating the key**, or moving an install off the zero key:

1. Set the new key as `ENCRYPTION_KEY` and the old one as
   `ENCRYPTION_KEY_PREVIOUS` (comma-separated if there are several), then
   restart. Everything stays readable: values name the key they were
   written with, and new writes use the new key.
2. Re-encrypt what is stored (safe while the app is running, and safe to
   repeat):
   ```bash
   docker compose exec api pnpm --filter @ordi/api exec tsx src/rotate-encryption-key.ts --dry-run
   docker compose exec api pnpm --filter @ordi/api exec tsx src/rotate-encryption-key.ts
   ```
   It scans every text and jsonb column for encrypted values, so there is
   no list of tables to keep up to date. It exits non-zero and names the
   column when a value opens with none of the known keys: add the key that
   value was written with to `ENCRYPTION_KEY_PREVIOUS` and run it again.
3. When it reports nothing left to re-encrypt, remove `ENCRYPTION_KEY_PREVIOUS`.

An install started from the quick-start compose file before this change
used the all-zero key. If you download the new `docker-compose.yml`, it
already lists the zero key as previous. Run step 2 once to move everything
onto the generated key. If you keep the old compose file, set a key in
`.env` (`ENCRYPTION_KEY=…` and `ENCRYPTION_KEY_PREVIOUS=000…0`, 64 zeros)
and do the same.

## 4. Required for production (checklist)

- [ ] `AUTH_SECRET`, `ENCRYPTION_KEY` and `AGENT_WORKER_SECRET` – random
      32-byte values, in env only (or `ENCRYPTION_KEY_FILE` on a persistent
      volume, §3c). The api refuses the all-zero key in production.
- [ ] `APP_URL`/`CORS_ORIGINS` = the real https domain.
- [ ] SMTP configured (without it emails are only logged), `SMTP_FROM` on
      your domain, SPF/DKIM/DMARC published – see §3a.
- [ ] S3 (external or the built-in `s3` profile) – otherwise attachments are unavailable (the API honestly answers
      "Object storage is not configured"). The storage is not exposed
      externally – files go through the API (see §4).
- [ ] **Backups**: PITR via WAL-G (RPO ≤ 5 min) + replication of the
      attachments bucket – step-by-step instructions and the restore runbook:
      `docs/operations.md`.
- [ ] Monitoring: `/healthz`, `/readyz`, dead-letter depth, WAL lag –
      SQL queries for alerts in `docs/operations.md` §5.
- [ ] (Optional) **Agents**: Claude connected, the `agent_work` volume on the
      `agent-worker` service, the new GitHub App permissions accepted – §3b.
      If there will be no agents, you can skip bringing the service up
      (`--scale agent-worker=0`); without Claude connected it sits idle anyway.

- [ ] (Optional) `SENTRY_DSN` (API) and `VITE_SENTRY_DSN` (web, set at
      web image build time) for error reports.
- [ ] Invoice and quote PDFs need no additional binaries: the branded
      document (logo, accent colour, both parties' details, payment details,
      Cyrillic) is rendered by the API itself. The logo, details and default
      text are set in Settings → Workspace / Invoices.

## 5. Desktop and MCP

- **Image**: the same tag triggers `.github/workflows/image.yml` – a build of
  `docker/Dockerfile.api` (`linux/amd64`), a push to `ghcr.io/romirom11/ordi`
  with the tags `<version>`, `<major>.<minor>`, `<major>`, `latest`,
  `sha-<commit>`, and a check that the image pulls **without authentication**
  and answers `/healthz` with its version. A green workflow means exactly
  "pull works": if the package turns out to be private, the anonymous pull
  step fails with instructions on where to make it public. Running the
  workflow manually on a branch publishes only `sha-<commit>` – a preview
  image that never touches `latest`.
- **Desktop**: pushing a `v*` tag to GitHub triggers `.github/workflows/desktop.yml`
  (macOS universal / Windows msi / Linux AppImage+deb via tauri-action).
  For a signed updater, set the secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`.
  On first launch the app asks for the instance URL – your `https://ordi.example.com`.
- **MCP agent**: create an API token in your Profile (scope ⊆ your role) and run
  `pnpm --filter @ordi/mcp start` with `ORDI_API_URL=https://ordi.example.com` and
  `ORDI_API_TOKEN=<token>` on the agent's machine.
- **MCP connector (Claude, Cursor) via OAuth**: the client points at
  `https://ordi.example.com/api/v1/mcp`, and from there the client does
  everything itself – discovery, registration, login, consent. Requirements
  for your proxy:
  - **`Host` and `X-Forwarded-Proto` must reach the API.** Discovery returns
    absolute URLs and builds them from these headers. If the proxy drops them,
    the client gets an address that does not exist from outside, and says
    something like "couldn't register with the sign-in service". If the domain
    points straight at `api`, there is nothing to do; for your own proxy,
    check by hand:
    ```
    curl -s https://ordi.example.com/.well-known/oauth-authorization-server
    ```
    `issuer` and `registration_endpoint` must be on your public domain, not
    on `localhost` or `api:3000`.
  - **Public HTTPS.** Registration is done by the client's server, not by
    your browser, so the instance must be reachable from the internet over
    https. For an instance on a local network the OAuth connector will not
    work – the token remains the option there.
  - `APP_URL` is now only needed as a fallback (and for email links), but
    keep it up to date.
