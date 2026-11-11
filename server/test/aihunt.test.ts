import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";
import { AiHunter, HUNTS_PER_USER_PER_DAY, LINEUP_SIZE, firstFunding, gatherCase, hunterQuestion, readAnswer, scoreHunt, type LineupEntry } from "../src/aihunt.js";
import { newId } from "../src/db.js";
import { Pacer } from "../src/huntmap.js";
import { buildServer } from "../src/index.js";
import { NearAi, checkProof, recoverSigner, sha256Hex, type Answer } from "../src/nearai.js";
import { testConfig } from "./helpers.js";
import { addUser, addWallet, harness, T0 } from "./world.js";

const PAYER = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const noWait = (now: () => number) => new Pacer(400, now, async () => {});

/** A throwaway enclave key and the address it signs as. */
const ENCLAVE = new Uint8Array(32).fill(7);
const ENCLAVE_ADDR = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(ENCLAVE, false).subarray(1)).slice(-20)).toString("hex");
function sign(text: string, key = ENCLAVE): string {
  const msg = Buffer.from(text);
  const d = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]));
  const s = secp256k1.sign(d, key);
  return "0x" + s.toCompactHex() + (27 + s.recovery).toString(16);
}

describe("NEAR AI answer proof", () => {
  it("recovers the enclave's address from its signature", () => {
    expect(recoverSigner("hello", sign("hello"))).toBe(ENCLAVE_ADDR);
    expect(recoverSigner("hello", "0x1234")).toBeNull();
  });

  it("holds only when the hashes, the signature and the attestation all agree", () => {
    const req = '{"q":1}';
    const res = '{"a":2}';
    const text = `m/x:${sha256Hex(req)}:${sha256Hex(res)}`;
    const signed = { text, signature: sign(text), signingAddress: ENCLAVE_ADDR };
    expect(checkProof("m/x", req, res, signed, [ENCLAVE_ADDR.toUpperCase().replace("0X", "0x")])).toEqual({ hashesMatch: true, signatureValid: true, inAttestation: true });
    // an answer edited after the enclave signed it
    expect(checkProof("m/x", req, '{"a":3}', signed, [ENCLAVE_ADDR]).hashesMatch).toBe(false);
    // a signature by some other key
    expect(checkProof("m/x", req, res, { ...signed, signature: sign(text, new Uint8Array(32).fill(9)) }, [ENCLAVE_ADDR]).signatureValid).toBe(false);
    // a signer that is not in the hardware attestation
    expect(checkProof("m/x", req, res, signed, ["0x" + "12".repeat(20)]).inAttestation).toBe(false);
    expect(checkProof("m/x", req, res, null, [])).toEqual({ hashesMatch: false, signatureValid: false, inAttestation: false });
  });

  it("asks NEAR AI Cloud, then fetches and checks the signature and the attestation", async () => {
    const seen: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      if (url.endsWith("/chat/completions")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
        const body = String(init!.body);
        expect(JSON.parse(body)).toMatchObject({ model: "m/x", response_format: { type: "json_object" } });
        (f as any).req = body;
        (f as any).res = JSON.stringify({ id: "chat-1", choices: [{ message: { content: '{"same_owner":[]}' } }] });
        return new Response((f as any).res);
      }
      if (url.includes("/signature/chat-1")) {
        const text = `m/x:${sha256Hex((f as any).req)}:${sha256Hex((f as any).res)}`;
        return new Response(JSON.stringify({ text, signature: sign(text), signing_address: ENCLAVE_ADDR, signing_algo: "ecdsa" }));
      }
      if (url.includes("/attestation/report")) return new Response(JSON.stringify({ model_attestations: [{ signing_address: ENCLAVE_ADDR }] }));
      throw new Error(url);
    }) as typeof fetch;
    const a = await new NearAi("sk-test", "https://nearai.test/v1", f, "m/x").chatJson("sys", "user");
    expect(a.content).toBe('{"same_owner":[]}');
    expect(a.proof.checks).toEqual({ hashesMatch: true, signatureValid: true, inAttestation: true });
    expect(a.proof.requestSha256).toBe(sha256Hex(a.request));
    expect(seen).toHaveLength(3);
  });

  it("keeps the answer and says so when the signature cannot be fetched", async () => {
    const f = (async (url: string) => {
      if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({ id: "c2", choices: [{ message: { content: "{}" } }] }));
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const a = await new NearAi("k", "https://nearai.test/v1", f, "m/x").chatJson("s", "u");
    expect(a.proof.signed).toBeNull();
    expect(a.proof.checks.signatureValid).toBe(false);
  });

  it("names a failed request plainly", async () => {
    const f = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(new NearAi("k", "https://nearai.test/v1", f).chatJson("s", "u")).rejects.toThrow("NEAR AI Cloud answered HTTP 401.");
  });
});

