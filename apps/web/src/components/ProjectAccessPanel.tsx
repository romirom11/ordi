/**
 * Per-project access management: visibility (workspace/private) + members with
 * roles. Self-contained — runs its own queries and mutations. Embedded in the
 * project settings tab; renders read-only for non-managers.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, Lock, Plus, Trash2, Users as UsersIcon } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useUsersLookup } from '../lib/queries';
import { useT, extendDict } from '../lib/i18n';
import { Avatar, Badge, Button, IconButton, SegmentedControl, Select, Skeleton, Spinner, Switch, cn } from './ui';
import { ConfirmDialog, DropdownMenu, MenuItem, MenuLabel, toast } from './overlays';
import { AnimatedRow } from './settings/primitives';

extendDict({
  en: {
    'access.title': 'Access',
    'access.visibility': 'Visibility',
    'access.workspace': 'Workspace',
    'access.private': 'Private',
    'access.workspaceHint': 'Everyone in the workspace can see this project.',
    'access.privateHint': 'Only added members can see this project.',
    'access.members': 'Members',
    'access.addMember': 'Add member',
    'access.roleAdmin': 'Admin',
    'access.roleMember': 'Member',
    'access.roleViewer': 'Viewer',
    'access.canEditTasks': 'Can edit tasks',
    'access.removeMember': 'Remove member',
    'access.removeConfirm': 'Remove this member from the project?',
    'access.noMembers': 'No members yet',
    'access.everyoneElse': 'Everyone already has access',
    'access.updated': 'Access updated',
    'access.readOnly': 'You have read-only access to project settings.',
    'access.saveFailed': 'Could not save changes',
    'access.conflict': 'Someone else made changes — reloaded latest.',
  },
  uk: {
    'access.title': 'Доступ',
    'access.visibility': 'Видимість',
    'access.workspace': 'Робочий простір',
    'access.private': 'Приватний',
    'access.workspaceHint': 'Усі в робочому просторі бачать цей проєкт.',
    'access.privateHint': 'Лише додані учасники бачать цей проєкт.',
    'access.members': 'Учасники',
    'access.addMember': 'Додати учасника',
    'access.roleAdmin': 'Адмін',
    'access.roleMember': 'Учасник',
    'access.roleViewer': 'Спостерігач',
    'access.canEditTasks': 'Може редагувати задачі',
    'access.removeMember': 'Видалити учасника',
    'access.removeConfirm': 'Видалити цього учасника з проєкту?',
    'access.noMembers': 'Ще немає учасників',
    'access.everyoneElse': 'Усі вже мають доступ',
    'access.updated': 'Доступ оновлено',
    'access.readOnly': 'Ви маєте доступ лише для читання до налаштувань проєкту.',
    'access.saveFailed': 'Не вдалося зберегти зміни',
    'access.conflict': 'Хтось інший вніс зміни — завантажено найновіше.',
  },
});

type MemberRole = 'admin' | 'member' | 'viewer';
interface Member { projectId: string; userId: string; role: MemberRole; canWriteTasks: boolean }
interface ProjectDetail { id: string; visibility: 'workspace' | 'private'; version: number }
interface LookupUser { id: string; name?: string | null; avatar?: string | null }

export function ProjectAccessPanel({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const qc = useQueryClient();

  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => api.get<ProjectDetail>(`/projects/${projectId}`) });
  const members = useQuery({ queryKey: ['project-members', projectId], queryFn: () => api.get<{ data: Member[] }>(`/projects/${projectId}/members`) });
  const lookup = useUsersLookup();

  const userById = useMemo(() => {
    const m = new Map<string, LookupUser>();
    for (const u of lookup.data ?? []) m.set(u.id, u);
    return m;
  }, [lookup.data]);

  const setVisibility = useMutation({
    mutationFn: (visibility: 'workspace' | 'private') =>
      api.patch<ProjectDetail>(`/projects/${projectId}`, { visibility, version: project.data?.version }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project', projectId] }); toast(t('access.updated')); },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      toast.error(e instanceof ApiError && e.status === 409 ? t('access.conflict') : t('access.saveFailed'));
    },
  });

  const upsertMember = useMutation({
    mutationFn: (m: { userId: string; role: MemberRole; canWriteTasks: boolean }) =>
      api.post(`/projects/${projectId}/members`, m),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-members', projectId] }),
    onError: () => toast.error(t('access.saveFailed')),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.del(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project-members', projectId] }); toast(t('access.updated')); },
    onError: () => toast.error(t('access.saveFailed')),
  });

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const memberList = members.data?.data ?? [];
  const memberIds = new Set(memberList.map((m) => m.userId));
  const addable = (lookup.data ?? []).filter((u) => !memberIds.has(u.id));
  const visibility = project.data?.visibility ?? 'workspace';

  const roleOptions: { key: MemberRole; label: string }[] = [
    { key: 'admin', label: t('access.roleAdmin') },
    { key: 'member', label: t('access.roleMember') },
    { key: 'viewer', label: t('access.roleViewer') },
  ];

  return (
    <div className="space-y-8">
      {/* Visibility */}
      <section>
        <h3 className="mb-1 text-[13px] font-semibold">{t('access.visibility')}</h3>
        {project.isLoading ? (
          <Skeleton className="h-9 w-56" />
        ) : (
          <>
            <SegmentedControl<'workspace' | 'private'>
              value={visibility}
              onChange={(v) => { if (canManage && v !== visibility) setVisibility.mutate(v); }}
              className={cn('h-8', !canManage && 'pointer-events-none opacity-70')}
              options={[
                { key: 'workspace', label: t('access.workspace'), icon: <Globe size={13} /> },
                { key: 'private', label: t('access.private'), icon: <Lock size={13} /> },
              ]}
            />
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              {setVisibility.isPending && <Spinner className="h-3 w-3" />}
              {visibility === 'workspace' ? t('access.workspaceHint') : t('access.privateHint')}
            </p>
          </>
        )}
      </section>

      {/* Members */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">{t('access.members')}</h3>
          {canManage && (
            <DropdownMenu
              align="end"
              width={220}
              trigger={<Button size="xs" variant="outline" disabled={addable.length === 0}><Plus size={13} /> {t('access.addMember')}</Button>}
            >
              {addable.length === 0 ? (
                <MenuLabel>{t('access.everyoneElse')}</MenuLabel>
              ) : (
                addable.map((u) => (
                  <MenuItem key={u.id} icon={<Avatar name={u.name} src={u.avatar} size={18} />}
                    onSelect={() => upsertMember.mutate({ userId: u.id, role: 'member', canWriteTasks: true })}>
                    {u.name ?? u.id}
                  </MenuItem>
                ))
              )}
            </DropdownMenu>
          )}
        </div>

        {members.isLoading ? (
          <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-11 w-full" />)}</div>
        ) : memberList.length === 0 ? (
          <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border py-8 text-center">
            <UsersIcon size={18} className="text-faint" />
            <p className="text-[13px] text-muted-foreground">{t('access.noMembers')}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card">
            {memberList.map((m, i) => {
              const u = userById.get(m.userId);
              return (
                <AnimatedRow key={m.userId} index={i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
                  <Avatar name={u?.name ?? m.userId} src={u?.avatar} size={26} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{u?.name ?? m.userId}</span>

                  {m.role === 'viewer' && (
                    <label className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', !canManage && 'opacity-70')}>
                      {t('access.canEditTasks')}
                      <Switch checked={m.canWriteTasks} disabled={!canManage}
                        onChange={(v) => upsertMember.mutate({ userId: m.userId, role: m.role, canWriteTasks: v })} />
                    </label>
                  )}

                  {canManage ? (
                    <Select
                      value={m.role}
                      onChange={(e) => upsertMember.mutate({ userId: m.userId, role: e.target.value as MemberRole, canWriteTasks: m.canWriteTasks })}
                      className="h-7 w-28 text-xs"
                    >
                      {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </Select>
                  ) : (
                    <Badge>{roleOptions.find((r) => r.key === m.role)?.label ?? m.role}</Badge>
                  )}

                  {canManage && (
                    <IconButton size="sm" title={t('access.removeMember')} onClick={() => setConfirmRemove(m.userId)}>
                      <Trash2 size={14} />
                    </IconButton>
                  )}
                </AnimatedRow>
              );
            })}
          </div>
        )}

        {!canManage && <p className="mt-2 text-xs text-faint">{t('access.readOnly')}</p>}
      </section>

      <ConfirmDialog
        open={confirmRemove != null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => { if (confirmRemove) removeMember.mutate(confirmRemove, { onSettled: () => setConfirmRemove(null) }); }}
        title={t('access.removeMember')}
        body={t('access.removeConfirm')}
        confirmLabel={t('common.delete')}
        danger
        pending={removeMember.isPending}
      />
    </div>
  );
}
