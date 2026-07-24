/**
 * Full-page task view (Linear-style). Route: /projects/:id/tasks/:taskId
 * Placeholder scaffold — full implementation lands with the task-page feature.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Skeleton } from '../components/ui';

export function TaskPage({ projectId, taskId }: { projectId: string; taskId: string }) {
  const taskQ = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<{ title: string }>(`/tasks/${taskId}?include=assignees,labels,comments`),
  });
  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      {taskQ.isLoading ? <Skeleton className="h-8 w-2/3" /> : (
        <h1 className="text-xl font-semibold">{taskQ.data?.title}</h1>
      )}
      <p className="mt-2 text-sm text-muted-foreground">Project {projectId}</p>
    </div>
  );
}
