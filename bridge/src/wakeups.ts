/**
 * Wake-ups: the assistant can set a time to speak up by itself on the voice device it was talking on, to remind
 * someone or to ask how something went (tools wakeup_set / wakeup_list / wakeup_cancel). Stored in a JSON file,
 * so they survive a restart. When one is due, the bridge runs a short turn ("you set this wake-up for now: ...")
 * and publishes the reply on the event stream; Home Assistant speaks it on the satellite (and listens for an
 * answer when it ends with a question).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dayLabel, hhmm } from "./clock.ts";

export interface Wakeup {
  id: string;
  /** when, ms since the epoch */
  at: number;
  /** what to say or ask, in the assistant's own words */
  note: string;
  created: number;
  satellite_id?: string | null;
  device_id?: string | null;
  language?: string;
}

/** A wake-up the bridge was not running for is still done this late, else dropped */
export const MAX_LATE_MS = 30 * 60_000;

export class WakeupStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  list(): Wakeup[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(data) ? (data as Wakeup[]).sort((a, b) => a.at - b.at) : [];
    } catch {
      return [];
    }
  }

  private save(items: Wakeup[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 1));
    fs.renameSync(tmp, this.file);
  }

  add(w: Omit<Wakeup, "id" | "created">): Wakeup {
    const item: Wakeup = { ...w, id: randomUUID().slice(0, 8), created: Date.now() };
    this.save([...this.list(), item]);
    return item;
  }

  cancel(id: string): Wakeup | undefined {
    const items = this.list();
    const found = items.find((w) => w.id === id.trim());
    if (found) this.save(items.filter((w) => w !== found));
    return found;
  }

  /** Take the wake-ups that are due out of the store */
  takeDue(now = Date.now()): Wakeup[] {
    const items = this.list();
    const due = items.filter((w) => w.at <= now);
    if (due.length) this.save(items.filter((w) => w.at > now));
    return due;
  }
}

/** "Tue 24/11 07:00: remind Anders about the dentist (id 1a2b3c4d)" */
export function describeWakeup(w: Wakeup, tz: string, withId = false): string {
  const d = new Date(w.at);
  return `${dayLabel(d, tz)} ${hhmm(d, tz)}: ${w.note}${withId ? ` (id ${w.id})` : ""}`;
}
