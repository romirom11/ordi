/**
 * RBAC matrix for employee field groups: rows are groups, columns are roles
 * plus the dynamic 'self' principal (the person the record is about). A cell
 * cycles none → read (→ write for 'self'). Roles holding people.write are HR –
 * they implicitly have full access, so their cells are fixed.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Pencil, Minus, Lock } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT, extendDict } from '../../lib/i18n';
import { Skeleton, Tooltip, cn } from '../ui';
import { toast } from '../overlays';
import { useFieldGroups } from '../people/EmployeeFieldGroups';

extendDict({
  en: {
    'fgroups.title': 'Employee field groups',
    'fgroups.desc': 'Who sees which group of employee fields. “Self” is the person the record is about – groups they can edit become their HR questionnaire.',
    'fgroups.self': 'Self',
    'fgroups.none': 'No access',
    'fgroups.read': 'Can view',
    'fgroups.write': 'Can edit',
    'fgroups.hrFull': 'Roles with people.write always see and edit every group.',
    'fgroups.empty': 'No field groups yet – create them in Settings → Custom fields (employees).',
    'fgroups.saveFailed': 'Could not save access.',
  },
  uk: {
    'fgroups.title': 'Групи полів співробітника',
    'fgroups.desc': 'Хто бачить яку групу полів співробітника. «Сам співробітник» – людина, про яку запис; групи, які вона може редагувати, стають її HR-анкетою.',
    'fgroups.self': 'Сам співробітник',
    'fgroups.none': 'Немає доступу',
    'fgroups.read': 'Бачить',
    'fgroups.write': 'Редагує',
    'fgroups.hrFull': 'Ролі з правом people.write завжди бачать і редагують усі групи.',
    'fgroups.empty': 'Ще немає груп полів – створіть їх у Налаштування → Кастомні поля (employees).',
    'fgroups.saveFailed': 'Не вдалося зберегти доступ.',
  },
});

type Level = 'read' | 'write';
interface Grant { principal: string; level: Level }
export interface MatrixRole { id: string; name: string; permissions?: string[] | null }

function useAllGrants(groupIds: string[]) {
  return useQuery({
    queryKey: ['fieldGroupGrants', groupIds],
    enabled: groupIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(groupIds.map(async (id) => {
        const r = await api.get<{ data: Grant[] }>(`/custom-field-groups/${id}/grants`);
        return [id, r.data] as const;
      }));
      return Object.fromEntries(entries) as Record<string, Grant[]>;
    },
  });
}

export function FieldGroupMatrix({ roles }: { roles: MatrixRole[] }) {
  const t = useT();
  const qc = useQueryClient();
  const groupsQ = useFieldGroups('employees');
  const groups = groupsQ.data ?? [];
  const grantsQ = useAllGrants(groups.map((g) => g.id));

  // groupId → principal → level; seeded from the server, edited optimistically.
  const [draft, setDraft] = useState<Record<string, Record<string, Level>>>({});
  const levelOf = (groupId: string, principal: string): Level | null => {
    const local = draft[groupId]?.[principal];
    if (local !== undefined) return local === ('none' as unknown as Level) ? null : local;
    const stored = grantsQ.data?.[groupId]?.find((g) => g.principal === principal)?.level;
    return stored ?? null;
  };

  const save = useMutation({
    mutationFn: ({ groupId, grants }: { groupId: string; grants: Grant[] }) =>
      api.put(`/custom-field-groups/${groupId}/grants`, { grants }),
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['fieldGroupGrants'] });
      setDraft({});
      toast.error(e instanceof ApiError ? e.message : t('fgroups.saveFailed'));
    },
  });

  const cycle = (groupId: string, principal: string, allowWrite: boolean) => {
    const cur = levelOf(groupId, principal);
    const next: Level | null = cur === null ? 'read' : cur === 'read' && allowWrite ? 'write' : null;
    setDraft((prev) => ({
      ...prev,
      [groupId]: { ...(prev[groupId] ?? {}), [principal]: (next ?? ('none' as unknown as Level)) },
    }));
    // Recompute the group's full grant row from stored + draft state.
    const principals = ['self', ...roles.map((r) => `role:${r.id}`)];
    const grants: Grant[] = [];
    for (const p of principals) {
      const lvl = p === principal ? next : levelOf(groupId, p);
      if (lvl) grants.push({ principal: p, level: lvl });
    }
    save.mutate({ groupId, grants });
  };

  if (groupsQ.isLoading) return <Skeleton className="mt-8 h-24 w-full" />;
  if (groups.length === 0) return null;

  const cellFor = (groupId: string, principal: string, allowWrite: boolean, locked: boolean) => {
    const level = locked ? 'write' : levelOf(groupId, principal);
    const label = locked ? t('fgroups.hrFull')
      : level === 'write' ? t('fgroups.write') : level === 'read' ? t('fgroups.read') : t('fgroups.none');
    const icon = level === 'write' ? <Pencil size={13} /> : level === 'read' ? <Eye size={13} /> : <Minus size={13} />;
    return (
      <Tooltip label={label}>
        <button
          type="button"
          disabled={locked}
          onClick={() => cycle(groupId, principal, allowWrite)}
          className={cn(
            'mx-auto grid h-7 w-7 place-items-center rounded-md border transition-colors duration-150',
            locked
              ? 'cursor-default border-transparent text-faint'
              : level
                ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                : 'border-border text-faint hover:bg-muted hover:text-muted-foreground',
          )}
        >
          {locked ? <Lock size={12} /> : icon}
        </button>
      </Tooltip>
    );
  };

  return (
    <div className="mt-10">
      <h3 className="text-sm font-semibold">{t('fgroups.title')}</h3>
      <p className="mb-3 mt-1 max-w-2xl text-xs text-muted-foreground">{t('fgroups.desc')} {t('fgroups.hrFull')}</p>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground" />
              <th className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">{t('fgroups.self')}</th>
              {roles.map((r) => (
                <th key={r.id} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">{r.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) => (
              <tr key={g.id} className={cn(i > 0 && 'border-t border-border')}>
                <td className="px-3 py-1.5 font-medium">{g.name}</td>
                <td className="px-2 py-1.5 text-center">{cellFor(g.id, 'self', true, false)}</td>
                {roles.map((r) => {
                  const hr = (r.permissions ?? []).includes('people.write');
                  return <td key={r.id} className="px-2 py-1.5 text-center">{cellFor(g.id, `role:${r.id}`, false, hr)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
