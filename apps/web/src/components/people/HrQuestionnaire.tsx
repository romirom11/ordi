/**
 * The HR questionnaire on the profile page: the field groups granted to the
 * 'self' principal, filled in by the person about themselves. Nothing here is
 * hardcoded – HR shapes the questionnaire by creating employee field groups
 * and granting 'self' access in the RBAC matrix. The card hides itself when
 * the account has no employee record or nothing is self-accessible.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT, extendDict } from '../../lib/i18n';
import { Badge, Card, fmtDate } from '../ui';
import { toast } from '../overlays';
import { CustomFieldsGrid, fieldValueIsEmpty, type FieldDef } from '../crm/CustomFieldsSection';

extendDict({
  en: {
    'profile.hrQuestionnaire': 'HR questionnaire',
    'profile.hrQuestionnaireHint': 'These answers are visible to HR on your employee card.',
    'profile.hrqEmpty': 'Not filled in',
    'profile.hrqPartial': 'Partially filled',
    'profile.hrqComplete': 'Filled in',
    'profile.hrqUpdated': 'Updated {date}',
    'profile.hrqSaveFailed': 'Could not save the answer.',
  },
  uk: {
    'profile.hrQuestionnaire': 'HR-анкета',
    'profile.hrQuestionnaireHint': 'Ці відповіді бачить HR у вашій картці співробітника.',
    'profile.hrqEmpty': 'Не заповнена',
    'profile.hrqPartial': 'Частково заповнена',
    'profile.hrqComplete': 'Заповнена',
    'profile.hrqUpdated': 'Оновлено {date}',
    'profile.hrqSaveFailed': 'Не вдалося зберегти відповідь.',
  },
});

interface HrField extends FieldDef { value: unknown; required?: boolean }
interface HrGroup { id: string; name: string; level: 'read' | 'write'; fields: HrField[] }
interface HrFieldsResponse { linked: boolean; updatedAt?: string | null; groups: HrGroup[] }

export function HrQuestionnaireCard() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['myHrFields'], queryFn: () => api.get<HrFieldsResponse>('/me/hr-fields') });

  const save = useMutation({
    mutationFn: (customFields: Record<string, unknown>) => api.patch('/me/hr-fields', { customFields }),
    onSuccess: (data) => qc.setQueryData(['myHrFields'], data),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('profile.hrqSaveFailed')),
  });

  const data = q.data;
  if (!data?.linked || !data.groups.length) return null;

  const allFields = data.groups.flatMap((g) => g.fields);
  const filled = allFields.filter((f) => !fieldValueIsEmpty(f.value)).length;
  const statusKey = filled === 0 ? 'profile.hrqEmpty' : filled === allFields.length ? 'profile.hrqComplete' : 'profile.hrqPartial';
  const statusClass = filled === 0
    ? 'bg-muted text-muted-foreground'
    : filled === allFields.length ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning';

  return (
    <Card className="p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ClipboardList size={15} className="text-faint" /> {t('profile.hrQuestionnaire')}
        </div>
        <Badge className={statusClass}>{t(statusKey)} · {filled}/{allFields.length}</Badge>
        {data.updatedAt && (
          <span className="text-xs text-faint">{t('profile.hrqUpdated').replace('{date}', fmtDate(data.updatedAt))}</span>
        )}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{t('profile.hrQuestionnaireHint')}</p>
      <div className="space-y-5">
        {data.groups.map((g) => (
          <div key={g.id}>
            {data.groups.length > 1 && (
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{g.name}</div>
            )}
            <CustomFieldsGrid
              defs={g.fields}
              values={Object.fromEntries(g.fields.map((f) => [f.key, f.value]))}
              editable={g.level === 'write'}
              onSave={(cf) => save.mutate(cf)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
