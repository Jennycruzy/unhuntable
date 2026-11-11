import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actionDigest,
  addressFromDerivedKey,
  borshAction,
  chainSigExchangeBody,
  chainSigMessage,
  chainSigPieceKey,
  controllerMessage,
  daoSignProposal,
  setControllerArgs,
  signAsControllerArgs,
  signControllerHandover,
  hlAction,
  messageArgs,
  mpcPath,
  mpcToHl,
  pieceKeyBytes,
  readCounter,
  readBuilder,
  readString,
  recoverSigner,
  signArgs,
  signPieceAction,
  verifyPieceAction,
  type ChainSigAction,
} from "../src/chainsig.js";
import { keyFromMnemonic } from "../src/keys.js";

const WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow";

// The signer contract's own vectors, checked there against Hyperliquid's Python SDK.
const vectors = JSON.parse(readFileSync(new URL("../../signer/src/hl_vectors.json", import.meta.url), "utf8"));

function fromRust(a: Record<string, Record<string, unknown>>): ChainSigAction {
  const [name, f] = Object.entries(a)[0] as [string, any];
  switch (name) {
    case "ApproveAgent":
      return { kind: "approveAgent", agentAddress: f.agent_address, agentName: f.agent_name, nonce: f.nonce };
    case "UsdClassTransfer":
      return { kind: "usdClassTransfer", amount: f.amount, toPerp: f.to_perp, nonce: f.nonce };
    case "SendAsset":
      return { kind: "sendAsset", destination: f.destination, sourceDex: f.source_dex, destinationDex: f.destination_dex, token: f.token, amount: f.amount, nonce: f.nonce };
    case "Withdraw":
      return { kind: "withdraw", destination: f.destination, amount: f.amount, time: f.time };
    case "SpotSend":
      return { kind: "spotSend", destination: f.destination, token: f.token, amount: f.amount, time: f.time };
    case "UsdSend":
      return { kind: "usdSend", destination: f.destination, amount: f.amount, time: f.time };
    case "ApproveBuilderFee":
      return { kind: "approveBuilderFee", maxFeeRate: f.max_fee_rate, builder: f.builder, nonce: f.nonce };
  }
  throw new Error(name);
}

// Piece C on mainnet: its key, its Hyperliquid account, and the approve-agent signature
// NEAR's MPC network made for it (NEAR tx 86qJbTWkiXwXsKfCCWqK63yLanzvkbxikMj1R4HfufVd).
const C = {
  keyHex: "06057e67832f63d857d3ff62405ccc2ff868a6f42fcb7eec749a4bbdb55badcc",
  account: "0x35c99eff31255e9ac3fc2a3c6e4dd70cb026b02a",
  derived: "secp256k1:2G5s5ziopmCDeBTmjDVbJvkjLb6RYvmdRprykiF7rxRf6Mh6e7X7jd1BYyEQgcdtwN1VJh21eLemBAFGAxPYwqWa",
  action: { kind: "approveAgent", agentAddress: "0x54a5cde6055a6cb5df793939776dbbb90d98c0ca", agentName: "", nonce: 1794063406712 } as ChainSigAction,
  message: "unhuntable-hl-v1:unhuntable.near:06057e67832f63d857d3ff62405ccc2ff868a6f42fcb7eec749a4bbdb55badcc:0:c45f974f68e1e72ad59bc2f1ee111502dedc978662ea0153e096345119c3deb5",
  mpc: {
    scheme: "Secp256k1",
    big_r: { affine_point: "039c1d3c5df7996e4846302ea7367154784d68a4b927364f39cbc10062e98f7e3e" },
    s: { scalar: "60108a4ead6c499fdf91977c1136a3c13d5d017ed9625984e6ae0770ab20125e" },
    recovery_id: 0,
  },
};

describe("hashes match the signer contract and Hyperliquid's SDK", () => {
  for (const net of ["mainnet", "testnet"] as const) {
    for (const c of vectors[net].cases) {
      it(`${net} ${c.name}`, () => {
        expect(bytesToHex(actionDigest(fromRust(c.action), vectors[net].hl_chain))).toBe(c.hash);
      });
    }
  }
});

