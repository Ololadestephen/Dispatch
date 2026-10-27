const watDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/** "Sat 24 Oct, 09:00 WAT". Non-timestamps (e.g. UNVERIFIED) are returned as words. */
export function formatWat(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso === 'UNVERIFIED' ? 'Not verified' : 'Unclear';
  return `${watDateTime.format(date)} WAT`;
}

const watWeekday = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  weekday: 'long'
});

/** "Saturday" for a WAT deadline. Invalid input degrades to "that day", like formatWat. */
export function weekdayWat(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'that day';
  return watWeekday.format(date);
}
