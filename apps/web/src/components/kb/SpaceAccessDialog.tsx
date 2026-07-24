import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import {
  Avatar, Select, SegmentedControl, Skeleton, Spinner, EmptyState, cn,
} from '../ui';
import { Dialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { Globe, Lock, X, UserPlus, Users } from 'lucide-react';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'kb.access': 'Access',
    'kb.spaceAccess': 'Space access',
    'kb.visWorkspace': 'Workspace',
    'kb.visPrivate': 'Private',
    'kb.visWorkspaceHint': 'Everyone in the workspace can see this space and its pages.',
    'kb.visPrivateHint': 'Only members can see this space and all of its pages.',
    'kb.inherited': 'Access is inherited by every page in the space.',
    'kb.members': 'Members',
    'kb.addMember': 'Add member',
    'kb.roleEditor': 'Editor',
    'kb.roleViewer': 'Viewer',
    'kb.noMembers': 'No members yet',
    'kb.noMembersHint': 'Add people to give them access to this private space.',
    'kb.removeMember': 'Remove',
    'kb.everyoneHasAccess': 'Everyone in the workspace has access — no member list needed.',
    'kb.accessFailed': 'Could not update space access',
    'kb.visibilityChanged': 'Access updated',
    'kb.memberAdded': 'Member added',
    'kb.memberRemoved': 'Member removed',
    'kb.accessConflict': 'This space changed elsewhere — refreshed with the latest version',
  },
  uk: {
    'kb.access': 'Доступ',
    'kb.spaceAccess': 'Доступ до простору',
    'kb.visWorkspace': 'Робочий простір',
    'kb.visPrivate': 'Приватний',
    'kb.visWorkspaceHint': 'Усі в робочому просторі бачать цей простір і його сторінки.',
    'kb.visPrivateHint': 'Приватний — лише учасники бачать цей простір і всі його сторінки.',
    'kb.inherited': 'Доступ успадковується всіма сторінками простору.',
    'kb.members': 'Учасники',
    'kb.addMember': 'Додати учасника',
    'kb.roleEditor': 'Редактор',
    'kb.roleViewer': 'Читач',
    'kb.noMembers': 'Ще немає учасників',
    'kb.noMembersHint': 'Додайте людей, щоб надати їм доступ до цього приватного простору.',
    'kb.removeMember': 'Прибрати',
    'kb.everyoneHasAccess': 'Усі в робочому просторі мають доступ — список учасників не потрібен.',
    'kb.accessFailed': 'Не вдалося оновити доступ до простору',
    'kb.visibilityChanged': 'Доступ оновлено',
    'kb.memberAdded': 'Учасника додано',
    'kb.memberRemoved': 'Учасника прибрано',
    'kb.accessConflict': 'Простір змінили деінде — оновлено до останньої версії',
  },
});

export interface AccessSpace { id: string; name: string; visibility?: string; version?: number }
interface Member { userId: string; role: 'editor' | 'viewer'; name: string; email: string; avatar?: string | null }
interface LookupUser { id: string; name: string; avatar?: string | null }