describe("piece C on mainnet", () => {
  const pk = hexToBytes(C.keyHex);

  it("message is the text the contract asked piece C to sign", () => {
    expect(chainSigMessage("unhuntable.near", pk, 0, C.action)).toBe(C.message);
    expect(mpcPath(pk)).toBe("u1/" + C.keyHex);
  });

  it("v1.signer's derived key is piece C's Hyperliquid account", () => {
    expect(addressFromDerivedKey(C.derived)).toBe(C.account);
  });

  it("the MPC signature recovers to piece C's account and makes the body Hyperliquid accepted", () => {
    const body = chainSigExchangeBody(C.action, C.mpc, C.account);
    expect(body.signature).toEqual({ r: "0x9c1d3c5df7996e4846302ea7367154784d68a4b927364f39cbc10062e98f7e3e", s: "0x" + C.mpc.s.scalar, v: 27 });
    expect(body.nonce).toBe(1794063406712);
    expect(body.action).toEqual({
      type: "approveAgent",
      hyperliquidChain: "Mainnet",
      signatureChainId: "0x66eee",
      agentAddress: "0x54a5cde6055a6cb5df793939776dbbb90d98c0ca",
      agentName: "",
      nonce: 1794063406712,
    });
  });

  it("a signature for another account is refused before anything is sent", () => {
    expect(() => chainSigExchangeBody(C.action, C.mpc, "0x" + "1".repeat(40))).toThrow(/not the piece's account/);
    const other = { ...C.action, nonce: C.action.kind === "approveAgent" ? C.action.nonce + 1 : 0 } as ChainSigAction;
    expect(recoverSigner(actionDigest(other), mpcToHl(C.mpc))).not.toBe(C.account);
  });
});

describe("piece keys", () => {
  const key = keyFromMnemonic(WORDS);

  it("come from the 12 words, one per piece, the same every time", () => {
    const a = chainSigPieceKey(key, 0);
    expect(chainSigPieceKey(keyFromMnemonic(WORDS), 0).publicKeyStr).toBe(a.publicKeyStr);
    expect(chainSigPieceKey(key, 1).publicKeyStr).not.toBe(a.publicKeyStr);
    expect(a.publicKeyStr).not.toBe(key.publicKeyStr);
    expect(pieceKeyBytes(a.publicKeyStr)).toEqual(a.publicKey);
    expect(pieceKeyBytes(bytesToHex(a.publicKey))).toEqual(a.publicKey);
  });

  it("sign exactly the action, the contract and the counter", () => {
    const p = chainSigPieceKey(key, 3);
    const a: ChainSigAction = { kind: "withdraw", destination: "0x" + "ab".repeat(20), amount: "12.5", time: 1762500000000 };
    const sig = signPieceAction(p, "unhuntable.near", 4, a);
    expect(verifyPieceAction(p.publicKey, "unhuntable.near", 4, a, sig)).toBe(true);
    expect(verifyPieceAction(p.publicKey, "unhuntable.near", 5, a, sig)).toBe(false);
    expect(verifyPieceAction(p.publicKey, "other.near", 4, a, sig)).toBe(false);
    expect(verifyPieceAction(p.publicKey, "unhuntable.near", 4, { ...a, amount: "12.6" }, sig)).toBe(false);
    expect(verifyPieceAction(p.publicKey, "unhuntable.near", 4, { ...a, destination: "0x" + "cd".repeat(20) }, sig)).toBe(false);
  });
});

describe("borsh", () => {
  const pk = hexToBytes(C.keyHex);

  it("encodes the piece key as the contract reads it (u32 33, curve 0, 32 bytes)", () => {
    const b = messageArgs(pk, C.action);
    expect(bytesToHex(b.subarray(0, 6))).toBe("21000000" + "00" + "06");
    expect(b[37]).toBe(0); // ApproveAgent tag
  });

  it("encodes every action with its tag", () => {
    const tags = [
      { kind: "approveAgent", agentAddress: "0x" + "1".repeat(40), agentName: "", nonce: 1 },
      { kind: "usdClassTransfer", amount: "1", toPerp: true, nonce: 1 },
      { kind: "sendAsset", destination: "0x" + "1".repeat(40), sourceDex: "", destinationDex: "xyz", token: "USDC", amount: "1", nonce: 1 },
      { kind: "withdraw", destination: "0x" + "1".repeat(40), amount: "1", time: 1 },
      { kind: "spotSend", destination: "0x" + "1".repeat(40), token: "USDC", amount: "1", time: 1 },
      { kind: "usdSend", destination: "0x" + "1".repeat(40), amount: "1", time: 1 },
    ] as ChainSigAction[];
    tags.forEach((a, i) => expect(borshAction(a)[0]).toBe(i));
    expect(bytesToHex(borshAction(tags[1]))).toBe("01" + "01000000" + "31" + "01" + "0100000000000000");
  });

  it("puts a 64-byte signature last, with its length", () => {
    const b = signArgs(pk, C.action, new Uint8Array(64).fill(7));
    expect(bytesToHex(b.subarray(b.length - 68, b.length - 64))).toBe("40000000");
    expect(() => signArgs(pk, C.action, new Uint8Array(63))).toThrow(/64 bytes/);
  });

  it("reads the contract's answers", () => {
    expect(readCounter(new Uint8Array([0]))).toBeNull();
    expect(readCounter(new Uint8Array([1, 2, 0, 0, 0, 0, 0, 0, 0]))).toBe(2);
    expect(readString(new Uint8Array([2, 0, 0, 0, 0x75, 0x31]))).toBe("u1");
    expect(() => readString(new Uint8Array([9, 0, 0, 0, 0x75]))).toThrow();
  });

  it("refuses what the contract refuses", () => {
    expect(() => borshAction({ kind: "withdraw", destination: "0xAB" + "1".repeat(38), amount: "1", time: 1 })).toThrow(/lowercase/);
    expect(() => borshAction({ kind: "usdSend", destination: "0x" + "1".repeat(40), amount: "1e3", time: 1 })).toThrow(/plain decimal/);
    expect(() => borshAction({ kind: "sendAsset", destination: "0x" + "1".repeat(40), sourceDex: "XYZ", destinationDex: "", token: "USDC", amount: "1", nonce: 1 })).toThrow(/market list/);
  });
});

describe("Hyperliquid actions", () => {
  it("withdraw is posted as withdraw3 with time as its nonce", () => {
    const { action, nonce } = hlAction({ kind: "withdraw", destination: "0x" + "1".repeat(40), amount: "2", time: 99 });
    expect(action.type).toBe("withdraw3");
    expect(nonce).toBe(99);
  });
});

describe("builder fee", () => {
  const B = "0x" + "22".repeat(20);
  const a: ChainSigAction = { kind: "approveBuilderFee", maxFeeRate: "0.01%", builder: B, nonce: 1762500000009 };

  it("is tag 6 in borsh, in the contract's field order", () => {
    const b = borshAction(a);
    expect(b[0]).toBe(6);
    expect(bytesToHex(b)).toBe("06" + "05000000" + bytesToHex(new TextEncoder().encode("0.01%")) + "2a000000" + bytesToHex(new TextEncoder().encode(B)) + "09b92f5d9a010000");
  });

  it("is posted to Hyperliquid as approveBuilderFee", () => {
    expect(hlAction(a)).toEqual({
      action: { type: "approveBuilderFee", hyperliquidChain: "Mainnet", signatureChainId: "0x66eee", maxFeeRate: "0.01%", builder: B, nonce: 1762500000009 },
      nonce: 1762500000009,
    });
  });

  it("refuses any rate but one basis point, as the contract does", () => {
    for (const maxFeeRate of ["0.1%", "0.010%", "0.02%", "1%"]) expect(() => borshAction({ ...a, maxFeeRate })).toThrow(/exactly 0.01%/);
    expect(() => borshAction({ ...a, builder: "0x2222" })).toThrow(/address/);
  });

  it("reads the contract's builder answer", () => {
    const enc = (s: string) => {
      const b = new TextEncoder().encode(s);
      const n = new Uint8Array(4);
      new DataView(n.buffer).setUint32(0, b.length, true);
      return [...n, ...b];
    };
    expect(readBuilder(Uint8Array.from([1, ...enc(B), ...enc("0.01%")]))).toEqual({ builder: B, rate: "0.01%" });
    expect(readBuilder(Uint8Array.from([0]))).toBeNull();
    expect(() => readBuilder(Uint8Array.from([1, ...enc("nope"), ...enc("0.01%")]))).toThrow();
    expect(() => readBuilder(Uint8Array.from([1, ...enc(B)]))).toThrow();
  });
});

describe("treasury mode", () => {
  const piece = chainSigPieceKey(keyFromMnemonic(WORDS), 3);
  const DAO = "team.sputnikv2.testnet";

  it("signs the hand-over message the contract checks, with the piece's counter", () => {
    const m = controllerMessage("unhuntable.near", piece.publicKey, 4, DAO);
    expect(m).toBe(`unhuntable-controller-v1:unhuntable.near:${bytesToHex(piece.publicKey)}:4:${DAO}`);
    const sig = signControllerHandover(piece, "unhuntable.near", 4, DAO);
    expect(sig).toHaveLength(64);
    expect(() => controllerMessage("unhuntable.near", piece.publicKey, 4, "Not An Account")).toThrow(/NEAR account/);
  });

  it("encodes set_controller and sign_as_controller in the contract's borsh order", () => {
    const sig = signControllerHandover(piece, "unhuntable.near", 0, DAO);
    const a = setControllerArgs(piece.publicKey, DAO, sig);
    // piece key (4 + 33), controller (4 + len), signature (4 + 64)
    expect(a.length).toBe(37 + 4 + DAO.length + 68);
    expect(new TextDecoder().decode(a.subarray(41, 41 + DAO.length))).toBe(DAO);
    const act: ChainSigAction = { kind: "usdClassTransfer", amount: "5", toPerp: false, nonce: 9 };
    expect(bytesToHex(signAsControllerArgs(piece.publicKey, act))).toBe(bytesToHex(messageArgs(piece.publicKey, act)));
  });

  it("builds a Sputnik DAO proposal whose call is exactly sign_as_controller for the piece", () => {
    const act: ChainSigAction = { kind: "usdClassTransfer", amount: "5", toPerp: false, nonce: 9 };
    const p = daoSignProposal("unhuntable.near", piece.publicKey, act, "Move 5 USDC to spot");
    const call = p.proposal.kind.FunctionCall;
    expect(call.receiver_id).toBe("unhuntable.near");
    expect(call.actions).toHaveLength(1);
    expect(call.actions[0]).toMatchObject({ method_name: "sign_as_controller", deposit: "1", gas: "60000000000000" });
    expect(Buffer.from(call.actions[0].args, "base64").toString("hex")).toBe(bytesToHex(signAsControllerArgs(piece.publicKey, act)));
  });
});
