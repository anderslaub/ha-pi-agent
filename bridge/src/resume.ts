/**
 * Which saved pi session belongs to which Home Assistant conversation, kept on disk, so a conversation can be
 * continued after the bridge has let go of it (quiet for a while, or restarted): the session file is opened again
 * instead of starting a new one. Only for conversations (session_key "conversation:<id>"); a device's session is
 * started fresh after its quiet period, as before.
 */
import fs from "node:fs";
import path from "node:path";

/** Conversations remembered (the most recently used); older ones start fresh if they ever come back */
const KEEP = 500;

interface Saved {
  file: string;
  used: number;
}

export class ConversationFiles {
  private map: Record<string, Saved> = {};
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object") this.map = saved;
    } catch {
      // nothing saved yet
    }
  }

  /** Whether this session key may be continued from its file */
  static resumable(key: string): boolean {
    return key.startsWith("conversation:");
  }

  /** The session file to continue, if it still exists (old conversations are deleted after a while) */
  get(key: string): string | undefined {
    const saved = this.map[key];
    if (!saved) return undefined;
    if (fs.existsSync(saved.file)) return saved.file;
    delete this.map[key];
    this.write();
    return undefined;
  }

  set(key: string, file: string, now = Date.now()): void {
    if (!ConversationFiles.resumable(key)) return;
    this.map[key] = { file, used: now };
    const keys = Object.keys(this.map);
    if (keys.length > KEEP) {
      keys
        .sort((a, b) => this.map[b].used - this.map[a].used)
        .slice(KEEP)
        .forEach((k) => delete this.map[k]);
    }
    this.write();
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.map));
      fs.renameSync(tmp, this.file);
    } catch {
      // not kept: those conversations start fresh after a restart
    }
  }
}