/**
 * Hyperliquid's public API for a payer that funded the owner's pieces among many strangers.
 * The owner's pieces trade ETH with 7 fills each; strangers near them hold ETH or nothing.
 */
function fakeInfo(pieces: string[], over: { strangers?: number; sendBetween?: boolean } = {}) {
  const strangers = Array.from({ length: over.strangers ?? 60 }, (_, i) => addr(0x1000 + i));
  const fundedAt = new Map<string, number>();
  pieces.forEach((p, i) => fundedAt.set(p, T0 - 3_600_000 * (i + 1)));
  strangers.forEach((s, i) => fundedAt.set(s, T0 - 3_600_000 * ((i % pieces.length) + 1) + (i + 1) * 1000));
  const asked: any[] = [];
  const info = async (b: any) => {
    asked.push(b);
    const user = String(b.user ?? "").toLowerCase();
    const send = (to: string) => ({ time: fundedAt.get(to)!, delta: { type: "send", user: PAYER, destination: to, token: "USDC", amount: "15", usdcValue: "15" } });
    if (b.type === "userNonFundingLedgerUpdates") {
      if (user === PAYER) return [...fundedAt.keys()].filter((a) => fundedAt.get(a)! >= b.startTime && fundedAt.get(a)! <= b.endTime).map(send);
      const own = [send(user)];
      if (over.sendBetween && (user === pieces[0] || user === pieces[1])) own.push({ time: T0, delta: { type: "send", user: pieces[0]!, destination: pieces[1]!, token: "USDC", amount: "1", usdcValue: "1" } });
      return own;
    }
    if (b.type === "clearinghouseState") {
      const n = parseInt(user.slice(-4), 16);
      const eth = pieces.includes(user) || n % 2 === 0;
      return {
        marginSummary: { accountValue: "15" },
        assetPositions: eth ? [{ position: { coin: "ETH", szi: "0.004", leverage: { type: "isolated", value: 3 }, entryPx: "2500", positionValue: "10", liquidationPx: "1700" } }] : [],
      };
    }
    if (b.type === "frontendOpenOrders") return [];
    if (b.type === "userFillsByTime") {
      const k = pieces.includes(user) ? 7 : 2;
      return Array.from({ length: k }, (_, i) => ({ coin: "ETH", side: "B", px: "2500", sz: "0.004", time: T0 - i * 60_000, dir: "Open Long" }));
    }
    throw new Error(`unexpected ${b.type}`);
  };
  return { info, asked, strangers };
}

const deps = (info: (b: any) => Promise<any>) => ({ info, pacer: noWait(() => T0), now: () => T0, random: (n: number) => new Uint8Array(n).map((_, i) => (i * 37) & 0xff) });

