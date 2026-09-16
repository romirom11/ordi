# site

A redirect to <https://ordi.one>, published to GitHub Pages at
<https://romirom11.github.io/ordi/>.

This used to be a hand-written copy of the landing page. It is not any more:
the site lives in the `ordi-cloud` repository and is deployed to ordi.one,
and a second copy here only ever meant one of the two was stale — which it
was, for several releases. Everything a visitor wants is on ordi.one, which
has pages this copy never had (downloads, pricing, sign-in, changelog).

`index.html` is self-contained: a canonical tag, a meta refresh and a script
that preserves the path and anchor someone arrived with, plus a visible link
for anyone who gets neither.

```bash
pnpm site:build                     # -> site/dist (gitignored)
python3 -m http.server -d site/dist 4321
```

`.github/workflows/pages.yml` runs the same script on every push to `master`
that touches `site/` or the build script, and deploys `site/dist`. It needs
**Settings → Pages → Source: GitHub Actions** enabled once on the repository.

Copy edits for the real landing page belong in `ordi-cloud`, not here.
