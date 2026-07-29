/** Resolve an IANA zone without allowing a bad profile value to break work. */
export function safeTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value;
  } catch {
    return 'UTC';
  }
}

function zonedParts(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
}

export function localDateKey(value: Date, timeZone: string): string {
  const parts = zonedParts(value, timeZone);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function localHour(value: Date, timeZone: string): number {
  return Number(zonedParts(value, timeZone).find((item) => item.type === 'hour')!.value);
}
