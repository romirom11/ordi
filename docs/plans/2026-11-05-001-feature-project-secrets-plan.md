---
artifact_contract: ce-unified-plan/v1
artifact_readiness: draft-for-review
product_contract_source: conversation
created_at: 2026-11-05
title: Project Secrets
topic: project-secrets
type: feature
execution: code
---

# Project Secrets - Plan

## Goal Capsule

- **Objective:** Give a project a safe, simple place for the credentials a client hands over (platform logins, test API keys, staging passwords). People can store, reveal and copy them. Agents can check that they exist and use them without the values entering the model's context.
- **Product authority:** This plan owns the secret data model, its encryption at rest, who may see names and who may reveal values, the secret kind in project Resources, the MCP surface for secrets, injecting secrets into ordi agent runs, and external secret providers (Doppler first). It does not change how agent credentials or MCP connector secrets work today; those stay in `agents/credentials.ts` and the connector gateway.
- **Execution profile:** Additive, in phases that each ship on their own: native secrets, then agent use, then Doppler, then external agents and more providers. Every phase is a separate PR.
- **Stop conditions:** Stop before any secret value appears in an API list response, an activity entry, a run log, a task comment written by an agent, or an MCP tool result. Stop before a value is written to disk in the clear, cached beyond a single request or run, or sent to a third party other than the provider it came from.
- **Open blockers:** None. Q1, Q2 and Q5 are settled (see Key Decisions). The defaults in Q3 and Q4 can be changed during review.
- **Tail ownership:** Each phase owns its tests, docs and changelog entry. The phase PR is opened only after the user asks.

---

## Product Contract

### Summary

