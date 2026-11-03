import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SignTypedDataVersion, TypedDataUtils, recoverTypedSignature, signTypedData } from "@metamask/eth-sig-util";
import { describe, expect, it } from "vitest";
import {
  actionHash,
  approveBuilderFee,
  asset,
  closeOrder,
  exchangeBody,
  floatToWire,
  l1TypedData,
  msgpack,
  openOrder,
  orderAction,
  roundPx,
  roundSz,
  spotSend,
  splitSignature,
  typedDataDigest,
  typedDataJson,
  updateLeverageAction,
  usdClassTransfer,
  type TypedData,
  type Value,
} from "../src/hyperliquid.js";

const ref = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../guard/tests/${name}`, import.meta.url)), "utf8"));
const KEY_11 = new Uint8Array(32).fill(0x11); // throwaway
const KEY_22 = new Uint8Array(32).fill(0x22); // throwaway

function sign(digest: Uint8Array, key: Uint8Array) {
  const s = secp256k1.sign(digest, key);
  return { r: s.r, s: s.s, v: 27 + s.recovery };
}

/** Compare r and s as numbers: the Python SDK drops leading zeros. */
function sameSig(got: { r: bigint; s: bigint; v: number }, want: { r: string; s: string; v: number }) {
  expect(got.r).toBe(BigInt(want.r));
  expect(got.s).toBe(BigInt(want.s));
  expect(got.v).toBe(want.v);
}

function evmAddress(key: Uint8Array): string {
  return "0x" + bytesToHex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(12));
}

describe("numbers like the guard", () => {
  it("wire format and rounding", () => {
    expect(floatToWire(2187.3)).toBe("2187.3");
    expect(floatToWire(0.00011)).toBe("0.00011");
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(-0)).toBe("0");
    expect(roundPx(2187.3456, 4)).toBe(2187.3);
    expect(roundPx(104321.7, 5)).toBe(104322);
    expect(roundPx(99999.75, 5)).toBe(100000);
    expect(roundSz(0.00519, 4)).toBe(0.0051);
  });

  it("msgpack uses the smallest forms", () => {
    expect(bytesToHex(msgpack({ a: 1, b: true, s: "x" }))).toBe("83a16101a162c3a173a178");
    expect(bytesToHex(msgpack(200))).toBe("ccc8");
    expect(bytesToHex(msgpack(70000))).toBe("ce00011170");
    expect(bytesToHex(msgpack(1730000000000))).toBe("cf00000192cc091400");
    expect(bytesToHex(msgpack("a".repeat(40))).slice(0, 4)).toBe("d928");
  });
});

describe("order signatures match the reference SDK (guard/tests/ref.json)", () => {
  const r = ref("ref.json");
  const builder = "0x1234567890abcdef1234567890abcdef12345678";
  const ours = [
    [orderAction(asset("ETH")!, false, 2187.3, 0.0051), 1730000000000],
    [orderAction(asset("ETH")!, true, 2316.6, 0.0123, { builder: { address: builder, fee: 10 } }), 1730000000001],
    [orderAction(asset("BTC")!, false, 104321.0, 0.00011), 1730000000002],
  ] as const;

  it("uses the same throwaway key", () => {
    expect(evmAddress(KEY_11)).toBe(r.addr);
  });

  ours.forEach(([action, nonce], i) => {
    it(`order ${i}`, () => {
      expect(action).toEqual(r.cases[i].action);
      expect(nonce).toBe(r.cases[i].nonce);
      sameSig(sign(typedDataDigest(l1TypedData(action, nonce)), KEY_11), r.cases[i].sig);
    });
  });

  it("builder fee approval", () => {
    const b = approveBuilderFee("0.01%", builder, 1730000000003);
    sameSig(sign(typedDataDigest(b.typed), KEY_11), r.builder_fee.sig);
    expect(b.action).toMatchObject({ type: "approveBuilderFee", maxFeeRate: "0.01%", builder, nonce: 1730000000003 });
  });
});

describe("agent key leverage and open match the reference SDK (guard/tests/ref3.json)", () => {
  const r = ref("ref3.json");
  it("uses the same throwaway key", () => {
    expect(evmAddress(KEY_22)).toBe(r.addr);
  });
  it("updateLeverage", () => {
    const lev = updateLeverageAction(asset("ETH")!, 10);
    expect(lev).toEqual(r.lev.action);
    sameSig(sign(typedDataDigest(l1TypedData(lev, 1730000000010)), KEY_22), r.lev.sig);
  });
  it("open: buy 0.0045 ETH, mid 2263.1068, 3% through", () => {
    const op = openOrder(asset("ETH")!, true, 2263.1068, 0.0045);
    expect(op).toEqual(r.open.action);
    sameSig(sign(typedDataDigest(l1TypedData(op, 1730000000011)), KEY_22), r.open.sig);
  });
});

describe("user-signed transfers against an independent EIP-712 implementation (eth-sig-util)", () => {
  const V4 = SignTypedDataVersion.V4;

  async function check(td: TypedData) {
    const data = typedDataJson(td) as never;
    // same digest
    expect(bytesToHex(typedDataDigest(td))).toBe(Buffer.from(TypedDataUtils.eip712Hash(data, V4)).toString("hex"));
    // same signature as eth-sig-util's signer with the throwaway key
    const theirs = splitSignature(signTypedData({ privateKey: Buffer.from(KEY_22), data, version: V4 }));
    const ours = sign(typedDataDigest(td), KEY_22);
    expect(BigInt(theirs.r)).toBe(ours.r);
    expect(BigInt(theirs.s)).toBe(ours.s);
    expect(theirs.v).toBe(ours.v);
    const sigHex = "0x" + ours.r.toString(16).padStart(64, "0") + ours.s.toString(16).padStart(64, "0") + ours.v.toString(16);
    expect(recoverTypedSignature({ data, signature: sigHex, version: V4 })).toBe(evmAddress(KEY_22));
  }

  it("UsdClassTransfer", async () => {
    const t = usdClassTransfer("12.345678", false, 1730000000020);
    expect(t.action).toEqual({
      type: "usdClassTransfer",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0x66eee",
      amount: "12.345678",
      toPerp: false,
      nonce: 1730000000020,
    });
    expect(t.typed.domain).toEqual({ name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(t.typed.types["HyperliquidTransaction:UsdClassTransfer"].map((f) => f.name)).toEqual(["hyperliquidChain", "amount", "toPerp", "nonce"]);
    await check(t.typed);
  });

  it("SpotSend", async () => {
    const t = spotSend("0xABCDEF0123456789ABCDEF0123456789ABCDEF01", "10.5", 1730000000030);
    expect(t.action).toEqual({
      type: "spotSend",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0x66eee",
      destination: "0xabcdef0123456789abcdef0123456789abcdef01",
      token: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054",
      amount: "10.5",
      time: 1730000000030,
    });
    expect(t.typed.types["HyperliquidTransaction:SpotSend"].map((f) => f.name)).toEqual(["hyperliquidChain", "destination", "token", "amount", "time"]);
    await check(t.typed);
  });

  it("L1 Agent typed data agrees too", async () => {
    await check(l1TypedData(closeOrder(asset("SOL")!, -3.25, 151.37), 1730000000040));
  });
});

describe("closing orders and posting", () => {
  it("closes a long by selling 3% under mid and a short by buying 3% over, reduce-only IOC", () => {
    expect(closeOrder(asset("ETH")!, 0.0051, 2255)).toEqual({
      type: "order",
      orders: [{ a: 1, b: false, p: floatToWire(roundPx(2255 * 0.97, 4)), s: "0.0051", r: true, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    });
    const short = closeOrder(asset("BTC")!, -0.00011, 100000);
    expect((short.orders as Value[])[0]).toMatchObject({ a: 0, b: true, p: "103000", s: "0.00011", r: true });
  });

  it("splits OutLayer signatures and builds exchange bodies", () => {
    const sig = splitSignature("0x" + "11".repeat(32) + "22".repeat(32) + "1c");
    expect(sig).toEqual({ r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32), v: 28 });
    expect(splitSignature("0x" + "11".repeat(64) + "00").v).toBe(27);
    expect(() => splitSignature("0x12")).toThrow();
    const a = closeOrder(asset("ETH")!, 1, 2000);
    expect(exchangeBody(a, 5, sig, true)).toEqual({ action: a, nonce: 5, signature: sig, vaultAddress: null });
    expect("vaultAddress" in exchangeBody(a, 5, sig, false)).toBe(false);
    expect(bytesToHex(actionHash(a, 5))).toHaveLength(64);
  });
});
