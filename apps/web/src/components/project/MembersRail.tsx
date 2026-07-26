/**
 * Members field in the project rail: a short avatar stack that opens a popover
 * where the whole membership is managed in place – add, change role, remove.
 * The full Access panel in project settings stays the long-form version; this
 * exists so the common edits do not cost a trip through the settings tab.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Settings2, Trash2, UserPlus, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { useProjectMembers, useUsersLookup, type ProjectMemberRole } from '../../lib/queries';
import { useT, extendDict } from '../../lib/i18n';
import { Avatar, AvatarGroup, Select, Spinner, cn } from '../ui';
import { DropdownMenu, toast, useMenuClose } from '../overlays';

extendDict({
  en: {
    'members.title': 'Members',
    'members.add': 'Add member',
    'members.search': 'Search people',
    'members.none': 'No members yet',
    'members.everyone': 'Everyone already has access',
    'members.noMatches': 'No one matches',
    'members.remove': 'Remove from project',
    'members.manageAll': 'Open access settings',
    'members.failed': 'Could not update members',
    'members.roleAdmin': 'Admin',
    'members.roleMember': 'Member',
    'members.roleViewer': 'Viewer',
  },
  uk: {
    'members.title': 'Учасники',
    'members.add': 'Додати учасника',
    'members.search': 'Пошук людей',
    'members.none': 'Ще немає учасників',
    'members.everyone': 'Усі вже мають доступ',
    'members.noMatches': 'Нікого не знайдено',
    'members.remove': 'Видалити з проєкту',
    'members.manageAll': 'Відкрити налаштування доступу',
    'members.failed': 'Не вдалося оновити учасників',
    'members.roleAdmin': 'Адмін',
    'members.roleMember': 'Учасник',
    'members.roleViewer': 'Спостерігач',
  },
});

/** Avatars shown before the group collapses into "+N". */
const SHOWN = 3;

export function MembersRailPicker({ projectId, canManage, onManageAll }: {
  projectId: string;
  canManage: boolean;
  onManageAll?: () => void;
}) {
  const t = useT();
  const members = useProjectMembers(projectId);
  const lookup = useUsersLookup();

  const userById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; avatar?: string | null }>();
    for (const u of lookup.data ?? []) m.set(u.id, u);
    return m;
  }, [lookup.data]);

  const list = members.data ?? [];
  const avatars = list.map((m) => userById.get(m.userId) ?? { id: m.userId, name: m.userId });

  const trigger = (
    <span
      title={t('members.title')}
      className={cn(
        'group flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-150',
        'cursor-pointer hover:bg-muted',
        avatars.length === 0 && 'text-faint',
      )}
    >
      {avatars.length > 0 ? (
        <>
          <AvatarGroup users={avatars} size={20} max={SHOWN} />
          <span className="text-xs tabular-nums text-muted-foreground">{avatars.length}</span>
        </>
      ) : (
        <><Users size={15} className="text-faint" /><span>{canManage ? t('members.add') : t('members.none')}</span></>
      )}
    </span>
  );

  return (
    <DropdownMenu trigger={trigger} align="start" width={280} className="w-full">
      <MembersPanel projectId={projectId} canManage={canManage} onManageAll={onManageAll} />
    </DropdownMenu>
  );
}

function MembersPanel({ projectId, canManage, onManageAll }: {
  projectId: string; canManage: boolean; onManageAll?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const closeMenu = useMenuClose();
  const [query, setQuery] = useState('');

  const members = useProjectMembers(projectId);
  const lookup = useUsersLookup();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['project-members', projectId] });
    // Membership decides who sees a private project, so the lists follow.
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const upsert = useMutation({
    mutationFn: (m: { userId: string; role: ProjectMemberRole; canWriteTasks: boolean }) =>
      api.post(`/projects/${projectId}/members`, m),
    onSuccess: invalidate,
    onError: () => toast.error(t('members.failed')),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.del(`/projects/${projectId}/members/${userId}`),
    onSuccess: invalidate,
    onError: () => toast.error(t('members.failed')),
  });

  const list = members.data ?? [];
  const memberIds = new Set(list.map((m) => m.userId));
  const users = lookup.data ?? [];
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const needle = query.trim().toLowerCase();
  const addable = users
    .filter((u) => !memberIds.has(u.id))
    .filter((u) => !needle || u.name.toLowerCase().includes(needle));

  const roleOptions: { key: ProjectMemberRole; label: string }[] = [
    { key: 'admin', label: t('members.roleAdmin') },
    { key: 'member', label: t('members.roleMember') },
    { key: 'viewer', label: t('members.roleViewer') },
  ];

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('members.title')}</span>
        {(upsert.isPending || remove.isPending) && <Spinner className="h-3 w-3" />}
      </div>

      {list.length === 0 ? (
        <p className="px-2 pb-2 text-xs text-faint">{t('members.none')}</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          {list.map((m) => {
            const u = userById.get(m.userId);
            return (
              <div key={m.userId} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
                <Avatar name={u?.name ?? m.userId} src={u?.avatar} size={20} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{u?.name ?? m.userId}</span>
                {canManage ? (
                  <>
                    <Select
                      value={m.role}
                      onChange={(e) => upsert.mutate({
                        userId: m.userId, role: e.target.value as ProjectMemberRole, canWriteTasks: m.canWriteTasks,
                      })}
                      className="h-6 w-[86px] shrink-0 px-1 text-[11px]"
                    >
                      {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </Select>
                    <button
                      type="button"
                      aria-label={t('members.remove')}
                      title={t('members.remove')}
                      onClick={() => remove.mutate(m.userId)}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                ) : (
                  <span className="shrink-0 text-[11px] text-faint">
                    {roleOptions.find((r) => r.key === m.role)?.label ?? m.role}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canManage && (
        <>
          <div className="mx-1 my-1 h-px bg-border" />
          <div className="relative px-1 pb-1">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('members.search')}
              className="h-7 w-full rounded-md border border-border bg-surface pl-7 pr-2 text-[13px] outline-none placeholder:text-faint focus:border-primary/60"
            />
          </div>
          <div className="max-h-44 overflow-y-auto">
            {addable.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-faint">{needle ? t('members.noMatches') : t('members.everyone')}</p>
            ) : (
              addable.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => upsert.mutate({ userId: u.id, role: 'member', canWriteTasks: true })}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
                >
                  <Avatar name={u.name} src={u.avatar} size={20} />
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <UserPlus size={13} className="shrink-0 text-faint" />
                </button>
              ))
            )}
          </div>
        </>
      )}

      {onManageAll && (
        <>
          <div className="mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => { closeMenu(); onManageAll(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <Settings2 size={13} />
            {t('members.manageAll')}
          </button>
        </>
      )}
    </div>
  );
}
