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

## Moving to a custom domain

The page still points at `romirom11.github.io/ordi/`. Switching to a bought
domain is one commit, and the order matters – landing `CNAME` before DNS
resolves takes the published site down:

1. Buy the domain and point it at GitHub Pages (`A` records to GitHub's four
   Pages addresses, or `CNAME` to `romirom11.github.io`). Wait for it to
   resolve.
2. Add `site/CNAME` containing the bare domain. `scripts/build-site.mjs` copies
   everything in `site/` except `dist` and this README, so it reaches `dist`
   with no change to the workflow.
3. Rewrite the five absolute URLs in `index.html`: `link[rel=canonical]`,
   `og:url`, `og:image`, `twitter:image` and `url` in the JSON-LD block.
4. Settings → Pages → Custom domain, then tick **Enforce HTTPS** once the
   certificate is issued.

## Waitlist form

The `#hosting` form posts to the URL in its own `action` attribute and nowhere
else – swap that one placeholder for the real form/list endpoint. It degrades
to a plain POST without JS, and refuses to submit while the placeholder is
still in place.
