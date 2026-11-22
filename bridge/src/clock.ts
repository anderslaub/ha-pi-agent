/**
 * Local time for the assistant's sense of time: "now" lines, "how long ago" lines, timestamps with the local
 * offset, a small calendar for turning "next Thursday" into a date, and parsing the times the model gives to the
 * wake-up tool. Everything in one IANA time zone, not necessarily the host's: PI_BRIDGE_TIMEZONE, else Home
 * Assistant's time zone (sent with every turn), else the host's.
 */

/** Whether the IANA time zone name is known (e.g. "Europe/Copenhagen") */
export function validTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The host's time zone (servers often run UTC) */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function hhmm(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Monday 23/11" */
export function dayLabel(date: Date, tz: string, withYear = false): string {
  const p = localParts(date, tz);
  return `${WEEKDAYS[p.weekday]} ${p.day}/${p.month}${withYear ? ` ${p.year}` : ""}`;
}

/** "The time is right now 07:42, it's Monday the 23/11 2026." */
export function nowLine(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `The time is right now ${hhmm(date, tz)}, it's ${WEEKDAYS[p.weekday]} the ${p.day}/${p.month} ${p.year}.`;
}

/** Offset of the time zone at that moment, in minutes (Copenhagen: 60 in winter, 120 in summer) */
export function offsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60_000) * 60_000) / 60_000);
}

/** "2026-11-23T07:42+01:00": local time with its offset, readable and parseable */
export function stamp(date: Date, tz: string): string {
  const p = localParts(date, tz);
  const off = offsetMinutes(date, tz);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Days between the local calendar dates (0 = same day, 1 = yesterday ...) */
export function calendarDaysBetween(earlier: Date, later: Date, tz: string): number {
  const a = localParts(earlier, tz);
  const b = localParts(later, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

/** "Your last conversation was 9 hours ago, at 22:40 yesterday (Sunday 22/11)." */
export function lastConversationLine(last: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(last, now, tz);
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : WEEKDAYS[localParts(last, tz).weekday];
  return `Your last conversation was ${duration(now.getTime() - last.getTime())} ago, at ${hhmm(last, tz)} ${when} (${dayLabel(last, tz)}).`;
}

/** The next days with their dates, so the model can turn "next Thursday" into a date */
export function calendar(now: Date, tz: string, days = 14): string {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const p = localParts(d, tz);
    out.push(`${WEEKDAYS[p.weekday].slice(0, 3)} ${p.day}/${p.month}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}`);
  }
  return out.join(", ");
}

/** The moment of a local wall-clock time in the time zone */
export function fromLocal(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // two rounds settle the offset, also around a daylight saving change
  for (let i = 0; i < 2; i++) guess = new Date(Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes(guess, tz) * 60_000);
  return guess;
}

/**
 * A time the model gave the wake-up tool: "2026-11-27 18:30", "2026-11-27T18:30", "18:30" (the next time it is
 * 18:30), "thursday 18:30", "tomorrow 06:45", "in 20 minutes", "in 2 hours", "+45m". Undefined when unreadable.
 */
export function parseWhen(text: string, now: Date, tz: string): Date | undefined {
  const s = text.trim().toLowerCase();
  let m = /^(?:in\s+|\+)\s*(\d+(?:[.,]\d+)?)\s*(m|min|mins|minutes?|h|hours?)$/.exec(s);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    return new Date(now.getTime() + n * (m[2].startsWith("h") ? 3_600_000 : 60_000));
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ t](\d{1,2})[:.](\d{2})/.exec(s);
  if (m) return fromLocal(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
  // "thursday 18:30", "tomorrow 06:45", "today at 17:00" (a weekday: the next one, today if the time is still ahead)
  m = /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\w*(?:\s+at)?\s+(\d{1,2})[:.](\d{2})$/.exec(s);
  if (m) {
    const nowDay = localParts(now, tz).weekday;
    let add: number;
    if (m[1] === "today") add = 0;
    else if (m[1] === "tomorrow") add = 1;
    else add = (WEEKDAYS.findIndex((d) => d.toLowerCase().startsWith(m![1].slice(0, 3))) - nowDay + 7) % 7;
    for (;; add += 7) {
      const p = localParts(new Date(now.getTime() + add * 86_400_000), tz);
      const at = fromLocal(p.year, p.month, p.day, +m[2], +m[3], tz);
      if (at.getTime() > now.getTime() || m[1] === "today" || m[1] === "tomorrow") return at;
    }
  }
  m = /^(\d{1,2})[:.](\d{2})$/.exec(s);
  if (m) {
    const p = localParts(now, tz);
    let at = fromLocal(p.year, p.month, p.day, +m[1], +m[2], tz);
    if (at.getTime() <= now.getTime()) {
      const t = localParts(new Date(now.getTime() + 86_400_000), tz);
      at = fromLocal(t.year, t.month, t.day, +m[1], +m[2], tz);
    }
    return at;
  }
  return undefined;
}
