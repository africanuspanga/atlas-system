const TANZANIA_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Dar_es_Salaam',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date in the school's operating timezone, never the server's UTC day. */
export function todayInTanzania(now = new Date()): string {
  const parts = Object.fromEntries(
    TANZANIA_DATE_FORMATTER.formatToParts(now).map(({ type, value }) => [
      type,
      value,
    ]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Inclusive UTC instants covering one or more Tanzania calendar dates. */
export function tanzaniaDateRange(from: string, to = from) {
  return {
    from: new Date(`${from}T00:00:00.000+03:00`).toISOString(),
    to: new Date(`${to}T23:59:59.999+03:00`).toISOString(),
  };
}

/** Add billing months without JavaScript's Jan-31 → Mar-03 overflow. */
export function addUtcCalendarMonthsClamped(input: Date, months: number): Date {
  const result = new Date(input);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
