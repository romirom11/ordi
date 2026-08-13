/**
 * Settings → Holidays (PRD §12.2). Holiday calendars and the company days off
 * each one carries. The team calendar and the dashboard's "who is away" strip
 * already draw these, and leave charges skip them – until this panel the only
 * way to maintain them was the raw API.
 *
 * The API has no PATCH for either entity, so there is no edit-in-place here:
 * a wrong date or name is a delete plus a re-add.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Plus, Sun, Trash2 } from 'lucide-react';
import { api, ApiError, qs } from '../../lib/api';
import { Button, IconButton, Input, Spinner, Skeleton, EmptyState, cn, fmtDate } from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';
import { DateField } from '../DatePicker';
import { SectionHead, Field, RowList, AnimatedRow } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.holidays': 'Holidays',
    'settings.holidaysDesc': 'Company days off, grouped into calendars. They show on the team calendar and dashboard, and approved leave is not charged for them.',
    'holidays.calendars': 'Calendars',
    'holidays.newCalendar': 'New calendar',
    'holidays.calendarName': 'Calendar name',
    'holidays.deleteCalendarTitle': 'Delete calendar',
    'holidays.deleteCalendarConfirm': 'Delete this calendar? All of its holidays will be deleted with it.',
    'holidays.noCalendars': 'No holiday calendars yet',
    'holidays.noCalendarsHint': 'Add a calendar, then fill in the days off.',
    'holidays.inCalendar': 'Holidays in {name}',
    'holidays.add': 'Add holiday',
    'holidays.date': 'Date',
    'holidays.empty': 'No holidays yet',
    'holidays.emptyHint': 'Add the company days off for this calendar.',
  },
  uk: {
    'settings.holidays': 'Свята',
    'settings.holidaysDesc': 'Вихідні дні компанії, згруповані в календарі. Вони видимі в командному календарі та на дашборді, і за них не списуються дні відпустки.',
    'holidays.calendars': 'Календарі',
    'holidays.newCalendar': 'Новий календар',
    'holidays.calendarName': 'Назва календаря',
    'holidays.deleteCalendarTitle': 'Видалити календар',
    'holidays.deleteCalendarConfirm': 'Видалити цей календар? Разом з ним видаляться всі його свята.',
    'holidays.noCalendars': 'Ще немає календарів свят',
    'holidays.noCalendarsHint': 'Додайте календар, а потім заповніть вихідні дні.',
    'holidays.inCalendar': 'Свята у {name}',
    'holidays.add': 'Додати свято',
    'holidays.date': 'Дата',
    'holidays.empty': 'Ще немає свят',
    'holidays.emptyHint': 'Додайте вихідні дні компанії для цього календаря.',
  },
});

interface HolidayCalendar { id: string; name: string }
interface Holiday { id: string; calendarId: string; date: string; name: string }

export function HolidaysPanel() {
  const t = useT();
  const qc = useQueryClient();
  const calendarsQ = useQuery({
    queryKey: ['holidayCalendars'],
    queryFn: () => api.get<{ data: HolidayCalendar[] }>('/holiday-calendars'),
  });
  const calendars = calendarsQ.data?.data ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [deletingCal, setDeletingCal] = useState<HolidayCalendar | null>(null);

  // Auto-select the first calendar, and re-select when the current one is gone.
  useEffect(() => {
    if (calendars.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !calendars.some((c) => c.id === selectedId)) setSelectedId(calendars[0]?.id ?? null);
  }, [calendars, selectedId]);

  const selected = calendars.find((c) => c.id === selectedId) ?? null;

  const holidaysQ = useQuery({
    queryKey: ['holidays', selectedId],
    queryFn: () => api.get<{ data: Holiday[] }>(`/holidays${qs({ calendarId: selectedId })}`),
    enabled: !!selectedId,
  });
  const holidays = [...(holidaysQ.data?.data ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  // ['holidays'] without the calendar id also catches the team calendar's
  // all-holidays query, so it repaints after edits here.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['holidayCalendars'] });
    qc.invalidateQueries({ queryKey: ['holidays'] });
  };

  const delCalendar = useMutation({
    mutationFn: (id: string) => api.del(`/holiday-calendars/${id}`),
    onSuccess: () => { setDeletingCal(null); invalidate(); toast(t('common.saved')); },
    onError: (e) => { setDeletingCal(null); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });
  const delHoliday = useMutation({
    mutationFn: (id: string) => api.del(`/holidays/${id}`),
    onSuccess: () => { invalidate(); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });

  return (
    <div>
      <SectionHead
        title={t('settings.holidays')}
        desc={t('settings.holidaysDesc')}
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> {t('holidays.newCalendar')}</Button>}
      />

      {calendarsQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : calendars.length === 0 ? (
        <EmptyState icon={<CalendarDays size={18} />} title={t('holidays.noCalendars')} hint={t('holidays.noCalendarsHint')} />
      ) : (
        <>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('holidays.calendars')}</div>
          <RowList>
            {calendars.map((cal, i) => (
              <AnimatedRow
                key={cal.id}
                index={i}
                onClick={() => setSelectedId(cal.id)}
                className={cn(
                  'group flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-0',
                  cal.id === selectedId ? 'bg-muted/60' : 'hover:bg-muted/40',
                )}
              >
                <CalendarDays size={15} className={cal.id === selectedId ? 'text-foreground' : 'text-faint'} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{cal.name}</span>
                <div className="opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton
                    size="sm"
                    aria-label={t('common.delete')}
                    className="text-destructive"
                    onClick={(e) => { e.stopPropagation(); setDeletingCal(cal); }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </AnimatedRow>
            ))}
          </RowList>

          {selected && (
            <div className="mt-8">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                  {t('holidays.inCalendar').replace('{name}', selected.name)}
                </div>
                <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus size={14} /> {t('holidays.add')}</Button>
              </div>

              {holidaysQ.isLoading ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : holidays.length === 0 ? (
                <EmptyState icon={<Sun size={18} />} title={t('holidays.empty')} hint={t('holidays.emptyHint')} />
              ) : (
                <RowList>
                  {holidays.map((h, i) => (
                    <AnimatedRow key={h.id} index={i} className="group flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
                      <span className="w-24 shrink-0 text-[13px] tabular-nums text-muted-foreground">{fmtDate(h.date)}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{h.name}</span>
                      <div className="opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                        <IconButton
                          size="sm"
                          aria-label={t('common.delete')}
                          className="text-destructive"
                          disabled={delHoliday.isPending}
                          onClick={() => delHoliday.mutate(h.id)}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </AnimatedRow>
                  ))}
                </RowList>
              )}
            </div>
          )}
        </>
      )}

      <CalendarDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(id) => setSelectedId(id)} />

      {selected && (
        <HolidayDialog open={addOpen} calendar={selected} onClose={() => setAddOpen(false)} />
      )}

      <ConfirmDialog
        open={!!deletingCal}
        onClose={() => setDeletingCal(null)}
        onConfirm={() => { if (deletingCal) delCalendar.mutate(deletingCal.id); }}
        title={t('holidays.deleteCalendarTitle')}
        body={t('holidays.deleteCalendarConfirm')}
        confirmLabel={t('common.delete')}
        danger
        pending={delCalendar.isPending}
      />
    </div>
  );
}

function CalendarDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');

  useEffect(() => { if (open) setName(''); }, [open]);

  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/holiday-calendars', { name: name.trim() }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['holidayCalendars'] });
      if (r?.id) onCreated(r.id);
      toast(t('common.saved'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('holidays.newCalendar')} width={380}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
      >
        <Field label={t('holidays.calendarName')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ukraine 2026" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!name.trim() || save.isPending}>
            {save.isPending ? <Spinner /> : null} {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HolidayDialog({ open, calendar, onClose }: { open: boolean; calendar: HolidayCalendar; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [date, setDate] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => { if (open) { setDate(null); setName(''); } }, [open]);

  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/holidays', { calendarId: calendar.id, date, name: name.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holidays'] });
      toast(t('common.saved'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('holidays.add')} width={380}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(e: FormEvent) => { e.preventDefault(); if (date && name.trim()) save.mutate(); }}
      >
        <Field label={t('holidays.date')}>
          <DateField value={date} onChange={setDate} />
        </Field>
        <Field label={t('common.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Independence Day" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!date || !name.trim() || save.isPending}>
            {save.isPending ? <Spinner /> : null} {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