export function SpaceAccessDialog({ space, open, onClose }: { space: AccessSpace; open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const visibility = (space.visibility ?? 'workspace') as 'workspace' | 'private';
  const isPrivate = visibility === 'private';

  const members = useQuery({
    queryKey: ['spaceMembers', space.id],
    queryFn: () => api.get<{ data: Member[] }>(`/spaces/${space.id}/members`),
    enabled: open,
  });
  const lookup = useQuery({
    queryKey: ['usersLookup'],
    queryFn: () => api.get<{ data: LookupUser[] }>('/users/lookup'),
    enabled: open,
  });

  const memberRows = members.data?.data ?? [];
  const memberIds = useMemo(() => new Set(memberRows.map((m) => m.userId)), [memberRows]);
  const addable = (lookup.data?.data ?? []).filter((u) => !memberIds.has(u.id));

  const conflict = (e: unknown) => {
    if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
      qc.invalidateQueries({ queryKey: ['spaces'] });
      toast.error(t('kb.accessConflict'));
      return true;
    }
    return false;
  };

  const setVisibility = useMutation({
    mutationFn: (next: 'workspace' | 'private') =>
      api.patch(`/spaces/${space.id}`, { visibility: next, version: space.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaces'] });
      toast(t('kb.visibilityChanged'));
    },
    onError: (e) => { if (!conflict(e)) toast.error(t('kb.accessFailed')); },
  });

  const addMember = useMutation({
    mutationFn: (vars: { userId: string; role: 'editor' | 'viewer' }) =>
      api.post(`/spaces/${space.id}/members`, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaceMembers', space.id] });
      toast(t('kb.memberAdded'));
    },
    onError: () => toast.error(t('kb.accessFailed')),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.del(`/spaces/${space.id}/members/${userId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spaceMembers', space.id] });
      toast(t('kb.memberRemoved'));
    },
    onError: () => toast.error(t('kb.accessFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} width={460} title={
      <span className="flex items-center gap-2">
        {isPrivate ? <Lock size={15} className="text-warning" /> : <Globe size={15} className="text-muted-foreground" />}
        <span className="truncate">{t('kb.spaceAccess')}</span>
      </span>
    }>
      <div className="space-y-4 px-4 pb-4 pt-1 text-[13px]">
        {/* Visibility */}
        <div className="space-y-2">
          <SegmentedControl
            className="w-full"
            options={[
              { key: 'workspace', label: t('kb.visWorkspace'), icon: <Globe size={13} /> },
              { key: 'private', label: t('kb.visPrivate'), icon: <Lock size={13} /> },
            ]}
            value={visibility}
            onChange={(v) => { if (v !== visibility && !setVisibility.isPending) setVisibility.mutate(v as 'workspace' | 'private'); }}
          />
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {setVisibility.isPending && <Spinner />}
            <span>{isPrivate ? t('kb.visPrivateHint') : t('kb.visWorkspaceHint')}</span>
          </div>
          <p className="text-xs text-faint">{t('kb.inherited')}</p>
        </div>

        {/* Members */}
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">{t('kb.members')}</span>
            <DropdownMenu
              align="end"
              width={220}
              trigger={
                <button
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50"
                  disabled={addable.length === 0}
                >
                  <UserPlus size={13} /> {t('kb.addMember')}
                </button>
              }
            >
              {addable.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-faint">{t('common.nothingYet')}</div>
              ) : addable.map((u) => (
                <MenuItem
                  key={u.id}
                  icon={<Avatar name={u.name} src={u.avatar} size={18} />}
                  onSelect={() => addMember.mutate({ userId: u.id, role: 'editor' })}
                >
                  {u.name}
                </MenuItem>
              ))}
            </DropdownMenu>
          </div>

          {!isPrivate ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              {t('kb.everyoneHasAccess')}
            </p>
          ) : members.isLoading ? (
            <div className="space-y-1.5">
              <Skeleton className="h-9" /><Skeleton className="h-9" />
            </div>
          ) : memberRows.length === 0 ? (
            <EmptyState icon={<Users size={18} />} title={t('kb.noMembers')} hint={t('kb.noMembersHint')} />
          ) : (
            <div className="space-y-0.5">
              {memberRows.map((m) => (
                <div key={m.userId} className="group flex items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors duration-150 hover:bg-muted/60">
                  <Avatar name={m.name} src={m.avatar} size={26} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{m.name}</div>
                    <div className="truncate text-xs text-faint">{m.email}</div>
                  </div>
                  <Select
                    className="h-7"
                    value={m.role}
                    onChange={(e) => addMember.mutate({ userId: m.userId, role: e.target.value as 'editor' | 'viewer' })}
                  >
                    <option value="editor">{t('kb.roleEditor')}</option>
                    <option value="viewer">{t('kb.roleViewer')}</option>
                  </Select>
                  <button
                    title={t('kb.removeMember')}
                    onClick={() => removeMember.mutate(m.userId)}
                    disabled={removeMember.isPending}
                    className={cn(
                      'shrink-0 rounded-md p-1.5 text-faint transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive',
                      'opacity-0 group-hover:opacity-100',
                    )}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
