import { copyFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrate, newShardId, openDb } from "../src/db.js";

const TABLES = [
  "agent_calls",
  "agents",
  "alerts",
  "chainsig_requests",
  "deposits",
  "evidence",
  "fundings",
  "guard_calls",
  "home_steps",
  "homes",
  "jobs",
  "migrations",
  "piece_orders",
  "pieces",
  "position_pieces",
  "positions",
  "proofs",
  "refills",
  "sessions",
  "settings",
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
      { name: "002_money.sql", created_ms: 42, network: "mainnet" },
      { name: "003_chainsig.sql", created_ms: 42, network: "mainnet" },
      { name: "004_xyz.sql", created_ms: 42, network: "mainnet" },
      { name: "005_builder.sql", created_ms: 42, network: "mainnet" },
    ]);
    db.prepare("INSERT INTO users (id, near_account, created_ms, network) VALUES ('u', 'alice.near', 1, 'mainnet')").run();
    expect(migrate(db, { network: "mainnet" })).toEqual([]);
    db.close();
    const again = openDb(path, { network: "mainnet" });
    expect(again.prepare("SELECT COUNT(*) AS n FROM migrations").get()).toEqual({ n: 5 });
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
    // No column anywhere holds a stop or take-profit level.
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols.filter((c) => /stop|trigger|tp_|take_profit|level/.test(c) && !/^has_/.test(c)), t).toEqual([]);
    }
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
    expect(() => piece.run("p6", newShardId(), "exit_unlocked")).toThrow(/CHECK/);
    const job = db.prepare("INSERT INTO jobs (id, kind, payload_json, state, next_run_ms, created_ms, network) VALUES (?, 'k', '{}', ?, 0, 1, 'mainnet')");
    expect(() => job.run("j1", "stuck")).toThrow(/CHECK/);
  });
});

const MIGRATION_ONE = fileURLToPath(new URL("../src/migrations/001_init.sql", import.meta.url));

describe("money schema", () => {
  it("migration_runs_on_existing_db", () => {
    const dir = mkdtempSync(join(tmpdir(), "unhuntable-mig-"));
    copyFileSync(MIGRATION_ONE, join(dir, "001_init.sql"));
    const path = join(dir, "t.sqlite");
    const old = openDb(path, { network: "mainnet", migrationsDir: dir, now: () => 7 });
    old.prepare("INSERT INTO users (id, near_account, created_ms, network) VALUES ('u', 'alice.near', 1, 'mainnet')").run();
    old.prepare("INSERT INTO pieces (id, user_id, shard_id, wallet_id, hl_master, policy_state, created_ms, network) VALUES ('p1', 'u', '0123456789abcdef', 'w1', '0x1111111111111111111111111111111111111111', 'locked', 2, 'mainnet')").run();
    old.prepare("INSERT INTO pieces (id, user_id, shard_id, policy_state, created_ms, network) VALUES ('p2', 'u', 'fedcba9876543210', 'exit_unlocked', 3, 'mainnet')").run();
    old.prepare("INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, created_ms, network) VALUES ('x1', 'u', 'ETH', 'long', 100, 3, 'normal', 'open', 4, 'mainnet')").run();
    old.prepare("INSERT INTO piece_orders (id, position_id, piece_id, kind, size, created_ms, network) VALUES ('o1', 'x1', 'p1', 'open', 0.01, 5, 'mainnet')").run();
    old.prepare("INSERT INTO fundings (id, piece_id, direction, amount, created_ms, network) VALUES ('f1', 'p2', 'in', 12, 6, 'mainnet')").run();
    old.close();

    const db = openDb(path, { network: "mainnet" });
    expect((db.prepare("SELECT name FROM migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name)).toEqual(["001_init.sql", "002_money.sql", "003_chainsig.sql", "004_xyz.sql", "005_builder.sql"]);
    expect(db.prepare("SELECT id, kind, shard_id, wallet_id, hl_address, policy_state FROM pieces ORDER BY id").all()).toEqual([
      { id: "p1", kind: "piece", shard_id: "0123456789abcdef", wallet_id: "w1", hl_address: "0x1111111111111111111111111111111111111111", policy_state: "locked" },
      { id: "p2", kind: "piece", shard_id: "fedcba9876543210", wallet_id: null, hl_address: null, policy_state: "unlocked" },
    ]);
    expect(db.prepare("SELECT id, state, guard FROM positions").all()).toEqual([{ id: "x1", state: "open", guard: "ok" }]);
    expect(db.prepare("SELECT id, piece_id FROM piece_orders").all()).toEqual([{ id: "o1", piece_id: "p1" }]);
    expect(db.prepare("SELECT id, piece_id FROM fundings").all()).toEqual([{ id: "f1", piece_id: "p2" }]);
    expect(db.prepare("SELECT near_account, pieces_public_key FROM users").get()).toEqual({ near_account: "alice.near", pieces_public_key: null });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    // references still hold after the rebuild
    expect(() => db.prepare("INSERT INTO piece_orders (id, position_id, piece_id, kind, created_ms, network) VALUES ('o2', 'x1', 'nope', 'open', 1, 'mainnet')").run()).toThrow(/FOREIGN KEY/);
    // new states are allowed
    db.prepare("UPDATE positions SET state = 'policy_wait' WHERE id = 'x1'").run();
    db.prepare("UPDATE positions SET state = 'funding' WHERE id = 'x1'").run();
    db.close();
  });

  it("new_piece_is_not_locked", () => {
    const db = openDb(":memory:", { network: "mainnet" });
    db.prepare("INSERT INTO users (id, near_account, created_ms, network) VALUES ('u', 'alice.near', 1, 'mainnet')").run();
    db.prepare("INSERT INTO pieces (id, user_id, label, shard_id, created_ms, network) VALUES ('p', 'u', 'piece:0', ?, 1, 'mainnet')").run(newShardId());
    expect(db.prepare("SELECT policy_state, kind FROM pieces").get()).toEqual({ policy_state: "none", kind: "piece" });
    // a balance wallet has no shard; a piece must have one
    db.prepare("INSERT INTO pieces (id, user_id, label, kind, created_ms, network) VALUES ('b', 'u', 'balance', 'balance', 1, 'mainnet')").run();
    expect(() => db.prepare("INSERT INTO pieces (id, user_id, label, kind, created_ms, network) VALUES ('q', 'u', 'piece:1', 'piece', 1, 'mainnet')").run()).toThrow(/CHECK/);
    // one label per user
    expect(() => db.prepare("INSERT INTO pieces (id, user_id, label, kind, created_ms, network) VALUES ('b2', 'u', 'balance', 'balance', 1, 'mainnet')").run()).toThrow(/UNIQUE/);
  });
});
