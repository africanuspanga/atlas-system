const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Dar_es_Salaam',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function todayInTanzania(now = new Date()): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dateInTanzaniaAfterDays(days: number, now = new Date()): string {
  return todayInTanzania(new Date(now.getTime() + days * 86_400_000));
}
