export function usd(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function num(v: string | number | null | undefined, digits = 6): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : String(v);
}

/** A liquidation distance as a percent; the API may send a fraction (0.22) or a percent (22). */
export function pct(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "–";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${(Math.abs(n) <= 1 ? n * 100 : n).toFixed(1)}%`;
}

export function time(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

export function countdown(msLeft: number): string {
  if (msLeft <= 0) return "0:00";
  const s = Math.floor(msLeft / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function bpsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
