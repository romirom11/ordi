/**
 * Project activity feed: the shared audit trail, worded for projects. The
 * rendering lives in EntityActivity – this file owns only the project wording
 * and the legacy query key that ProjectUpdates/ProjectDetail invalidate.
 */
import { EntityActivity } from '../EntityActivity';
import { useT, extendDict } from '../../lib/i18n';
import type { UserLite } from './pickers';

extendDict({
  en: {
    'projects.activity': 'Activity',
    'projects.activity.created': 'created the project',
    'projects.activity.updated': 'updated the project',
    'projects.activity.deleted': 'deleted the project',
    'projects.activity.member_added': 'added a member',
    'projects.activity.member_removed': 'removed a member',
    'projects.activity.milestone_added': 'added a milestone',
    'projects.activity.milestone_completed': 'completed a milestone',
    'projects.activity.update_posted': 'posted a project update',
    'projects.activity.seeAll': 'See all',
    'projects.activity.collapse': 'Show less',
    'projects.activity.empty': 'No activity yet',
  },
  uk: {
    'projects.activity': 'Активність',
    'projects.activity.created': 'створює проєкт',
    'projects.activity.updated': 'оновлює проєкт',
    'projects.activity.deleted': 'видаляє проєкт',
    'projects.activity.member_added': 'додає учасника',
    'projects.activity.member_removed': 'прибирає учасника',
    'projects.activity.milestone_added': 'додає віху',
    'projects.activity.milestone_completed': 'завершує віху',
    'projects.activity.update_posted': 'публікує оновлення проєкту',
    'projects.activity.seeAll': 'Показати все',
    'projects.activity.collapse': 'Згорнути',
    'projects.activity.empty': 'Активності поки немає',
  },
});

export function ProjectActivity({ projectId, users }: { projectId: string; users: UserLite[] }) {
  const t = useT();
  return (
    <EntityActivity
      entityType="project"
      entityId={projectId}
      users={users}
      title={t('projects.activity')}
      emptyLabel={t('projects.activity.empty')}
      labelFor={(action) => t(`projects.activity.${action}`, action)}
      queryKey={['project-audit', projectId]}
    />
  );
}
