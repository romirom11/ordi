/**
 * Mention suggestion plumbing for the Tiptap editor (PRD §9.3, §8.3).
 *
 * Users are fetched once from GET /users/lookup (public directory fields for any
 * authenticated user, cached module-wide). On error we silently fall back to an
 * empty list, which disables the mention dropdown without breaking typing "@".
 *
 * Selected mentions are stored with tiptap's default node shape
 * `{ type: 'mention', attrs: { id, label } }` so the API's mention extractor
 * picks up `attrs.id`.
 */
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import type { MentionNodeAttrs } from '@tiptap/extension-mention';
import { api } from '../../lib/api';

export interface MentionUser {
  id: string;
  label: string;
}

interface ApiUser {
  id: string;
  name?: string | null;
  email?: string | null;
  isActive?: boolean;
}

let usersPromise: Promise<MentionUser[]> | null = null;

function fetchUsers(): Promise<MentionUser[]> {
  if (!usersPromise) {
    usersPromise = api
      .get<{ data: ApiUser[] }>('/users/lookup')
      .then((res) =>
        (res.data ?? [])
          .filter((u) => u.isActive !== false)
          .map((u) => ({ id: u.id, label: u.name || u.email || u.id })),
      )
      .catch(() => {
        // network error: mentions silently disabled.
        return [];
      });
  }
  return usersPromise;
}

type MentionSuggestion = Omit<SuggestionOptions<MentionUser, MentionNodeAttrs>, 'editor'>;

/** Minimal floating dropdown positioned from the suggestion clientRect. No tippy. */
class MentionDropdown {
  private el: HTMLDivElement;
  private items: MentionUser[] = [];
  private selected = 0;
  private props: SuggestionProps<MentionUser, MentionNodeAttrs>;

  constructor(props: SuggestionProps<MentionUser, MentionNodeAttrs>) {
    this.props = props;
    this.el = document.createElement('div');
    this.el.className = 'ordi-mention-dropdown';
    document.body.appendChild(this.el);
    this.update(props);
  }

  update(props: SuggestionProps<MentionUser, MentionNodeAttrs>): void {
    this.props = props;
    this.items = props.items ?? [];
    if (this.selected >= this.items.length) this.selected = 0;
    this.renderItems();
    this.position();
  }

  private position(): void {
    const rect = this.props.clientRect?.();
    if (!rect || this.items.length === 0) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = 'block';
    const width = this.el.offsetWidth || 160;
    const height = this.el.offsetHeight || 40;
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private renderItems(): void {
    this.el.innerHTML = '';
    this.items.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ordi-mention-item' + (index === this.selected ? ' is-selected' : '');
      btn.textContent = item.label;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.choose(index);
      });
      this.el.appendChild(btn);
    });
  }

  private choose(index: number): void {
    const item = this.items[index];
    if (item) this.props.command({ id: item.id, label: item.label });
  }

  onKeyDown({ event }: SuggestionKeyDownProps): boolean {
    if (this.items.length === 0) return false;
    if (event.key === 'ArrowDown') {
      this.selected = (this.selected + 1) % this.items.length;
      this.renderItems();
      return true;
    }
    if (event.key === 'ArrowUp') {
      this.selected = (this.selected - 1 + this.items.length) % this.items.length;
      this.renderItems();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      this.choose(this.selected);
      return true;
    }
    if (event.key === 'Escape') {
      this.destroy();
      return true;
    }
    return false;
  }

  destroy(): void {
    this.el.remove();
  }
}

export const mentionSuggestion: MentionSuggestion = {
  char: '@',
  items: async ({ query }): Promise<MentionUser[]> => {
    const users = await fetchUsers();
    const q = query.trim().toLowerCase();
    const matched = q ? users.filter((u) => u.label.toLowerCase().includes(q)) : users;
    return matched.slice(0, 8);
  },
  render: () => {
    let dropdown: MentionDropdown | null = null;
    return {
      onStart: (props) => {
        dropdown = new MentionDropdown(props);
      },
      onUpdate: (props) => {
        dropdown?.update(props);
      },
      onKeyDown: (props) => dropdown?.onKeyDown(props) ?? false,
      onExit: () => {
        dropdown?.destroy();
        dropdown = null;
      },
    };
  },
};
