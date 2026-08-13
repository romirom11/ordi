/**
 * Grouped custom fields on the employee card. Ungrouped fields keep the plain
 * "Custom fields" card; each field group the server let this viewer see
 * (employee.fieldAccess) renders as its own section, read-only unless the
 * access level says write. The questionnaire's last-update date shows beside
 * the groups the person filled in themselves.
 */
import { SlidersHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useT, extendDict } from '../../lib/i18n';
import { Card, fmtDate } from '../ui';
import {
  CustomFieldsGrid, fieldValueIsEmpty, useFieldDefs, type FieldDef,
} from '../crm/CustomFieldsSection';
import { SectionHeader } from '../crm/detail';

extendDict({
  en: {
    'people.fieldsUpdatedBySelf': 'Self-service answers last updated {date}',
  },
  uk: {
    'people.fieldsUpdatedBySelf': 'Самостійно заповнені поля оновлено {date}',
  },
});

export interface FieldGroupLite { id: string; name: string; position: number }

export function useFieldGroups(entityType: string) {
  return useQuery<FieldGroupLite[]>({
    queryKey: ['fieldGroups', entityType],
    queryFn: () => api.get<{ data: FieldGroupLite[] }>(`/custom-field-groups?entityType=${entityType}`).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function EmployeeFieldGroups({ values, fieldAccess, canWrite, questionnaireUpdatedAt, onSave }: {
  values?: Record<string, unknown>;
  /** groupId → 'read' | 'write', as computed by the server for this viewer. */
  fieldAccess?: Record<string, 'read' | 'write'>;
  canWrite: boolean;
  questionnaireUpdatedAt?: string | null;
  onSave: (customFields: Record<string, unknown>) => void;
}) {
  const t = useT();
  const groupsQ = useFieldGroups('employees');
  const defsQ = useFieldDefs('employees');
  const defs = (defsQ.data ?? []).filter((f) => !f.deprecated);
  const access = fieldAccess ?? {};

  const visibleGroups = (groupsQ.data ?? [])
    .filter((g) => access[g.id])
    .map((g) => ({
      ...g,
      level: access[g.id]!,
      fields: defs.filter((f) => f.groupId === g.id),
    }))
    .filter((g) => g.fields.length > 0);

  if (visibleGroups.length === 0) return null;

  return (
    <section className="mb-6 space-y-5">
      {visibleGroups.map((g) => {
        const editable = canWrite && g.level === 'write';
        const shown = g.fields.filter((f: FieldDef) => editable || !fieldValueIsEmpty((values ?? {})[f.key]));
        if (shown.length === 0) return null;
        return (
          <div key={g.id}>
            <SectionHeader icon={<SlidersHorizontal size={15} />} title={g.name} />
            <Card className="p-4">
              <CustomFieldsGrid defs={shown} values={values} editable={editable} onSave={onSave} />
            </Card>
          </div>
        );
      })}
      {questionnaireUpdatedAt && (
        <p className="text-xs text-faint">
          {t('people.fieldsUpdatedBySelf').replace('{date}', fmtDate(questionnaireUpdatedAt))}
        </p>
      )}
    </section>
  );
}
