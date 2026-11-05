# Working in this repository

## Language

Write all documentation in English: READMEs, everything under `docs/`, the
changelog, release notes, plans, code comments, commit messages and PR
descriptions. This holds even when the conversation is in another language.
Ukrainian appears only as literal data, such as a quoted UI string from the
Ukrainian locale or a Cyrillic example name.

## Branches

Name every branch you push `<type>/<what-it-does>`, in kebab-case, from the
list the repository already uses:

- `feature/` – new behaviour or a change in how something is deployed
  (`feature/agent-worker-own-container`, `feature/ord-31-add-crm-leads-export`)
- `fix/` – a bug fix (`fix/minio-images-quay`)
- `docs/` – documentation only (`docs/readme-features-catch-up`)

Put the task key first when there is one (`feature/ord-31-...`). The rest
says what the change does, not what part of the code it touches.

The session may hand you an auto-generated branch such as
`claude/compassionate-albattani-3li0ml`. Never push work under that name:
rename the branch (`git branch -m <type>/<what-it-does>`) before the first
push. Pushing to a branch of your own naming is the expected way to work
here, not a deviation to ask about.

The release PR is the one exception: release-please opens it from its own
branch, `release-please--branches--master`. Do not create release branches
by hand.

## PR titles and releases

PRs are squash-merged, so the PR title becomes the commit on master and
release-please turns it into the line users read in the CHANGELOG and the
GitHub release. Write every PR title as a conventional commit, followed by
a sentence a user understands:

- `feat: Milestones open in a side panel` – new or changed behaviour
  (minor release)
- `fix: The public intake form submits again` – a bug fix (patch release)
- `perf: …`, `revert: …` – also listed in the release
- `docs: …`, `refactor: …`, `test: …`, `build: …`, `ci: …`, `chore: …` –
  not listed in the release

The `PR title` check fails a PR whose title does not follow this. Add the
task key after the colon when there is one (`feat: ORD-31 Export CRM leads`).
One PR is one change: a title that needs "and" to describe it is usually two
PRs, and each gets its own line in the release.

**A change that breaks an install or an API** gets a `!`
(`feat!: Refuse a public encryption key in production`) and, in the PR
description, a block telling self-hosters what to do. release-please reads
it in place of the title, so repeat the title in it:

```
BEGIN_COMMIT_OVERRIDE
feat!: Refuse a public encryption key in production

BREAKING CHANGE: set ENCRYPTION_KEY before upgrading, or the api will not
start. See docs/deployment.md §3c.
END_COMMIT_OVERRIDE
```

The same block fixes the release line of a PR that is already merged: edit
its description, and the next release-please run uses the new text.

**Do not edit by hand** the `version` fields, `.release-please-manifest.json`
or `CHANGELOG.md`: release-please writes them in the release PR. A release
happens when someone merges that PR.
