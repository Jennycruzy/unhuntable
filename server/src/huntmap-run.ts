// Runs the Hunt Map collector: one round every five minutes, for as long as the process lives.
// HUNTMAP_DB names its SQLite file. It needs no secrets: everything it reads is public.
import { resolve } from "node:path";
import { Hyperliquid } from "./hl.js";
import { HuntCollector, ROUND_EVERY_MS, freeBytesAt, openHuntDb } from "./huntmap.js";
import { createLogger } from "./log.js";

async function main(): Promise<void> {
  const log = createLogger();
  const path = resolve(process.env.HUNTMAP_DB ?? "huntmap.sqlite");
  const db = openHuntDb(path);
  const hl = new Hyperliquid((process.env.HYPERLIQUID_URL ?? "https://api.hyperliquid.xyz").replace(/\/+$/, ""));
  const collector = new HuntCollector(db, hl, { freeBytes: () => freeBytesAt(path) });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log.info({ path }, "hunt map collector started");
  while (!stopping) {
    const started = Date.now();
    try {
      log.info(await collector.round(), "hunt map round");
    } catch (e) {
      log.warn({ error: e instanceof Error ? e.message : String(e) }, "hunt map round failed");
    }
    const wait = Math.max(1000, ROUND_EVERY_MS - (Date.now() - started));
    for (let waited = 0; waited < wait && !stopping; waited += 500) await new Promise((r) => setTimeout(r, 500));
  }
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "hunt map collector failed to start");
  process.exit(1);
});
