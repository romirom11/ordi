import { useState, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Input, Textarea, Card, Skeleton } from '../../components/ui';
import { useT } from '../../lib/i18n';

interface JobInfo { title?: string | null; description?: string | null; department?: string | null; workspaceName?: string | null }

export function CareersPage({ token }: { token: string }) {
  const t = useT();
  const job = useQuery({ queryKey: ['careers', token], queryFn: () => api.get<JobInfo>(`/careers/${token}`), retry: false });
  const [form, setForm] = useState({ name: '', email: '', coverText: '', website: '' });
  const submit = useMutation({
    mutationFn: () => api.post(`/careers/${token}`, { name: form.name, email: form.email, coverText: form.coverText, website: form.website }),
  });

  if (job.isLoading) return <Frame><Skeleton className="h-72 w-full" /></Frame>;
  if (job.isError || !job.data) return <Frame><Card className="p-10 text-center text-sm text-muted-foreground">{t('public.openingUnavailable')}</Card></Frame>;

  if (submit.isSuccess) {
    return (
      <Frame>
        <Card className="p-10 text-center">
          <h1 className="text-xl font-semibold">{t('public.applicationReceived')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('public.applicationThanks')}</p>
        </Card>
      </Frame>
    );
  }

  const j = job.data;

  return (
    <Frame>
      <Card className="p-8">
        <h1 className="text-2xl font-semibold">{j.title ?? t('public.openPosition')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {[j.department, j.workspaceName].filter(Boolean).join(' · ')}
        </p>
        {j.description && <p className="mt-4 whitespace-pre-line text-sm leading-relaxed">{j.description}</p>}

        <form
          className="mt-8 space-y-4 border-t border-border pt-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.website) return; // honeypot tripped
            if (form.name && form.email) submit.mutate();
          }}
        >
          <div className="text-sm font-medium">{t('public.apply')}</div>
          <label className="block text-xs text-muted-foreground">{t('public.yourName')}<Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required className="mt-1" /></label>
          <label className="block text-xs text-muted-foreground">{t('auth.email')}<Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required className="mt-1" /></label>
          <label className="block text-xs text-muted-foreground">{t('public.coverLetter')}<Textarea value={form.coverText} onChange={(e) => setForm((f) => ({ ...f, coverText: e.target.value }))} rows={6} className="mt-1" placeholder={t('public.coverLetterPlaceholder')} /></label>
          {/* honeypot */}
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={form.website}
            onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
            aria-hidden="true"
            className="absolute left-[-9999px] h-0 w-0 opacity-0"
          />
          {submit.isError && <p className="text-sm text-destructive">{t('public.tryAgain')}</p>}
          <Button type="submit" disabled={submit.isPending}>{t('public.submitApplication')}</Button>
        </form>
      </Card>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background px-4 py-10"><div className="mx-auto max-w-2xl">{children}</div></div>;
}