A secret is a new kind of project resource, next to links, files and knowledge-base pages (`project_resources`, PR #148). It has a name like `STRIPE_TEST`, a short description, an environment (test, staging, production or other), and one or more fields such as login, password, URL, API key or note. Values are encrypted with AES-256-GCM and are only decrypted to answer a reveal, a copy, or an agent run that is allowed to use them. Access is decided by three layers that must all agree: the person's workspace role (RBAC), their role in the project, and the secret's audience, which is chosen when the secret is created (the whole project, named people, or departments). Every reveal is logged. Agents see names and which fields exist through MCP. Agents that run inside ordi get the values as environment variables of their run, never as text in their prompt. Values in the run's logs and in what the agent writes back to ordi are replaced with `[redacted]`. A secret can also live in Doppler instead of ordi: ordi then keeps only a reference and asks Doppler for the value at the moment it is needed.

### Problem Frame

Today a client's test API key or platform login ends up in a task comment, a KB page, a description, or a chat outside ordi. All of these are readable by anyone with access to them, kept in version history and search, and copied into every MCP read. That puts the value in the agent's context the moment it reads the task. Nothing tells the team which credentials a project has, when one expires, or who looked at it. The user's words: "how can we store this securely but simply for the user, and let agents check it exists and use it without reading the value".

### Key Decisions

- **Secrets are a kind of project resource** (session-settled: user-approved in the Resources discussion; the Resources block was built with this in mind). Governs R1, R12.
- **Agents use secrets without reading them** (session-settled: user requirement). MCP exposes names and metadata only. Values reach an agent run as environment variables and are redacted from everything the run writes back. Governs R20-R29.
- **External providers sit behind the same interface, Doppler first** (session-settled: user-approved; 1Password, Infisical, Vault and others later). Governs R30-R38.
- **Encryption reuses `lib/crypto` with a versioned ciphertext** (proposed). This is the same AES-256-GCM key (`ENCRYPTION_KEY`) that already protects agent credentials and git tokens, with a `v1:` prefix so a key rotation can follow without a data migration. A KMS or per-workspace keys are out of scope for a self-hosted single-workspace app. Governs R6-R9.
- **Access is three layers that must all agree** (session-settled: user-approved direction, "project membership plus a global RBAC"; the layer design is proposed). The workspace role says *what* a person may do with secrets at all (new permissions `secrets.read`, `secrets.reveal`, `secrets.write`, `secrets.manage`). The project role says *where*: a project member or admin, the same boundary as every other project resource. The secret's audience says *which*: chosen per secret. No layer can widen another. Governs R43-R56.
- **A secret's audience is chosen when it is created** (session-settled: user requirement). The choices are everyone on the project, named people, or departments, or a mix of these. Governs R46-R49.
- **Each secret has an environment** (session-settled: user question "how do we tell a test key from a real one?" — ordi cannot tell, so the person saving it says so). The values are `test`, `staging`, `production` and `other`. The environment decides who may let agents use the secret (R21). Governs R2, R21.
- **Doppler secrets are picked, not mirrored** (session-settled: user choice). A project linked to a Doppler config chooses which of its secrets to add. Governs R31.
- **Workspace-level secrets come later** (session-settled: user wants them, but not in this plan). Governs Scope Boundaries.
- **Revealing is a separate, logged act** (proposed). Listing never decrypts. Reveal and copy each write a `sensitive` activity entry with who, which secret and which field. Governs R13-R16.
- **External agents get no value tool in the first phases** (proposed). Claude Code on a laptop cannot be given a value without the value passing through it. The first phases give it metadata only. A later phase adds a local `exec` command that puts values into a child process's environment. Governs R39-R42.

### Actors

- **Project member or admin with `secrets.reveal` / `secrets.write`:** adds secrets, edits and reveals those whose audience includes them.
- **Project viewer, or a member without `secrets.reveal`:** sees that a project-wide secret exists, with its name, description, fields and expiry, never its value. Secrets restricted to other people or departments are not listed for them at all.
- **Secrets manager (`secrets.manage`, Owner by default):** can change any secret's audience and metadata in the projects they can open, to recover a secret whose audience left. Does not see values unless they put themselves in the audience, which is logged and announced to the secret's creator.
- **Workspace admin (`integrations.manage`):** connects an external provider (Doppler) once for the workspace.
- **ordi agent:** a run of an AI agent employee; gets allowed secrets as environment variables.
- **External agent:** Claude Code or another MCP client using a personal API token; sees metadata only.
- **Provider:** Doppler (later others); the source of values for secrets that live there.

### Requirements

**Data and encryption**

- R1. A secret belongs to one project and appears in its Resources list with a lock icon. `project_resources` gains the kind `secret` with a `secret_id` reference, and its check constraint grows accordingly.
- R2. A secret has a name (upper snake case, unique per project, 2-64 characters, e.g. `STRIPE_TEST`), an optional description, an environment (`test`, `staging`, `production`, `other`; required, no default, so the person saving it decides), an optional `expires_at`, a source (`ordi` or `provider`), an audience (R46), and one or more fields.
- R3. A field has a key (lower snake case, unique within the secret, e.g. `api_key`), a label, a type (`text`, `password`, `url`, `api_key`, `note`), and a value. `url` and `text` fields are not secret and are shown without a reveal. `password`, `api_key` and `note` are secret.
- R4. Field metadata (key, label, type, whether it has a value, last 4 characters for `api_key`) is stored in the clear so lists never decrypt. Secret values are stored together as one encrypted JSON payload per secret.
- R5. Values are never returned by list or get endpoints, never written to `activity_log`, never included in search, exports or the CSV export, and never copied when a project is duplicated or used as a template.
- R6. Ciphertext carries a version prefix (`v1:<iv>:<tag>:<data>`). `decrypt` still reads the current unprefixed format, so agent credentials and git tokens keep working.
- R7. In production (`NODE_ENV=production`) the API refuses to start when `ENCRYPTION_KEY` is missing, is all zeros, or is not 64 hex characters. Today it silently falls back to zeros (`env.ts`).
- R8. A key rotation command re-encrypts every secret payload (and, in the same pass, agent credentials and connector secrets) from an old key to a new one. It is a CLI script, not an endpoint.
- R9. Deleting a secret deletes its payload row in the same transaction. A soft-deleted project keeps its secrets, which come back with a restore, and a hard delete cascades.

**People**

- R10. Adding a secret: Resources → Add → Secret opens a dialog with name, description, environment, "Who can see the values" (R46), expiry and a field list. A "Paste credentials" box takes free text the client sent ("login: x / password: y / https://...") and proposes fields from it. Nothing is saved until the user confirms.
- R11. Editing replaces a field value only when a new one is typed. An empty input keeps the stored value, so values are never sent to the browser just to edit metadata.
- R12. In the list, a secret row shows its name, the field labels and an "expires in N days" or "expired" hint. Clicking it opens a panel with the fields.
- R13. Each secret field has Reveal (shows the value for 30 seconds, then masks it again) and Copy (copies it to the clipboard without showing it). Both call one endpoint that returns a single field's value.
- R14. Who may reveal is decided by the access rules in R43-R56.
- R15. Every reveal and copy writes an activity entry on the secret with `sensitivity: 'sensitive'`, the actor and the field key, never the value. The secret panel shows "last revealed by X, 2 hours ago".
- R16. Reveals are rate-limited per user (e.g. 30 a minute) to slow down scraping by a stolen session.
- R17. `expires_at` is the date the credential itself stops working: a trial API key, a contractor's temporary login, a certificate, a password the client rotates every 90 days. It is optional. Fourteen days before it, the secret's creator and the project admins in its audience get a notification, and the list marks the secret "expires in N days", then "expired".

**MCP (all agents)**

- R18. `list_project_secrets {project}` returns, for the secrets the token's user may list (R50), names, descriptions, environment, field keys, labels and types, `hasValue`, expiry, source, and whether the secret is available to agent runs. It never returns values or last-4 hints.
- R19. `check_project_secret {project, name}` returns `{exists, fields, expired, availableToAgents}`. This is how an agent "checks that it is there" before relying on it.
- R20. No MCP tool returns a secret value in the phases U1-U5. The tool descriptions say so, and say how the value can be used instead (agent runs: environment variable; external agents: R39).

**ordi agent runs**

- R21. A secret has an "Available to agents" switch, off by default. Only secrets with the switch on, in the run's project, are passed to a run, and only when the agent itself is a member of that project. Anyone who may edit the secret can switch it on for `test`, `staging` and `other` secrets. A `production` secret needs `secrets.manage`, and the switch shows a warning. Changing the environment of a secret to `production` turns the switch off.
- R22. The API resolves the values when it builds the run bundle (`RunBundle.secrets`) and hands them to the worker exactly like the model credential today. The standalone worker still holds no `ENCRYPTION_KEY`.
- R23. Each field becomes one environment variable: `<SECRET>` for a single-field secret, `<SECRET>__<FIELD>` otherwise (e.g. `STRIPE_TEST__API_KEY`). Names that collide with the runtime's own variables (`PATH`, `HOME`, `ANTHROPIC_*`, `CLAUDE_*`, `GIT_*`, `ORDI_*`) are refused when the secret is saved.
- R24. The run's system prompt lists the available variable names and field labels, never values, with an instruction to use them through the environment and never to print, commit or post them.
- R25. Every value is registered with `registerRunSecrets`, so the run log, tool results and progress events replace it with `[redacted]` (this already exists for the model credential and the run token).
- R26. Writes made with the run's token (comments, task descriptions, KB pages, project updates, resource labels) are scrubbed of the run's secret values before they are stored. A write that contained one is stored redacted and the run log gets a warning event.
- R27. Before the worker pushes the branch, it scans the diff for the run's secret values. A hit fails the push with a clear reason in the run log and on the task, and the branch is not pushed.
- R28. Each run records which secret names it received (not values). The secret panel shows "used by agent runs" with links.
- R29. A secret that has expired, or whose provider cannot be reached, is left out of the run with a warning event. The run itself still starts.

**External providers (Doppler first)**

- R30. A workspace admin connects Doppler in Settings → Integrations with a service token. The token is read-only and scoped to one Doppler config. It is stored encrypted, verified on save by listing secret names, and never shown again.
- R31. A connection can be linked to one or more ordi projects. A project's Resources then offer "Add from Doppler", which lists the config's secret names. The user picks the ones to add, and each becomes an ordi secret with `source: 'provider'` pointing at a Doppler name. The config is never mirrored as a whole, so new Doppler secrets do not appear in ordi until someone adds them. Provider secrets have an audience and an environment like any other.
- R32. A provider secret stores no value in ordi. Its fields map to Doppler names (one Doppler secret per field), so a client login can be `ACME_LOGIN` and `ACME_PASSWORD` in Doppler and one secret with two fields in ordi.
- R33. Values are fetched from the provider on reveal, copy and run start, and held only for that request or that run's bundle. Nothing is cached at rest.
- R34. A rotated value in Doppler is the value the next reveal or run gets, with no action in ordi.
- R35. A provider error (revoked token, renamed secret, outage) shows on the secret ("Doppler: secret not found") and on the connection card. The secret is skipped for runs (R29).
- R36. Removing a provider connection marks its secrets as disconnected rather than deleting them, so their names and metadata stay visible until someone removes or relinks them.
- R37. Providers are adapters behind one interface: `verify`, `listNames`, `getValues(names)`. Doppler is the only adapter in U5. 1Password (service accounts or Connect), Infisical, HashiCorp Vault, AWS Secrets Manager and Bitwarden Secrets Manager follow the same shape.
- R38. Doppler requests go to `https://api.doppler.com/v3` with the service token as a bearer. Names come from the config's secrets list. Values come from `GET /v3/configs/config/secrets/download?format=json` limited to the requested names. With a service token, project and config are implied by the token.

**External agents (later phase)**

- R39. `ordi secrets exec --project LCH --secret STRIPE_TEST -- <command>` (a subcommand of the existing `@ordi/mcp` package) fetches the values with the user's API token and runs the command with them in its environment. The values do not go through the MCP connection or the model.
- R40. Reveal through an API token requires a token created with the `secrets.reveal` scope. Ordinary MCP tokens cannot reveal.
- R41. Each `exec` writes the same sensitive activity entry as a reveal in the UI, with `actorType: 'integration'` and the token's name.
- R42. A "request access" flow, where an external agent asks and a human approves a one-time reveal in the UI, is noted as a possible later step and is not designed here.

**Access: workspace role × project role × audience**

- R43. Four new permissions in the `secrets` domain of the role editor:
  - `secrets.read`: see the secrets of the projects one can open (names and metadata, R50).
  - `secrets.reveal`: reveal and copy values of secrets whose audience includes the person.
  - `secrets.write`: create secrets, and edit and delete those whose audience includes the person.
  - `secrets.manage`: change any secret's audience, environment and agent switch in the projects one can open, without being in its audience.
- R44. Presets: Owner gets all four. Admin and Manager get `read`, `reveal` and `write`. Member gets `read` and `reveal`. Guest, Sales, Finance, HR and Agent get none. A migration adds them to existing roles in the same way (modelled on `0033_people_read_documents.sql`), and custom roles can be edited as usual.
- R45. The project layer is the existing one: listing needs project role viewer or above (`assertProject`), revealing and writing need member or above. Leaving a project, or the project going private without the person, removes their access to its secrets with no extra step.
- R46. The audience is a list of principals, set when the secret is created and editable later:
  - `project`: everyone who passes R45 in this project;
  - `user:<id>`: a named person, offered from the project's members only;
  - `department:<id>`: everyone whose employee record is in that department or one of its sub-departments (`departments.parent_id`).

  A mix is allowed, for example the project lead plus the Development department. The default for a new secret is `project`.
- R47. A department principal matches a user through their `employees` row (`employees.user_id`). A user with no employee record matches no department, and the dialog says so ("3 people in Development, 1 without access to this project").
- R48. The audience never widens the other two layers. A named person who is not on the project, or whose role lacks `secrets.reveal`, still cannot reveal. The dialog shows who will effectively have access, computed from all three layers.
- R49. An empty audience is refused. A change that would leave nobody able to reveal the secret needs `secrets.manage`.
- R50. Listing: a secret with audience `project` is listed for everyone with `secrets.read` and project role viewer or above. A secret restricted to people or departments is listed only for its audience and for holders of `secrets.manage`. Others do not learn that it exists, so a name like `PROD_ROOT` stays private. This rule applies to the Resources list, MCP tools, search, activity and notifications alike.
- R51. Revealing needs all of: `secrets.reveal`, project role member or above, and the person in the audience.
- R52. Editing fields and values needs `secrets.write`, project role member or above, and the person in the audience. Changing the audience, the environment or the agent switch needs the same, or `secrets.manage`.
- R53. A `secrets.manage` holder who changes the audience of a secret they are not in, or adds themselves to it, triggers a `sensitive` activity entry and a notification to the secret's creator and the project admins in its audience. This is the break-glass path when everyone in an audience has left.
- R54. Holding `projects.write` (which makes someone an admin of every workspace project) does not by itself give access to any secret value. Reveal always goes through R51.
- R55. API tokens get the intersection of their owner's access and the token's scopes. Revealing through a token also needs the `secrets.reveal` token scope (R40).
- R56. An ordi agent is a user with the Agent role (no secrets permissions), so it can never reveal through the API. Its only way to a value is R21: being a member of the project when a run starts, with the secret's agent switch on.

### Key Flows

1. **Client sends access.** A member opens the project, then Resources → Add → Secret, pastes the client's message, gets `login`, `password` and `url` fields proposed, names the secret `ACME_ADMIN`, and saves. The list shows `ACME_ADMIN · Login, Password, URL`, and the URL is visible without a reveal.
2. **Someone needs the password.** A teammate opens the secret and clicks Copy on Password. The value goes to the clipboard, and the activity shows "copied Password".
3. **An agent uses a test key.** `STRIPE_TEST` has "Available to agents" on. A task is assigned to an agent. The run gets `STRIPE_TEST` in its environment, and its prompt says the variable exists. The agent's test script reads `process.env.STRIPE_TEST`. When the agent prints the key by mistake, the log shows `[redacted]`. When it commits a file containing the key, the push is refused.
4. **An external agent checks.** Claude Code on a laptop calls `check_project_secret {project: "LCH", name: "STRIPE_TEST"}` and learns the secret exists and is not expired. It tells the user to run `ordi secrets exec ... -- npm test`, or the user does it themselves.
5. **Doppler.** An admin connects a Doppler service token for the `acme/dev` config and links it to project ACME. A member adds `STRIPE_TEST` from the Doppler list. A later rotation in Doppler is what the next run gets.

### Acceptance Examples

- A project viewer lists Resources and sees `ACME_ADMIN` (audience: project) with its field labels. Calling the reveal endpoint returns 403.
- `PROD_ROOT` has the audience "project lead + Development". A designer on the project does not see it in Resources, search or activity. A developer whose role is Guest sees it but cannot reveal it. The project lead reveals it.
- `GET /projects/:id/resources` and `GET /project-secrets/:id` responses contain no value and no ciphertext, and a test greps the JSON for the stored value.
- An activity entry exists for each reveal, with `sensitivity: 'sensitive'`, and contains no value.
- An agent run whose tool output contains the value stores `[redacted]` in `agent_run_events`. A comment posted by that run with the value stores `[redacted]`.
- A run whose diff contains a secret value ends with `push_refused_secret`, and no branch reaches the remote.
- `ENCRYPTION_KEY=000…0 NODE_ENV=production` refuses to start with a message saying how to generate a key.
- With a Doppler connection, revoking the service token makes the next reveal fail with a provider error and leaves the secret's metadata in place.

### Success Criteria

- Storing a client's credentials takes one paste and one click, and nobody needs a separate password manager for project access.
- No secret value appears in any API list response, activity entry, search result, export, run log, agent-authored comment or pushed commit.
- An agent can complete a task that needs a test API key without the key appearing in its transcript.
- Moving a project's secrets to Doppler later is "Add from Doppler", not a rewrite.

### Scope Boundaries

**Deferred for later**

- Workspace-level secrets shared by several projects (Q2), with project grants on the same principals.
- Role principals (`role:<id>`) in a secret's audience. Departments and people cover the cases raised so far.
- Secrets on CRM companies or deals (a client's billing portal login). The model allows it later, through an owner reference instead of `project_id`.
- Approval-based one-time reveal for external agents (R42).
- Providers other than Doppler (R37).
- Writing back to a provider (creating or rotating a value in Doppler from ordi).
- Secret version history in ordi (Doppler keeps its own).

**Explicitly out of scope**

- A password manager for personal accounts. Secrets belong to projects.
- Browser autofill or an extension.
- Sharing a secret with someone outside the workspace (client portal, public link).
- Hardware security modules or a cloud KMS. Self-hosted ordi has one `ENCRYPTION_KEY`, and R8 covers its rotation.

### Dependencies / Assumptions

- PR #148 (`project_resources`) is merged first, since secrets are a resource kind.
- `lib/crypto` AES-256-GCM (`encrypt`/`decrypt`) is the encryption primitive. Its output has no version today, which R6 adds.
- The agent run pipeline already decrypts the model credential in the API, passes it in `RunBundle.credentials`, builds the runtime env in `runtime/claude-code.ts`, and redacts registered values with `registerRunSecrets` / `scrub` in `run-events.ts`. R22-R25 extend that path rather than adding a new one.
- The standalone agent worker holds no `ENCRYPTION_KEY` by design (`agent-worker.ts`), so values must be resolved in the API.
- Doppler service tokens are read-only and scoped to one config. Restricted Doppler secrets are readable only with a service token. Checked against Doppler's docs on 2026-11-05. The exact names-list endpoint is confirmed in U5 against the live API reference before coding.
- `@ordi/mcp` is run locally by users with an API token (`OrdiClient`), so it is the natural home for the `exec` subcommand (R39).

### Sources / Research

- [Doppler API reference](https://docs.doppler.com/reference/api)
- [Doppler: Download Secrets](https://docs.doppler.com/reference/secrets-download)
- [Doppler: Service Tokens](https://docs.doppler.com/docs/service-tokens)
- [Doppler: Secret Visibility (restricted secrets)](https://docs.doppler.com/docs/secret-visibility)
- `docs/plans/2026-09-05-001-feature-ai-agent-employees-plan.md` (KTD5: secrets stay in the API; the worker split).
- `apps/api/src/lib/crypto.ts`, `apps/api/src/domains/agents/run-events.ts`, `apps/api/src/domains/agents/runtime/claude-code.ts`, `apps/api/src/domains/agents/run-backend.ts`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Tables: `project_secrets` (id, project_id, name, description, environment, source, provider_connection_id, expires_at, available_to_agents, fields jsonb with metadata only, created_by, timestamps, last_revealed_at, last_revealed_by), `project_secret_audience` (secret_id, principal_type `project | user | department`, principal_id nullable for `project`, primary key on all three), and `project_secret_payloads` (secret_id PK/FK, ciphertext, key_version). Keeping the ciphertext in its own table means no `select()` of secrets can return it by accident. `project_resources.secret_id` references `project_secrets` with `ON DELETE CASCADE`. Governs R1-R5, R9.
- KTD2. `lib/crypto` gets `encryptV1`/`decrypt` with a `v1:` prefix and a key id. `decrypt` accepts both formats. A `scripts/rotate-encryption-key.ts` re-encrypts all ciphertext columns (secret payloads, `agent_credentials`, connector secrets, git credentials) inside one transaction per table. Governs R6-R8.
- KTD3. Routes: `POST /projects/:id/secrets`, `GET /project-secrets/:id` (metadata), `PATCH /project-secrets/:id`, `DELETE /project-secrets/:id`, and `POST /project-secrets/:id/reveal {field}`, which is POST so it is never cached, prefetched or logged as a GET. Listing goes through `GET /projects/:id/resources`, extended with secret metadata. Governs R10-R16.
- KTD4. Reveal checks `assertProject(actor, projectId, 'member')`, applies an in-memory per-user rate limit (`checkRate`, as login does), writes the activity entry, and sets `Cache-Control: no-store`. An API token needs the `secrets.reveal` scope (R40). Governs R13-R16, R40.
- KTD5. Permissions: a `secrets` domain with `secrets.read`, `secrets.reveal`, `secrets.write` and `secrets.manage` in `packages/shared/src/permissions.ts`, preset assignments in `roles.ts`, and a backfill migration. One access function holds all three layers: `secretAccess(actor, secret, projectRole, audienceMatch) → { list, reveal, write, manage }`. It lives in `packages/shared/src/calc/rbac.ts` next to `projectAccessRank` and `canSeePage`, with a unit test matrix. Every route, the MCP tools, search and notifications call it, so the rule is written once (this is the lesson of `canSeePage`). Audience matching resolves the actor's department chain once per request (`employees` → `departments.parent_id`). The `secrets.reveal` token scope is added to the token scope catalogue (R40, U6).
- KTD6. Agent runs: `RunBundle` gains `secrets: { name: string; value: string }[]`, built in `run-service.ts` `prepare` from the run's project. `buildRuntimeEnv` merges them after a reserved-name check. `registerRunSecrets` gets them together with the token. Agent-authored writes go through one `scrubAgentWrite(actor, text)` helper, called in the comment, task, KB and project-update services when `actor.actorType === 'agent'` and the actor's token belongs to an active run. Governs R21-R29.
- KTD7. Push scan: `workspace.ts` runs `git diff --cached` / `git log -p origin/<base>..HEAD` and searches it for each value (values shorter than 8 characters are skipped, as `registerRunSecrets` already does) before `git push`. A hit returns a `push_refused_secret` outcome that the run service reports like any other push failure. Governs R27.
- KTD8. Providers: `secret_provider_connections` (id, kind, label, encrypted token, config jsonb such as Doppler project and config names read back from the token, status, last_error, connected_by) and `project_secret_provider_links` (project_id, connection_id). Adapters live in `apps/api/src/domains/secrets/providers/{index,doppler}.ts` behind `SecretProvider { verify(); listNames(); getValues(names) }`. Requests use `fetch` with a 10-second timeout and no retries on 4xx. Governs R30-R38.
- KTD9. MCP: `list_project_secrets` and `check_project_secret` in `packages/mcp/src/tasks.ts`, next to the resource tools, built on the metadata endpoints. `exec` is a bin entry in `@ordi/mcp` (U6). Governs R18-R20, R39.
- KTD10. Web: `Secret` joins the Resources Add menu and row kinds. A `SecretPanel` side panel (the pattern of `MilestoneDetails`) holds the fields with Reveal/Copy, the expiry, the agents switch and recent reveals. A `pasteToFields(text)` helper is a pure function with its own unit tests. Governs R10-R17, R21.

### High-Level Technical Design

```
Browser ──POST /project-secrets/:id/reveal──▶ API ─ assertProject(member) ─ rate limit
                                                  ├─ source=ordi:     decrypt(payload)[field]
                                                  └─ source=provider: provider.getValues([name])
                                                  └─ activity(sensitive, no value) ─▶ { value } (no-store)

Agent run:  API prepare() ── secrets with available_to_agents ──▶ RunBundle.secrets
            worker: buildRuntimeEnv(+secrets) · registerRunSecrets(values) · push scan
            run token writes ─▶ scrubAgentWrite ─▶ stored as [redacted]

MCP (any agent): list_project_secrets / check_project_secret ─▶ metadata only
```

### State and Compatibility Rules

- Existing ciphertext (agent credentials, connectors, git tokens) is read unchanged. New writes use `v1:`. Rotation converts everything.
- `project_resources` keeps working for links, files and pages. The secret kind is additive, and the check constraint is replaced in one migration.
- The production `ENCRYPTION_KEY` check is a startup change: an install running on the zero key must set a real key before upgrading. Agent credentials and git tokens encrypted under the zero key must then be re-entered or rotated with the U0 script (old key = zeros). The release notes say this prominently.

### System-Wide Impact

- **Search, exports, templates, duplication:** must skip secrets. Tests assert it (R5).
- **Activity UI:** secret entries carry `sensitive`. Only people who may reveal see the "revealed" lines. Others see "a secret was added". Restricted secrets (R50) leave no trace at all in the activity of people outside their audience.
- **Role editor:** gets the `secrets` domain with four toggles and short explanations, including that `secrets.manage` changes who has access but does not show values.
- **People module:** department membership starts to matter for access. Moving someone between departments changes which secrets they can reveal, and the employee page says so.
- **Agent prompt:** grows by a short "Available environment variables" block.
- **Desktop app:** nothing specific. Copying to the clipboard works in the webview.

### Risks and Mitigations

- **An agent prints or exfiltrates a value it holds in its environment.** Redaction of logs, scrubbing of agent writes and the push scan cover ordi's own channels. An agent with network access could still send a value out (for example `curl` to an outside host). Mitigations are the off-by-default switch per secret, test-only keys for agents, and the recorded "used by run" trail. This residual risk is stated in the UI next to the switch.
- **`ENCRYPTION_KEY` leaks.** All values are exposed. Mitigations: the R7 refusal of weak keys, the R8 rotation script, and documentation on keeping the key out of the database host's backups.
- **Doppler outage at run start.** The secret is skipped with a warning, and the run continues (R29).
- **Department changes silently change access.** Moving a person to another department in People removes their access to secrets addressed to the old one. The audience dialog and the employee page both show the effect, and the activity records the department change.
- **Locked-out secrets.** When everyone in an audience leaves, only a `secrets.manage` holder can recover the secret, and doing so is announced (R53).
- **Paste heuristics put a password in a non-secret field.** The parser maps anything that is not clearly a URL or a login to `password`, and the user confirms the fields before saving.

### Sequencing

U0 → U1 → U2 → U3 ship as phase 1 (native secrets for people and MCP metadata). U4 is phase 2 (agent runs). U5 is phase 3 (Doppler). U6 is phase 4 (external agents). U7 runs in every phase.

## Implementation Units

### U0. Harden the encryption key and version the ciphertext

- **Goal:** Make "encrypted at rest" mean something before more secrets depend on it.
- **Requirements:** R6, R7, R8.
- **Files:** `apps/api/src/env.ts`, `apps/api/src/lib/crypto.ts`, `scripts/rotate-encryption-key.ts`, `docs/deployment.md`, `.env.example`, a crypto unit test.
- **Approach:** Production startup check. `v1:` prefix with key id, reading both formats. Rotation script with `--from`/`--to` over every ciphertext column. Deployment docs on generating and rotating the key.
- **Test scenarios:** Old-format ciphertext still decrypts. A tampered tag fails. Rotation round-trips every table. A weak key is refused only in production.

### U1. Data model, access rules and API

- **Goal:** Store, edit, list and reveal secrets with the three-layer access model and the audit trail.
- **Requirements:** R1-R5, R9, R11, R13-R16, R43-R56.
- **Files:** `packages/db/src/schema/secrets.ts`, a migration extending `project_resources` and backfilling the `secrets` permissions, `packages/shared/src/permissions.ts`, `packages/shared/src/roles.ts`, `packages/shared/src/calc/rbac.ts` (+ test), `packages/shared/src/schemas/secrets.ts`, `apps/api/src/domains/secrets/{routes,service,audience}.ts`, `apps/api/src/domains/projects/resources.routes.ts`, `apps/api/src/test/project-secrets.test.ts`, `apps/api/src/test/rbac.test.ts`.
- **Test scenarios:**
  - No value or ciphertext in any list or get response.
  - Each layer alone denies: a role without `secrets.reveal`, a project viewer, and someone outside the audience all fail to reveal.
  - A department audience matches sub-departments, and not a user without an employee record.
  - A restricted secret is absent from the list, search and activity for people outside its audience.
  - `projects.write` alone reveals nothing.
  - A `secrets.manage` holder changes an audience, and the creator is notified.
  - An empty audience is refused.
  - Every reveal is logged without its value, and the rate limit holds.
  - A name collision is refused, editing without a value keeps it, delete cascades, and search and export leave secrets out.

### U2. Web: secrets in Resources

- **Goal:** One-paste add, an audience picker that shows who will effectively have access, a panel with Reveal and Copy, and expiry hints.
- **Requirements:** R10-R17, R46-R49. The role editor gets the `secrets` domain.
- **Files:** `apps/web/src/components/project/ProjectResources.tsx`, `apps/web/src/components/project/SecretPanel.tsx`, `apps/web/src/lib/pasteToFields.ts` (+ test), i18n in both locales.
- **Test scenarios:** Unit tests for paste parsing. A manual walk-through in both themes. The value is masked again after 30 seconds. A copy never renders the value.

### U3. MCP metadata tools

- **Goal:** Agents can check that a secret exists and what it holds, never its value.
- **Requirements:** R18-R20.
- **Files:** `packages/mcp/src/tasks.ts`, `packages/mcp/src/resources.test.ts`.
- **Test scenarios:** Tool output contains no value or last-4 hint. A missing secret answers `exists: false`, not an error.

### U4. Secrets in agent runs

- **Goal:** ordi agents use allowed secrets through their environment, with ordi's channels scrubbed.
- **Requirements:** R21-R29.
- **Files:** `apps/api/src/domains/agents/{run-backend,run-service,prompt,workspace}.ts`, `apps/api/src/domains/agents/runtime/claude-code.ts`, the services agent writes go through, `apps/api/src/test/agents-secrets.test.ts`.
- **Test scenarios:** Only allowed secrets reach the bundle. Reserved names are refused. Log events are redacted. An agent comment with a value is stored redacted. The push scan refuses a diff containing a value. Expired and unreachable secrets are skipped with a warning.

### U5. Doppler provider

- **Goal:** Connect Doppler once and use its secrets in projects without copying values into ordi.
- **Requirements:** R30-R38.
- **Files:** `packages/db/src/schema/secrets.ts` (connections, links), `apps/api/src/domains/secrets/providers/{index,doppler}.ts`, Settings → Integrations card, "Add from Doppler" picker, `apps/api/src/test/secrets-doppler.test.ts` with a mocked `fetch`.
- **Test scenarios:** Verify on save. The names list maps into fields. Reveal and run fetch on demand. Nothing is cached at rest. Token revocation and a renamed secret are surfaced. A removed connection marks secrets disconnected.

### U6. External agents

- **Goal:** Local agents and scripts can use values without them passing through the model.
- **Requirements:** R39-R41.
- **Files:** `packages/mcp/src/exec.ts`, `packages/mcp/package.json` (bin), the token scope catalogue, API token UI, docs.
- **Test scenarios:** Without the `secrets.reveal` scope the API refuses. `exec` passes values only in the child's environment and exits with the child's code. Each use is logged.

### U7. Documentation and release notes

- **Goal:** Users know where secrets live, who sees what, and what agents can and cannot do with them.
- **Files:** `README.md` features, `docs/features.md`, `CHANGELOG.md`, `docs/deployment.md` (key handling), the MCP tool descriptions.

## Verification Contract

- **Per unit:** the focused tests listed in each unit, plus `pnpm typecheck`, `pnpm lint` and `pnpm check:query-shapes`.
- **Leak test:** a test helper stores a known value and greps every response, activity row, run event and stored comment produced in the suite for it.
- **Manual:** the five key flows in the app against a local database, in both themes. For U5, against a real Doppler dev config with a service token.

## Definition of Done

- Every R-ID is implemented or deferred by a scope boundary.
- The leak test passes across the API suite.
- Existing encrypted data (agent credentials, connectors, git tokens) still decrypts after U0, and the rotation script has been exercised.
- Release notes call out the `ENCRYPTION_KEY` startup check.

## Settled Questions

- **Q1. Who may reveal?** Settled: three layers (R43-R56). The audience is chosen per secret from the whole project, named people and departments.
- **Q2. Workspace secrets?** Deferred by the user ("good, but later"). The audience table is keyed by secret, so a later `workspace_secrets` with project grants can reuse the same principals and access function.
- **Q3. Expiry:** clarified as the date the credential itself stops working (R17). Reminder 14 days before, to the creator and the project admins in the audience. It can be changed in review.
- **Q4. Telling test keys from real ones:** ordi cannot, so the person saving a secret chooses its environment (R2). Production secrets need `secrets.manage` to be given to agents (R21). The agent switch stays off by default for every environment.
- **Q5. Doppler:** pick secrets from a linked config, no mirroring (R31).
