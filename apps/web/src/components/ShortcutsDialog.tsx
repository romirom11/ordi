/**
 * The keyboard help sheet (⇧?). Rendered entirely from the SHORTCUTS table in
 * lib/shortcuts, so a shortcut can never exist without being documented – and
 * a documented one can never claim keys the handlers don't actually bind.
 */
import { Dialog } from './overlays';
import { Kbd } from './ui';
import { extendDict, useT } from '../lib/i18n';
import { GO_TO, SHORTCUTS, SHORTCUT_GROUPS } from '../lib/shortcuts';

extendDict({
  en: {
    'keys.title': 'Keyboard shortcuts',
    'keys.group.general': 'General',
    'keys.group.tabs': 'Tabs',
    'keys.group.navigation': 'Navigation',
    'keys.group.editor': 'Editor',
    'keys.palette': 'Open the command palette',
    'keys.quickAdd': 'Create a task',
    'keys.stopTimer': 'Stop the running timer',
    'keys.help': 'Show this list',
    'keys.dismiss': 'Close a dialog, menu or popover',
    'keys.newTab': 'New tab',
    'keys.closeTab': 'Close the current tab',
    'keys.reopenTab': 'Reopen the last closed tab',
    'keys.nextTab': 'Next tab',
    'keys.prevTab': 'Previous tab',
    'keys.nthTab': 'Jump to tab 1…8, or the last one',
    'keys.back': 'Back in this tab’s history',
    'keys.forward': 'Forward in this tab’s history',
    'keys.goTo': 'Go to a section – press G, then:',
    'keys.openNewTab': 'Open a row, card or link in a new tab',
    'keys.openNewTabMiddle': 'Same, with the middle mouse button',
    'keys.editorSlash': 'Insert any block – headings, lists, table, callout…',
    'keys.editorMention': 'Mention a person',
    'keys.editorRef': 'Link a task, project, client or page',
    'keys.editorBold': 'Bold',
    'keys.editorItalic': 'Italic',
    'keys.editorUnderline': 'Underline',
    'keys.editorStrike': 'Strikethrough',
    'keys.editorCode': 'Inline code',
    'keys.editorHighlight': 'Highlight',
    'keys.editorLink': 'Add or edit a link',
    'keys.editorHeading': 'Heading 1, 2 or 3',
    'keys.editorSubmit': 'Save / send',
  },
  uk: {
    'keys.title': 'Гарячі клавіші',
    'keys.group.general': 'Загальні',
    'keys.group.tabs': 'Вкладки',
    'keys.group.navigation': 'Навігація',
    'keys.group.editor': 'Редактор',
    'keys.palette': 'Відкрити командну палітру',
    'keys.quickAdd': 'Створити задачу',
    'keys.stopTimer': 'Зупинити таймер',
    'keys.help': 'Показати цей список',
    'keys.dismiss': 'Закрити діалог, меню або поповер',
    'keys.newTab': 'Нова вкладка',
    'keys.closeTab': 'Закрити поточну вкладку',
    'keys.reopenTab': 'Відновити щойно закриту вкладку',
    'keys.nextTab': 'Наступна вкладка',
    'keys.prevTab': 'Попередня вкладка',
    'keys.nthTab': 'Перейти до вкладки 1…8 або до останньої',
    'keys.back': 'Назад в історії вкладки',
    'keys.forward': 'Вперед в історії вкладки',
    'keys.goTo': 'Перейти до розділу – натисніть G, потім:',
    'keys.openNewTab': 'Відкрити рядок, картку або посилання в новій вкладці',
    'keys.openNewTabMiddle': 'Те саме середньою кнопкою миші',
    'keys.editorSlash': 'Вставити будь-який блок – заголовки, списки, таблиця, виноска…',
    'keys.editorMention': 'Згадати людину',
    'keys.editorRef': 'Послатися на задачу, проєкт, клієнта або сторінку',
    'keys.editorBold': 'Жирний',
    'keys.editorItalic': 'Курсив',
    'keys.editorUnderline': 'Підкреслений',
    'keys.editorStrike': 'Перекреслений',
    'keys.editorCode': 'Код у рядку',
    'keys.editorHighlight': 'Виділення кольором',
    'keys.editorLink': 'Додати або змінити посилання',
    'keys.editorHeading': 'Заголовок 1, 2 або 3',
    'keys.editorSubmit': 'Зберегти / надіслати',
  },
});

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (k === 'then' || k === '→'
        ? <span key={i} className="text-[11px] text-faint">{k === 'then' ? '→' : k}</span>
        : <Kbd key={i}>{k}</Kbd>))}
    </span>
  );
}

function Row({ label, keys }: { label: string; keys: readonly string[] }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="min-w-0 text-[13px] text-muted-foreground">{label}</span>
      <Keys keys={keys} />
    </div>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const groups = SHORTCUT_GROUPS.map((g) => ({
    key: g,
    items: SHORTCUTS.filter((s) => s.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onClose={onClose} title={t('keys.title')} width={720}>
      <div className="max-h-[70vh] overflow-y-auto px-4 pb-4 pt-1">
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {groups.map(({ key, items }) => (
            <section key={key}>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t(`keys.group.${key}`)}
              </h3>
              <div className="divide-y divide-border/60">
                {items.map((s) => <Row key={s.id} label={t(s.labelKey)} keys={s.keys} />)}
              </div>
              {/* The G chord's destinations are data, so print them inline
                  rather than inventing a row per section. */}
              {key === 'navigation' && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {GO_TO.map((d) => (
                    <span key={d.key} className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      <Kbd>{d.key.toUpperCase()}</Kbd> {t(d.labelKey)}
                    </span>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
