# Contributing to ordi

Thanks for taking the time. ordi is a small project, so the bar is practical
rather than ceremonial: a change that works, is tested the way the rest of the
code is tested, and reads like the code around it will get merged.

## Before you start

- **Bug fixes** – open a PR directly. No issue required for something small.
- **New features** – open an issue first and describe the problem you hit. ordi
  is opinionated on purpose; a feature that fits one workflow and complicates
  everyone else's is a hard sell, and it is better to find that out before you
  write it.
- **Anything touching security, permissions or money** – say so in the
  description. Those get read carefully.

## Setting up

Requires Node 22, pnpm 10 and PostgreSQL 16.

```bash
pnpm install
cp .env.example .env          # point DATABASE_URL at your Postgres

pnpm db:migrate               # schema + triggers
pnpm db:seed                  # demo workspace to develop against

pnpm api:dev                  # http://localhost:3000
pnpm web:dev                  # http://localhost:5173
```

Sign in as `owner@ordi.local` / `password123`.

## Before you open the PR

```bash
pnpm typecheck            # must be clean
pnpm test                 # API tests need a database
pnpm check:query-shapes   # guards against React Query cache-shape collisions
```

API tests run their files in parallel, each worker on its own copy of the
test database: `TEST_DATABASE_URL` (default
`postgres://postgres:postgres@localhost:5432/ordi_test`) is migrated once and
cloned as `ordi_test_w1`, `ordi_test_w2`, … Set `TEST_WORKERS=1` to run the files
one after another.

CI runs all three plus a production web build. Green CI is expected, not a
formality – if a check fails and you believe the check is wrong, say so in the PR
instead of working around it.

## Conventions

**Follow the surrounding code.** Match its naming, its comment density, its
idioms. A PR that reformats a file it also changes is hard to review.

**Comments explain why, not what.** The code already says what it does. If a
line looks strange but is deliberate, that is worth a comment.

**Frontend**

- Use the design tokens: `bg-background`, `bg-surface`, `text-muted-foreground`,
  `border-border` and friends. No raw hex colours, no `dark:` variants – theming
  goes through the tokens.
- Reuse the primitives in `components/ui.tsx` and `components/overlays.tsx`
  before writing a new one.
- Register translations with `extendDict` at the top of your module, in both
  `en` and `uk`. Never leave a user-visible string untranslated.
- Shared query hooks belong in `lib/queries.ts`. Two components fetching the same
  endpoint under the same query key must agree on the stored shape – this has
  caused real crashes, which is why `pnpm check:query-shapes` exists.
- Never use `alert()` or `confirm()`; use the dialog and toast primitives.

**Backend**

- Every route enforces permissions. The UI hiding a button is not access control.
- Validate input with Zod schemas from `packages/shared`.
- Writes that a user can conflict on take a `version` and return 409 on mismatch.
- Migrations are additive and generated with `pnpm db:generate`. Do not edit an
  applied migration to change behaviour – add a new one.

**Typography** – use an en dash (`–`), never an em dash (`—`), in any
user-visible string. Yes, really.

## Commits and PRs

PRs are squash-merged, and the PR title becomes the line in the release
notes. Write it as a conventional commit with a sentence a user
understands: `feat: Milestones open in a side panel`,
`fix: The public intake form submits again`. `docs:`, `refactor:`, `test:`,
`build:`, `ci:` and `chore:` are for changes users do not see, and are left
out of the notes. A breaking change gets a `!` (`feat!: …`) and a
`BREAKING CHANGE:` note; [CLAUDE.md](CLAUDE.md#pr-titles-and-releases) has
the details. A check fails a PR whose title does not follow the form.

In the PR description, say what breaks if the change is wrong, and how you
verified it. "Tested by clicking through the project page in both themes" is a
useful sentence; "works" is not.

## Releases

[release-please](https://github.com/googleapis/release-please) keeps a
`chore: release X.Y.Z` PR open. It collects the titles of the PRs merged
since the last release into a new CHANGELOG section, and it bumps the version
in every file that carries it. Merging that PR is the release: the version is
tagged, a draft GitHub release is created with the same notes, and the
desktop and image builds start. The desktop workflow publishes the release
once every platform's bundle is uploaded.

Do not edit `CHANGELOG.md` or the version fields in a feature PR.

## Reporting bugs

Include the version, how you deployed, what you did, what happened and what you
expected. If the browser console showed an error, paste it – with the error
boundary in place, the message on screen is usually enough to locate the code.

Security issues go to [SECURITY.md](SECURITY.md), not to the issue tracker.