describe("the hunt's lineup", () => {
  const P = [addr(0xa1), addr(0xb2), addr(0xc3)];

  it("starts from one piece and hides the owner's other pieces among the payer's other accounts", async () => {
    const w = fakeInfo(P);
    const { hunt, lineup } = await gatherCase(deps(w.info), "ETH", P);
    expect(lineup).toHaveLength(LINEUP_SIZE);
    expect(lineup.filter((l) => l.yours).map((l) => l.address).sort()).toEqual([P[1], P[2]]);
    expect(lineup.map((l) => l.label)).toEqual(Array.from({ length: LINEUP_SIZE }, (_, i) => `L${i + 1}`));
    expect(lineup.some((l) => l.address === P[0])).toBe(false);
    // decoys are the payer's accounts, preferring ones in the same market
    const strangers = lineup.filter((l) => !l.yours);
    expect(strangers.every((l) => w.strangers.includes(l.address))).toBe(true);
    expect(strangers.every((l) => parseInt(l.address.slice(-4), 16) % 2 === 0)).toBe(true);
    expect(hunt.target.funding).toEqual({ by: "P1", minutesAfterT: 0, usd: 15 });
    expect(hunt.payers).toEqual([{ label: "P1", accountsFundedNearT: expect.any(Number) }]);
  });

  it("never shows the model an address, and never says which accounts are the owner's", async () => {
    const w = fakeInfo(P, { sendBetween: true });
    const { hunt, lineup } = await gatherCase(deps(w.info), "ETH", P);
    const q = hunterQuestion(hunt);
    expect(q).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(q).not.toMatch(/yours/);
    // a send between two pieces is public, so the hunter sees it
    const b = lineup.find((l) => l.address === P[1])!.label;
    expect(hunt.target.sendsTo).toEqual([b]);
    expect(hunt.lineup.find((p) => p.label === b)!.sendsFrom).toEqual(["T"]);
  });

  it("reads Hyperliquid only with public, keyless questions", async () => {
    const w = fakeInfo(P);
    await gatherCase(deps(w.info), "ETH", P);
    expect(new Set(w.asked.map((b) => b.type))).toEqual(new Set(["userNonFundingLedgerUpdates", "clearinghouseState", "frontendOpenOrders", "userFillsByTime"]));
  });

  it("needs two pieces", async () => {
    await expect(gatherCase(deps(fakeInfo(P).info), "ETH", [P[0]!])).rejects.toThrow("at least two pieces");
  });

  it("reads who first paid an account, bridge deposits included", () => {
    expect(firstFunding(P[0]!, [{ time: 5, delta: { type: "send", user: PAYER, destination: P[0], amount: "2.5" } }])).toEqual({ payer: PAYER, atMs: 5, usd: 2.5 });
    expect(firstFunding(P[0]!, [{ time: 9, delta: { type: "deposit", usdc: "100" } }])).toEqual({ payer: "bridge", atMs: 9, usd: 100 });
    expect(firstFunding(P[0]!, [])).toBeNull();
  });
});

describe("scoring the hunter", () => {
  const lineup: LineupEntry[] = Array.from({ length: 10 }, (_, i) => ({ label: `L${i + 1}`, address: addr(i), yours: i < 2 }));
  const named = (...labels: string[]) => ({ picks: labels.map((label) => ({ label, confidence: 80, why: "" })), combined: { side: null, usd: null }, stopGuess: null, stopWhy: "", summary: "" });

  it("caught: every piece named and mostly right", () => {
    expect(scoreHunt(lineup, named("L1", "L2"))).toMatchObject({ verdict: "caught", found: 2, pieces: 2, wrong: 0 });
    expect(scoreHunt(lineup, named("L1", "L2", "L3")).verdict).toBe("caught");
  });
  it("partly: some pieces named, mostly right", () => {
    expect(scoreHunt(lineup, named("L2")).verdict).toBe("partly");
  });
  it("held: nothing named, mostly wrong, or naming everyone", () => {
    expect(scoreHunt(lineup, named()).verdict).toBe("held");
    expect(scoreHunt(lineup, named("L1", "L5", "L6")).verdict).toBe("held");
    const all = scoreHunt(lineup, named(...lineup.map((l) => l.label)));
    expect(all).toMatchObject({ verdict: "held", found: 2, wrong: 8, chanceHits: 2 });
  });
  it("reads the model's answer leniently and drops labels that are not in the lineup", () => {
    const a = readAnswer('```json\n{"same_owner":[{"label":"l2","confidence":"90","why":"x"},{"label":"L99"},{"label":"L2"}],"combined":{"side":"Short","usd":"40"},"stop_guess":"2600"}\n```', new Set(["L1", "L2"]));
    expect(a.picks).toEqual([{ label: "L2", confidence: 90, why: "x" }]);
    expect(a.combined).toEqual({ side: "short", usd: 40 });
    expect(a.stopGuess).toBe(2600);
    expect(readAnswer("not json", new Set(["L1"])).picks).toEqual([]);
  });
});

