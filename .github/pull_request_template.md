## What this changes

<!-- One or two sentences. What did you change and why was it needed? -->

## How it was verified

<!--
What did you actually run or click? For UI changes, which pages and which theme.
For API changes, which flow. "Typecheck passes" alone is not verification.
-->

## Checklist

- [ ] `pnpm typecheck` is clean
- [ ] `pnpm test` passes
- [ ] `pnpm check:query-shapes` passes
- [ ] New user-visible strings are registered with `extendDict` in both `en` and `uk`
- [ ] No em dashes (`—`) in user-visible strings
- [ ] Any new route enforces permissions
