// Words for the NEAR AI hunter: what it found, how that compares with chance, and what its
// enclave signature proves. Said only from the hunt's own numbers.
import type { AiHunt, AiHuntProof, AiHuntScore } from "./types";

const others = (n: number) => (n === 1 ? "1 other piece" : `${n} other pieces`);

/** The headline: held, partly found, or caught. */
export function headline(s: AiHuntScore): string {
  if (s.verdict === "caught") return `Caught. It named all ${others(s.pieces)} of this position.`;
  if (s.verdict === "partly") return `Partly found. It named ${s.found} of your ${others(s.pieces)}.`;
  return s.found === 0 ? `Held. It did not find your ${others(s.pieces)}.` : `Held. It named ${s.found} of your pieces, but more strangers than pieces.`;
}

/** How the names compare with picking at random from the same lineup. */
export function againstChance(s: AiHuntScore): string {
  const named = s.found + s.wrong;
  if (named === 0) return `It named none of the ${s.lineup} accounts.`;
  const right = s.found === 1 ? "1 was yours" : `${s.found} were yours`;
  const chance = s.chanceHits.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `It named ${named} of ${s.lineup} accounts and ${right}. Naming ${named} at random would find ${chance} on average.`;
}

/** What the enclave signature shows, in one plain line. */
export function proofLine(p: AiHuntProof): string {
  const c = p.checks;
  if (c.hashesMatch && c.signatureValid && c.inAttestation) return "Signed inside NEAR AI's TEE: the question and answer are exactly what the model saw and said.";
  if (!p.signed) return "NEAR AI did not return a signature for this answer.";
  const failed = [!c.hashesMatch && "the hashes", !c.signatureValid && "the signature", !c.inAttestation && "the attestation"].filter(Boolean).join(", ");
  return `The signature check did not hold for ${failed}.`;
}

/** The hunter's guess of the whole position. */
export function guessLine(h: AiHunt): string {
  const g = h.answer?.combined;
  if (!g || (!g.side && g.usd === null) || g.usd === 0) return "It could not say what the whole position is.";
  const side = g.side ? g.side[0]!.toUpperCase() + g.side.slice(1) : "Unknown side";
  return g.usd === null ? `${side}, size unknown.` : `${side}, about $${Math.round(g.usd).toLocaleString("en-US")}.`;
}