/** A model that names every lineup account with the owner's fill count, so the truth can be checked end to end. */
function fakeAi(onlyLabels?: string[]) {
  let calls = 0;
  let open: () => void = () => {};
  let held = Promise.resolve();
  const ai = {
    /** Hold the next answers until release() is called. */
    hold() {
      held = new Promise((r) => (open = r));
    },
    release() {
      open();
    },
    get calls() {
      return calls;
    },
    async chatJson(system: string, user: string): Promise<Answer> {
      calls++;
      await held;
      expect(system).toMatch(/liquidation hunter/);
      const picks = user
        .split("\n")
        .filter((l) => l.startsWith("{") && l.includes('"fills14d":7'))
        .map((l) => JSON.parse(l).label as string)
        .filter((l) => !onlyLabels || onlyLabels.includes(l));
      const content = JSON.stringify({ same_owner: picks.map((label) => ({ label, confidence: 90, why: "same fills" })), combined: { side: "long", usd: 30 }, stop_guess: 2400, stop_why: "below entry", summary: "found them" });
      return {
        content,
        request: `{"q":"${user.length}"}`,
        response: content,
        proof: { model: "m/x", chatId: "chat-9", requestSha256: "aa", responseSha256: "bb", signed: null, checks: { hashesMatch: true, signatureValid: true, inAttestation: true } },
      };
    },
  };
  return ai;
}

function setupHunter(pieceCount = 3) {
  const h = harness();
  const alice = addUser(h);
  const bob = addUser(h, "bob.near");
  const ws = Array.from({ length: pieceCount }, (_, i) => addWallet(h, alice.userId, `piece-${i}`));
  const positionId = newId();
  h.db
    .prepare("INSERT INTO positions (id, user_id, coin, side, notional_usd, leverage, hiding, state, created_ms, network) VALUES (?, ?, 'ETH', 'long', 30, 3, 'normal', 'open', ?, 'mainnet')")
    .run(positionId, alice.userId, T0);
  ws.forEach((w, i) =>
    h.db
      .prepare("INSERT INTO position_pieces (id, position_id, piece_id, idx, size, funding_usd, entry_offset_ms, state, created_ms, network) VALUES (?, ?, ?, ?, 0.004, 10, 0, 'open', ?, 'mainnet')")
      .run(newId(), positionId, w.id, i, T0),
  );
  const pieces = ws.map((w) => w.address.toLowerCase());
  const world = fakeInfo(pieces);
  const ai = fakeAi();
  const hunter = new AiHunter(h.db, { info: world.info }, ai, "mainnet", h.ctx.now, h.ctx.random, noWait(h.ctx.now));
  const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx, aiHunter: hunter });
  const call = (method: "GET" | "POST", url: string, cookie = alice.cookie) => app.inject({ method, url, headers: { cookie } });
  return { h, alice, bob, positionId, hunter, ai, call, pieces };
}

