import { useState, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Input, Textarea, Card, Skeleton } from '../../components/ui';
import { useT } from '../../lib/i18n';

interface IntakeInfo { projectName?: string | null; name?: string | null; workspaceName?: string | null; description?: string | null }

export function IntakeFormPage({ token }: { token: string }) {
  const t = useT();
  const info = useQuery({ queryKey: ['intake', token], queryFn: () => api.get<IntakeInfo>(`/intake/${token}`), retry: false });
  const [form, setForm] = useState({ name: '', email: '', title: '', description: '', website: '' });
  const submit = useMutation({
    mutationFn: () => api.post(`/intake/${token}`, { name: form.name, email: form.email, title: form.title, description: form.description, website: form.website }),
  });

  if (info.isLoading) return <Frame><Skeleton className="h-72 w-full" /></Frame>;
  if (info.isError || !info.data) return <Frame><Card className="p-10 text-center text-sm text-muted-foreground">{t('public.formUnavailable')}</Card></Frame>;

  const projectName = info.data.projectName ?? info.data.name ?? t('public.thisProject');

  if (submit.isSuccess) {
    return (
      <Frame>
        <Card className="p-10 text-center">
          <h1 className="text-xl font-semibold">{t('public.thankYou')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('public.requestReceived')}</p>
        </Card>
      </Frame>
    );
  }

  return (
    <Frame>
      <Card className="p-8">
        <h1 className="text-xl font-semibold">{t('public.submitRequest')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('public.forProject')} {projectName}</p>
        {info.data.description && <p className="mt-3 text-sm text-muted-foreground">{info.data.description}</p>}
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.website) return; // honeypot tripped
            if (form.name && form.email && form.title) submit.mutate();
          }}
        >
          <label className="block text-xs text-muted-foreground">{t('public.yourName')}<Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required className="mt-1" /></label>
          <label className="block text-xs text-muted-foreground">{t('auth.email')}<Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required className="mt-1" /></label>
          <label className="block text-xs text-muted-foreground">{t('public.requestTitle')}<Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required className="mt-1" /></label>
          <label className="block text-xs text-muted-foreground">{t('public.description')}<Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={5} className="mt-1" /></label>
          {/* honeypot: hidden from users, catches bots */}
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
          <Button type="submit" disabled={submit.isPending}>{t('public.sendRequest')}</Button>
        </form>
      </Card>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background px-4 py-10"><div className="mx-auto max-w-2xl">{children}</div></div>;
}
