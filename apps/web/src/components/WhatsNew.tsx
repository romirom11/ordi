/**
 * After an update, one quiet row in the sidebar footer: "What's new in vX".
 * It opens the CHANGELOG sections of every version since the one this person
 * last saw on this device, and goes away once opened or dismissed.
 *
 * It shows after the update rather than before because the web app updates
 * on its own (UpdateIndicator turns the next page change into a reload):
 * web users never see an update prompt, so this is the one place both they
 * and desktop users learn what changed.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Dialog } from './overlays';
import { cn } from './ui';
import { rowCls } from './UpdateIndicator';
import { openExternal } from '../lib/desktop';
import { formatDay } from '../lib/dates';
import { extendDict, useT } from '../lib/i18n';
import { markSeen, parseChangelog, releasesBetween, unseenSince, type ChangelogRelease } from '../lib/changelog';
import { APP_VERSION } from '../lib/version';

extendDict({
  en: {
    'whatsNew.row': "What's new in {version}",
    'whatsNew.title': "What's new",
    'whatsNew.dismiss': 'Dismiss',
    'whatsNew.allReleases': 'All releases',
    'whatsNew.group.features': 'New',
    'whatsNew.group.fixes': 'Fixes',
    'whatsNew.group.breaking': 'Before you upgrade',
    'whatsNew.group.performance': 'Faster',
    'whatsNew.group.reverts': 'Reverted',
  },
  uk: {
    'whatsNew.row': 'Що нового у {version}',
    'whatsNew.title': 'Що нового',
    'whatsNew.dismiss': 'Приховати',
    'whatsNew.allReleases': 'Усі релізи',
    'whatsNew.group.features': 'Нове',
    'whatsNew.group.fixes': 'Виправлення',
    'whatsNew.group.breaking': 'Перед оновленням',
    'whatsNew.group.performance': 'Швидше',
    'whatsNew.group.reverts': 'Скасовано',
  },
});

const RELEASES_URL = 'https://github.com/romirom11/ordi/releases';

/** release-please's section titles, mapped to the app's own words. */
const GROUP_KEYS: Record<string, string> = {
  features: 'whatsNew.group.features',
  fixes: 'whatsNew.group.fixes',
  'bug fixes': 'whatsNew.group.fixes',
  '⚠ breaking changes': 'whatsNew.group.breaking',
  'breaking changes': 'whatsNew.group.breaking',
  performance: 'whatsNew.group.performance',
  'performance improvements': 'whatsNew.group.performance',
  reverts: 'whatsNew.group.reverts',
};

function groupTitle(title: string, t: (key: string) => string): string {
  const key = GROUP_KEYS[title.toLowerCase()];
  return key ? t(key) : title;
}

function store(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function WhatsNew() {
  const t = useT();
  const [releases, setReleases] = useState<ChangelogRelease[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const s = store();
    const since = s ? unseenSince(APP_VERSION, s) : null;
    if (!since) return;
    let cancelled = false;
    // The notes are a separate chunk, fetched only when there is news.
    void import('virtual:changelog').then(({ default: markdown }) => {
      if (cancelled) return;
      const unseen = releasesBetween(parseChangelog(markdown), since, APP_VERSION);
      // Nothing written for these versions: nothing to announce.
      if (unseen.length) setReleases(unseen);
      else markSeen(APP_VERSION, s!);
    }).catch(() => { /* a stale chunk after a deploy: try again next load */ });
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    const s = store();
    if (s) markSeen(APP_VERSION, s);
    setReleases([]);
  };

  if (!releases.length) return null;

  return (
    <>
      <div className={cn(rowCls('info'), 'group/new pr-1')}>
        <button type="button" onClick={() => setOpen(true)} className="flex min-w-0 flex-1 items-center gap-2.5">
          <Sparkles size={16} className="shrink-0" />
          <span className="flex-1 truncate text-left">{t('whatsNew.row').replace('{version}', `v${APP_VERSION}`)}</span>
        </button>
        <button
          type="button"
          aria-label={t('whatsNew.dismiss')}
          onClick={dismiss}
          className="grid h-5 w-5 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-black/10 focus-visible:opacity-100 group-hover/new:opacity-100 dark:hover:bg-white/10"
        >
          <X size={13} />
        </button>
      </div>
      <Dialog open={open} onClose={() => { setOpen(false); dismiss(); }} title={t('whatsNew.title')} width={600}>
        <div className="max-h-[70vh] space-y-6 overflow-y-auto px-5 pb-5 pt-1">
          {releases.map((r) => (
            <section key={r.version}>
              <h3 className="flex items-baseline gap-2 text-[15px] font-semibold">
                v{r.version}
                {r.date && <span className="text-[12px] font-normal text-faint">{formatDay(r.date)}</span>}
              </h3>
              {r.groups.map((g, gi) => (
                <div key={gi} className="mt-3">
                  {g.title && (
                    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                      {groupTitle(g.title, t)}
                    </h4>
                  )}
                  <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-muted-foreground marker:text-faint">
                    {g.items.map((item, ii) => (
                      <li key={ii}>
                        <Inline text={item.text} />
                        {item.children.length > 0 && (
                          <ul className="mt-1 list-[circle] space-y-1 pl-5">
                            {item.children.map((c, ci) => <li key={ci}><Inline text={c} /></li>)}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
          <button type="button" onClick={() => openExternal(RELEASES_URL)} className="text-[13px] font-medium text-primary hover:underline">
            {t('whatsNew.allReleases')}
          </button>
        </div>
      </Dialog>
    </>
  );
}

/**
 * The inline Markdown the CHANGELOG uses – **bold**, `code` and
 * [links](https://…) – as React nodes. No HTML is ever injected.
 */
export function Inline({ text }: { text: string }): ReactNode {
  return <>{renderInline(text)}</>;
}

const TOKEN = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = out.length;
    if (m[1] !== undefined) {
      out.push(<strong key={key} className="font-semibold text-foreground">{renderInline(m[1])}</strong>);
    } else if (m[2] !== undefined) {
      out.push(<code key={key} className="rounded bg-muted px-1 py-px font-mono text-[12px]">{m[2]}</code>);
    } else {
      const href = m[4] ?? '';
      out.push(
        <a
          key={key}
          href={href}
          onClick={(e) => { e.preventDefault(); openExternal(href); }}
          className="text-primary hover:underline"
        >
          {m[3]}
        </a>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((n, i) => (typeof n === 'string' ? <Fragment key={`t${i}`}>{n}</Fragment> : n));
}
