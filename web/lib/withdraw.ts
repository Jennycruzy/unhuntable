// Withdraw: send USDC from the private balance to the user's own NEAR account.
//
// The private balance is an OutLayer wallet owned by the pieces key, so this page asks
// OutLayer itself, signed with the pieces key on this device. Our server is not in the path
// and cannot change where the money goes: the wallet's policy, stored on NEAR, only lets the
// private balance send to the user's own pieces and own addresses, and the NEAR account the
// user signed in with is one of them.
import { DeterministicWalletError, OutLayerDeterministic, ownerAccount, seedFor, type PiecesKey } from "unhuntable-client/keys";
import { USDC_NEAR } from "unhuntable-client/exit";

type Fetch = typeof fetch;

export interface WithdrawDeps {
  key: PiecesKey;
  /** The NEAR account the user signed in with; the money goes there. */
  account: string;
  outlayerFetch?: Fetch;
  now?: () => number;
}

export interface WithdrawPreview {
  /** In USDC's own units (6 decimals). */
  units: string;
  amountOut: string | null;
  seconds: number | null;
}

/** "12.5" -> "12500000". At most 6 decimals, more than zero. */
export function usdcUnits6(amount: string): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) throw new Error("Type an amount in USDC, such as 12.50.");
  const u = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (u === 0n) throw new Error("Type an amount above zero.");
  return u.toString();
}

export const fromUnits6 = (u: string | bigint): string => {
  const n = BigInt(u);
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${n / 1_000_000n}${frac ? "." + frac : ""}`;
};

function wallet(d: WithdrawDeps): OutLayerDeterministic {
  return new OutLayerDeterministic({ key: d.key, account: ownerAccount(d.key), seed: seedFor(d.key, "balance"), fetch: d.outlayerFetch, now: d.now });
}

/** OutLayer's words, said plainly. */
function plain(e: unknown): Error {
  if (e instanceof DeterministicWalletError) {
    if (e.code === "policy_denied") return new Error("Your private balance's policy only sends to your own addresses, and this one is not on it. Nothing was sent.");
    if (e.code === "unreachable" || e.status === 429 || e.status >= 500) return new Error("OutLayer is not answering right now. Nothing was sent. Try again in a minute.");
    return new Error(`OutLayer refused it: ${e.message}. Nothing was sent.`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** USDC in the private balance, in 6-decimal units. */
export async function privateUsdc(d: WithdrawDeps): Promise<bigint> {
  try {
    const r = await wallet(d).request<{ balances?: { token: string; balance: string }[] }>("GET", "/wallet/v1/confidential/balance");
    return BigInt((r.balances ?? []).find((b) => b.token === USDC_NEAR)?.balance ?? "0");
  } catch (e) {
    throw plain(e);
  }
}

const body = (d: WithdrawDeps, units: string) => ({ chain: "near", to: d.account, amount: units, token: USDC_NEAR });

/** What would arrive, before anything is sent. */
export async function previewWithdraw(d: WithdrawDeps, amount: string, have: bigint): Promise<WithdrawPreview> {
  const units = usdcUnits6(amount);
  if (BigInt(units) > have) throw new Error(`Your private balance holds ${fromUnits6(have)} USDC. Type that or less.`);
  try {
    const r = await wallet(d).request<{ amount_out?: unknown; time_estimate_seconds?: unknown }>("POST", "/wallet/v1/confidential/withdraw/dry-run", body(d, units));
    return {
      units,
      amountOut: typeof r.amount_out === "string" || typeof r.amount_out === "number" ? fromUnits6(String(r.amount_out)) : null,
      seconds: typeof r.time_estimate_seconds === "number" ? r.time_estimate_seconds : null,
    };
  } catch (e) {
    throw plain(e);
  }
}

/** Send it. Answers OutLayer's request id and status. */
export async function sendWithdraw(d: WithdrawDeps, p: WithdrawPreview): Promise<{ requestId: string; status: string }> {
  try {
    const r = await wallet(d).request<{ request_id?: unknown; status?: unknown }>("POST", "/wallet/v1/confidential/withdraw", body(d, p.units));
    return { requestId: String(r.request_id ?? ""), status: String(r.status ?? "") };
  } catch (e) {
    throw plain(e);
  }
}
