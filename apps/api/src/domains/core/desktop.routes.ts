/**
 * Where to download the desktop app from, so people do not have to go hunting
 * on GitHub. The release metadata is fetched from the public releases API and
 * cached in memory – a self-hosted instance may well have no outbound network,
 * so every failure degrades to "here is the releases page".
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../context';
import { env } from '../../env';

export type DesktopPlatform = 'macos' | 'windows' | 'linux_appimage' | 'linux_deb';

interface DesktopRelease {
  version: string | null;
  publishedAt: string | null;
  releaseUrl: string;
  downloads: Partial<Record<DesktopPlatform, { url: string; size: number }>>;
}

interface GithubAsset { name: string; browser_download_url: string; size: number }
interface GithubRelease { tag_name: string; published_at: string; html_url: string; assets: GithubAsset[] }

const CACHE_TTL_MS = 60 * 60_000;
// A release with no installers (fetch failure, or the short window while a
// release's binaries are still uploading) must not stick for a whole hour –
// retry soon so the download page recovers as soon as the assets exist.
const EMPTY_CACHE_TTL_MS = 60_000;
let cache: { at: number; value: DesktopRelease } | null = null;

function platformOf(assetName: string): DesktopPlatform | null {
  const name = assetName.toLowerCase();
  if (name.endsWith('.dmg')) return 'macos';
  if (name.endsWith('.msi') || name.endsWith('.exe')) return 'windows';
  if (name.endsWith('.appimage')) return 'linux_appimage';
  if (name.endsWith('.deb')) return 'linux_deb';
  return null;
}

async function fetchLatest(): Promise<DesktopRelease> {
  const repo = env.desktopReleasesRepo;
  const fallback: DesktopRelease = {
    version: null, publishedAt: null,
    releaseUrl: `https://github.com/${repo}/releases/latest`,
    downloads: {},
  };
  if (!repo) return fallback;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ordi' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as GithubRelease;

    const downloads: DesktopRelease['downloads'] = {};
    for (const asset of body.assets ?? []) {
      const platform = platformOf(asset.name);
      // Updater bundles sit next to the installers; only offer the installers.
      if (!platform || asset.name.endsWith('.sig') || asset.name.includes('.tar.gz')) continue;
      downloads[platform] ??= { url: asset.browser_download_url, size: asset.size };
    }
    return {
      version: body.tag_name?.replace(/^v/, '') ?? null,
      publishedAt: body.published_at ?? null,
      releaseUrl: body.html_url ?? fallback.releaseUrl,
      downloads,
    };
  } catch {
    return fallback;
  }
}

export function desktopRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/latest', async (c) => {
    const ttl = cache && Object.keys(cache.value.downloads).length === 0 ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS;
    if (!cache || Date.now() - cache.at > ttl) {
      cache = { at: Date.now(), value: await fetchLatest() };
    }
    return c.json(cache.value);
  });

  return app;
}
