// Reference: EAS SDK signs the same attestation with test key 0x22…22.
const { Offchain, SchemaEncoder, OffchainAttestationVersion } = require("@ethereum-attestation-service/eas-sdk");
const { Wallet, ZeroAddress, ZeroHash, solidityPackedKeccak256 } = require("ethers");
(async () => {
const SCHEMA = "uint64 asOf,uint32 shards,int64 equityMicroUsd,int64 netDepositsMicroUsd,int64 pnlMicroUsd,string outlayerCall";
const uid = solidityPackedKeccak256(["string","address","bool"], [SCHEMA, ZeroAddress, false]);
const enc = new SchemaEncoder(SCHEMA);
const data = enc.encodeData([
  { name: "asOf", value: 1793700000n, type: "uint64" }, { name: "shards", value: 2, type: "uint32" },
  { name: "equityMicroUsd", value: 2669202n, type: "int64" }, { name: "netDepositsMicroUsd", value: 2678831n, type: "int64" },
  { name: "pnlMicroUsd", value: -9629n, type: "int64" }, { name: "outlayerCall", value: "00000000-0000-4000-8000-000000000001", type: "string" }]);
const off = new Offchain({ address: "0x4200000000000000000000000000000000000021", version: "1.0.1", chainId: 8453n }, OffchainAttestationVersion.Version2);
const w = new Wallet("0x" + "22".repeat(32));
const att = await off.signOffchainAttestation({ schema: uid, recipient: ZeroAddress, time: 1793700100n, expirationTime: 0n,
  revocable: false, refUID: ZeroHash, data, salt: "0x" + "ab".repeat(32) }, w, { verifyOnchain: false });
console.log(JSON.stringify({ schemaUid: uid, data, signature: att.signature, uid: att.uid }));
})();
