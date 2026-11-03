import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, newShardId, openDb } from "../src/db.js";

const TABLES = [
  "agent_calls",
  "agents",
  "alerts",
  "evidence",
  "fundings",
  "jobs",
  "migrations",
  "piece_orders",
  "pieces",
  "positions",
  "proofs",
  "sessions",
  "sign_in_nonces",
  "ticks",
  "users",
];

describe("migrations idempotent", () => {
  it("runs once, records its name, and a second open changes nothing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "unhuntable-db-")), "t.sqlite");
    const db = openDb(path, { network: "mainnet", now: () => 42 });
    expect(db.prepare("SELECT name, created_ms, network FROM migrations").all()).toEqual([
      { name: "001_init.sql", created_ms: 42, network: "mainnet" },
    ]);
    db.prepare("INSERT INTO users (id, near_account, created_ms, network) VALUES ('u', 'alice.near', 1, 'mainnet')").run();
    expect(migrate(db, { network: "mainnet" })).toEqual([]);
    db.close();
    const again = openDb(path, { network: "mainnet" });
    expect(again.prepare("SELECT COUNT(*) AS n FROM migrations").get()).toEqual({ n: 1 });
    expect(again.prepare("SELECT near_account FROM users").get()).toEqual({ near_account: "alice.near" });
    again.close();
  });

  it("creates every table, each with created_ms and network", () => {
    const db = openDb(":memory:", { network: "mainnet" });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(TABLES);
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[];
      expect(cols.find((c) => c.name === "created_ms")?.notnull, t).toBe(1);
      expect(cols.find((c) => c.name === "network")?.notnull, t).toBe(1);
    }
    const tickCols = (db.prepare("PRAGMA table_info(ticks)").all() as { name: string }[]).map((c) => c.name);
    expect(tickCols.some((c) => /stop|trigger/.test(c))).toBe(false);
  });

  it("checks states and shard ids", () => {
    const db = openDb(":memory:", { network: "mainnet" });
    db.prepare("INSERT INTO users (id, near_account, created_ms, network) VALUES ('u', 'alice.near', 1, 'mainnet')").run();
    const piece = db.prepare("INSERT INTO pieces (id, user_id, shard_id, policy_state, created_ms, network) VALUES (?, 'u', ?, ?, 1, 'mainnet')");
    const shard = newShardId();
    expect(shard).toMatch(/^[0-9a-f]{16}$/);
    piece.run("p1", shard, "locked");
    expect(() => piece.run("p2", shard, "locked")).toThrow(/UNIQUE/);
    expect(() => piece.run("p3", "ABCDEF0123456789", "locked")).toThrow(/CHECK/);
    expect(() => piece.run("p4", "0123", "locked")).toThrow(/CHECK/);
    expect(() => piece.run("p5", newShardId(), "open")).toThrow(/CHECK/);
    const job = db.prepare("INSERT INTO jobs (id, kind, payload_json, state, next_run_ms, created_ms, network) VALUES (?, 'k', '{}', ?, 0, 1, 'mainnet')");
    expect(() => job.run("j1", "stuck")).toThrow(/CHECK/);
  });
});
