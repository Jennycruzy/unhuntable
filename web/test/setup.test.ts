import { describe, expect, it } from "vitest";
import { keyFromMnemonic, ownerAccount, readAuthHeader, verifyText } from "unhuntable-client/keys";
import { Api } from "../lib/api";
import { checkWords, linkPiecesKey, makeBalanceWallet, newMnemonic, pickPositions, restoreKey } from "../lib/setup";
import { forgetPiecesKey, loadPiecesKey, savePiecesKey } from "../lib/vault";
import { scriptedFetch } from "./helpers";

const KEY_HASH = "ab".repeat(32);

function outlayerAndApi() {
  return scriptedFetch([
    ["POST /api/pieces-key", { body: { ok: true } }],
    ["GET /wallet/v1/address", { status: 404, body: { error: "not_found", message: "no such wallet" } }],
    ["POST /register", { body: { wallet_id: "w1", near_account_id: "w1.outlayer.near" } }],
    ["POST /api/wallets/key", { body: { requestId: "r1", keyHash: KEY_HASH } }],
    ["PUT /wallet/v1/api-key", { body: { wallet_id: "w1", near_account_id: "w1.outlayer.near" } }],
    ["POST /api/wallets/confirm", { body: { ok: true, label: "balance", address: "w1.outlayer.near" } }],
  ]);
}

describe("pieces key setup", () => {
  // a phrase of words that cannot turn up by chance in our JSON, plus a fresh random one
  it.each(["legal winner thank year wave sausage worth useful legal winner thank yellow", newMnemonic()])("never sends the 12 words or the secret key anywhere", async (words) => {
    const key = keyFromMnemonic(words);
    const { fetch, sent, left } = outlayerAndApi();
    const api = new Api(fetch, "https://api.example");
    await savePiecesKey("alice.near", key);
    await linkPiecesKey({ api, key, account: "alice.near", now: () => 1_800_000_000_000 });
    const address = await makeBalanceWallet({ api, key, account: "alice.near", outlayerFetch: fetch });
    expect(address).toBe("w1.outlayer.near");
    expect(left).toHaveLength(0);

    // the wallets belong to the key's own implicit account, not to alice.near
    const signed = sent.filter((s) => s.headers?.authorization);
    expect(signed.length).toBeGreaterThan(0);
    for (const s of signed) expect(readAuthHeader(s.headers.authorization).account_id).toBe(ownerAccount(key));
    const reg = JSON.parse(sent.find((s) => s.url.endsWith("/register"))!.body);
    expect(reg.account_id).toBe(ownerAccount(key));

    const secrets = [key.secretKeyStr, key.secretKeyStr.slice(8), Buffer.from(key.secret).toString("hex"), Buffer.from(key.secret).toString("base64")];
    const everything = sent.map((s) => `${s.url}\n${JSON.stringify(s.headers)}\n${s.body}`).join("\n");
    const list = words.split(" ");
    expect(everything).not.toContain(words);
    // no two words of the phrase in a row, joined any way
    for (let i = 0; i + 1 < list.length; i++) expect(everything).not.toMatch(new RegExp(`\\b${list[i]}\\W{1,4}${list[i + 1]}\\b`));
    if (words.startsWith("legal")) for (const w of list) expect(everything).not.toMatch(new RegExp(`\\b${w}\\b`));
    for (const s of secrets) expect(everything).not.toContain(s);
    // the server got only the public key, a signed note for alice.near, and the wallet's seed
    const proof = JSON.parse(sent.find((s) => s.url.endsWith("/api/pieces-key"))!.body);
    expect(Object.keys(proof).sort()).toEqual(["message", "publicKey", "signature"]);
    expect(proof.publicKey).toBe(key.publicKeyStr);
    expect(proof.message).toBe("pieces-key:alice.near:1800000000");
    expect(verifyText(key.publicKeyStr, proof.message, proof.signature)).toBe(true);
  });

  it("the 3-word check refuses a wrong word", () => {
    const words = newMnemonic();
    const list = words.split(" ");
    const pos = pickPositions();
    expect(new Set(pos).size).toBe(3);
    expect(pos.every((p) => p >= 0 && p < 12)).toBe(true);
    expect(checkWords(words, pos, pos.map((p) => list[p]))).toBe(true);
    expect(checkWords(words, pos, pos.map((p) => ` ${list[p].toUpperCase()} `))).toBe(true);
    const wrong = pos.map((p) => list[p]);
    wrong[1] = list[pos[1]] === "zoo" ? "abandon" : "zoo";
    expect(checkWords(words, pos, wrong)).toBe(false);
    expect(checkWords(words, pos, ["", "", ""])).toBe(false);
    expect(checkWords(words, pos, pos.slice(0, 2).map((p) => list[p]))).toBe(false);
  });

  it("restore from the words gives the same public key", () => {
    const words = newMnemonic();
    expect(restoreKey(words.toUpperCase()).publicKeyStr).toBe(keyFromMnemonic(words).publicKeyStr);
    expect(() => restoreKey("one two three")).toThrow("Those words are not a valid 12-word phrase.");
  });

  it("keeps the key on this device encrypted, and forgets it", async () => {
    const key = keyFromMnemonic(newMnemonic());
    await savePiecesKey("bob.near", key);
    expect((await loadPiecesKey("bob.near"))!.publicKeyStr).toBe(key.publicKeyStr);
    // what IndexedDB holds is ciphertext, and the AES key cannot be exported
    const raw = await new Promise<{ iv: Uint8Array; ct: ArrayBuffer }>((resolve) => {
      const r = indexedDB.open("unhuntable", 1);
      r.onsuccess = () => {
        const g = r.result.transaction("kv").objectStore("kv").get("pieces:bob.near");
        g.onsuccess = () => resolve(g.result);
      };
    });
    expect(Buffer.from(raw.ct).includes(Buffer.from(key.secret))).toBe(false);
    const aes = await new Promise<CryptoKey>((resolve) => {
      const r = indexedDB.open("unhuntable", 1);
      r.onsuccess = () => {
        const g = r.result.transaction("kv").objectStore("kv").get("aes-key");
        g.onsuccess = () => resolve(g.result);
      };
    });
    expect(aes.extractable).toBe(false);
    await forgetPiecesKey("bob.near");
    expect(await loadPiecesKey("bob.near")).toBeUndefined();
  });
});
