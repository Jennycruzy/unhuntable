// Reference: EAS SDK signs a trader record with test key 0x22…22 (guard test trader_record_matches_sdk).
const { Offchain, SchemaEncoder, OffchainAttestationVersion } = require("@ethereum-attestation-service/eas-sdk");
const { Wallet, ZeroAddress, ZeroHash, solidityPackedKeccak256 } = require("ethers");
(async () => {
const SCHEMA = "uint64 asOf,bytes32 trader,uint32 shards,int64 equityMicroUsd,int64 netDepositsMicroUsd,int64 pnlMicroUsd,string outlayerCall";
const uid = solidityPackedKeccak256(["string","address","bool"], [SCHEMA, ZeroAddress, false]);
const enc = new SchemaEncoder(SCHEMA);
const data = enc.encodeData([
  { name: "asOf", value: 1794500000n, type: "uint64" }, { name: "trader", value: "0x" + "5a".repeat(32), type: "bytes32" },
  { name: "shards", value: 3, type: "uint32" }, { name: "equityMicroUsd", value: 36120000n, type: "int64" },
  { name: "netDepositsMicroUsd", value: 36000000n, type: "int64" }, { name: "pnlMicroUsd", value: 120000n, type: "int64" },
  { name: "outlayerCall", value: "00000000-0000-4000-8000-000000000002", type: "string" }]);
const off = new Offchain({ address: "0x4200000000000000000000000000000000000021", version: "1.0.1", chainId: 8453n }, OffchainAttestationVersion.Version2);
const w = new Wallet("0x" + "22".repeat(32));
const att = await off.signOffchainAttestation({ schema: uid, recipient: ZeroAddress, time: 1794500100n, expirationTime: 0n,
  revocable: false, refUID: ZeroHash, data, salt: "0x" + "cd".repeat(32) }, w, { verifyOnchain: false });
console.log(JSON.stringify({ schemaUid: uid, data, signature: att.signature, uid: att.uid }));
})();