describe("AI hunts in the app", () => {
  it("runs a hunt on the owner's position and shows what the hunter named against the truth", async () => {
    const s = setupHunter();
    s.ai.hold();
    const start = await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`);
    expect(start.statusCode, start.body).toBe(200);
    expect((await s.call("GET", `/api/positions/${s.positionId}/ai-hunt`)).json().hunt.state).toBe("running");
    s.ai.release();
    await s.hunter.idle();
    const v = (await s.call("GET", `/api/positions/${s.positionId}/ai-hunt`)).json().hunt;
    expect(v.state).toBe("done");
    expect(v.score).toMatchObject({ verdict: "caught", found: 2, pieces: 2, wrong: 0, lineup: LINEUP_SIZE });
    expect(v.lineup.filter((l: any) => l.yours).map((l: any) => l.address).sort()).toEqual([s.pieces[1], s.pieces[2]].sort());
    expect(v.answer.stopGuess).toBe(2400);
    expect(v.truth).toEqual({ side: "long", usd: 30 });
    expect(v.proof.checks).toEqual({ hashesMatch: true, signatureValid: true, inAttestation: true });
    expect(v.hunts).toEqual({ today: 1, perDay: HUNTS_PER_USER_PER_DAY });
    const receipt = await s.call("GET", `/api/positions/${s.positionId}/ai-hunt/${v.id}/receipt`);
    expect(receipt.statusCode).toBe(200);
    expect(receipt.headers["content-disposition"]).toContain(`ai-hunt-${v.id}.json`);
    expect(receipt.json()).toMatchObject({ request: expect.any(String), response: expect.stringContaining("same_owner"), proof: { chatId: "chat-9" } });
  });

  it("keeps hunts to the owner", async () => {
    const s = setupHunter();
    expect((await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`, s.bob.cookie)).statusCode).toBe(404);
    expect((await s.call("GET", `/api/positions/${s.positionId}/ai-hunt`, s.bob.cookie)).statusCode).toBe(404);
    expect((await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`, "")).statusCode).toBe(401);
    await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`);
    await s.hunter.idle();
    const id = (await s.call("GET", `/api/positions/${s.positionId}/ai-hunt`)).json().hunt.id;
    expect((await s.call("GET", `/api/positions/${s.positionId}/ai-hunt/${id}/receipt`, s.bob.cookie)).statusCode).toBe(404);
  });

  it("runs one hunt at a time and a few per day", async () => {
    const s = setupHunter();
    s.ai.hold();
    await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`);
    const busy = await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("ai_hunt_busy");
    s.ai.release();
    await s.hunter.idle();
    for (let i = 1; i < HUNTS_PER_USER_PER_DAY; i++) {
      await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`);
      await s.hunter.idle();
    }
    const over = await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`);
    expect(over.statusCode).toBe(429);
    expect(over.json().message).toBe(`You have used today's ${HUNTS_PER_USER_PER_DAY} AI hunts. More open in 24 hours.`);
    s.h.clock.t += 86_400_001;
    expect((await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`)).statusCode).toBe(200);
    await s.hunter.idle();
  });

  it("refuses a position with one piece", async () => {
    const s = setupHunter(1);
    const r = await s.call("POST", `/api/positions/${s.positionId}/ai-hunt`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("ai_hunt_needs_pieces");
    expect(s.ai.calls).toBe(0);
  });

  it("records a failed hunt with a plain reason, and a restart ends a running one", async () => {
    const s = setupHunter();
    const broken = new AiHunter(s.h.db, { info: async () => { throw new Error("Hyperliquid answered HTTP 429."); } }, s.ai, "mainnet", s.h.ctx.now, s.h.ctx.random, noWait(s.h.ctx.now));
    broken.start(s.alice.userId, s.positionId);
    await broken.idle();
    expect(broken.latest(s.alice.userId, s.positionId)).toMatchObject({ state: "failed", error: "Hyperliquid answered HTTP 429." });
    s.h.db.prepare("UPDATE ai_hunts SET state = 'running', error = NULL").run();
    new AiHunter(s.h.db, { info: async () => [] }, s.ai, "mainnet", s.h.ctx.now);
    expect(broken.latest(s.alice.userId, s.positionId)).toMatchObject({ state: "failed", error: "The server restarted during this hunt. Run it again." });
  });

  it("serves no hunt routes when the hunter is off", async () => {
    const h = harness();
    const alice = addUser(h);
    const app = buildServer({ config: testConfig(), db: h.db, now: h.ctx.now, money: h.ctx });
    const r = await app.inject({ method: "GET", url: `/api/positions/${newId()}/ai-hunt`, headers: { cookie: alice.cookie } });
    expect(r.statusCode).toBe(404);
  });
});
