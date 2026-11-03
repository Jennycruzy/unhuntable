// SQLite store. Migrations in src/migrations run in name order on open, each once,
// and are recorded in the migrations table.
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export interface OpenOptions {
  network: string;
  now?: () => number;
  migrationsDir?: string;
}

export function openDb(path: string, opts: OpenOptions): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, opts);
  return db;
}

/** Run every migration that is missing from the migrations table. Returns the names it ran. */
export function migrate(db: Db, opts: OpenOptions): string[] {
  const now = opts.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    created_ms INTEGER NOT NULL,
    network TEXT NOT NULL
  )`);
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const names = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set((db.prepare("SELECT name FROM migrations").all() as { name: string }[]).map((r) => r.name));
  const ran: string[] = [];
  // A migration may rebuild a table (SQLite cannot change a CHECK in place). Foreign keys are
  // switched off while it runs, as SQLite's own table-rebuild steps say, and checked after.
  const fk = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    for (const name of names) {
      if (done.has(name)) continue;
      const sql = readFileSync(`${dir}/${name}`, "utf8");
      db.transaction(() => {
        db.exec(sql);
        const broken = db.pragma("foreign_key_check") as unknown[];
        if (broken.length > 0) throw new Error(`migration ${name} leaves ${broken.length} broken references`);
        db.prepare("INSERT INTO migrations (name, created_ms, network) VALUES (?, ?, ?)").run(name, now(), opts.network);
      })();
      ran.push(name);
    }
  } finally {
    db.pragma(`foreign_keys = ${fk ? "ON" : "OFF"}`);
  }
  return ran;
}

export function newId(): string {
  return randomUUID();
}

/** A fresh shard id: 16 random lowercase hex characters (also a valid guard shard name). */
export function newShardId(): string {
  return randomBytes(8).toString("hex");
}
