const pad = (n: number) => String(n).padStart(2, "0");

/** Local date as "YYYY-MM-DD" (for <input type="date">). */
export function localDateInputValue(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local date-time as "YYYY-MM-DDTHH:mm" (for <input type="datetime-local">). */
export function localDateTimeInputValue(d: Date = new Date()): string {
  return `${localDateInputValue(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
