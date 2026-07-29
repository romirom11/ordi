# site

The landing page published to GitHub Pages at <https://romirom11.github.io/ordi/>.

Hand-written HTML and CSS with a few lines of vanilla JS – no framework, no
dependencies, no lockfile. The only build step collects the screenshots out of
`docs/images` (and `mcp-consent.png`), which the README already uses, so a
screenshot is never stored twice.

```bash
pnpm site:build                     # -> site/dist (gitignored)
python3 -m http.server -d site/dist 4321
```

`.github/workflows/pages.yml` runs the same script on every push to `master`
that touches `site/`, the screenshots or the build script, and deploys
`site/dist`. It needs **Settings → Pages → Source: GitHub Actions** enabled once
on the repository.

Copy edits live in `index.html`; keep them in step with the README, which makes
the same argument for people who arrive through GitHub instead.
