# Working in this repository

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
