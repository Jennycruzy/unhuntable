// The Hyperliquid builder fee: one basis point on the opening orders of NEAR-controlled
// pieces, on Hyperliquid's own market list only. It is on only when BUILDER_FEE=on and the
// signer contract and the guard both name the same builder, so a fee is never asked for
// that the contract would refuse or the guard would not charge. Stops, take-profits,
// defence cuts and closes never carry it (the guard itself refuses to add it there).
import { BUILDER_FEE_RATE, readBuilder } from "unhuntable-client";
import type { Ctx } from "./ctx.js";

/** How long one answer about the builder is kept. */
export const BUILDER_KEEP_MS = 10 * 60_000;
/** The fee as a share of the size opened. */
export const BUILDER_FEE_SHARE = 0.0001;

const kept = new WeakMap<object, { at: number; builder: string | null }>();

/** The builder address in use, or null when the fee is off. Never throws. */
export async function activeBuilder(ctx: Ctx): Promise<string | null> {
  if (!ctx.builderFee || !ctx.chainsig) return null;
  const k = kept.get(ctx.db);
  if (k && ctx.now() - k.at < BUILDER_KEEP_MS) return k.builder;
  let builder: string | null = null;
  try {
    const raw = await ctx.near.viewRaw(ctx.chainsig.contract, "builder", new Uint8Array());
    const fromContract = raw ? readBuilder(raw) : null;
    const fromGuard = await ctx.guard.builder();
    if (fromContract && fromContract.rate === BUILDER_FEE_RATE && fromGuard && fromGuard.toLowerCase() === fromContract.builder) builder = fromContract.builder;
    else ctx.log?.warn({ contract: fromContract?.builder ?? null, guard: fromGuard }, "builder fee is switched on but the contract and the guard do not name the same builder; no fee is taken");
  } catch {
    // an answer we could not get means no fee, never a refused trade
    builder = null;
  }
  kept.set(ctx.db, { at: ctx.now(), builder });
  return builder;
}

/** Forget the kept answer (tests, and after the contract or the guard changes). */
export function forgetBuilder(ctx: Ctx): void {
  kept.delete(ctx.db);
}
