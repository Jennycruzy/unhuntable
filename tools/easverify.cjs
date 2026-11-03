// Verify a guard proof with the official EAS SDK and print an easscan link.
// usage: node easverify.cjs <gcall output file>
const fs = require("fs");
const { Offchain, OffchainAttestationVersion, SchemaEncoder, createOffchainURL } = require("@ethereum-attestation-service/eas-sdk");
const { ZeroAddress, ZeroHash, verifyTypedData } = require("ethers");
const t = fs.readFileSync(process.argv[2], "utf8"); const j = JSON.parse(t.slice(0, t.lastIndexOf("}") + 1));
const e = j.output.eas;
const off = new Offchain({ address: e.contract, version: e.version, chainId: BigInt(e.chainId) }, OffchainAttestationVersion.Version2);
const message = { version: 2, schema: e.schemaUid, recipient: ZeroAddress, time: BigInt(e.time), expirationTime: 0n,
  revocable: false, refUID: ZeroHash, data: e.data, salt: e.salt };
const types = { Attest: [ { name: "version", type: "uint16" }, { name: "schema", type: "bytes32" }, { name: "recipient", type: "address" },
  { name: "time", type: "uint64" }, { name: "expirationTime", type: "uint64" }, { name: "revocable", type: "bool" },
  { name: "refUID", type: "bytes32" }, { name: "data", type: "bytes" }, { name: "salt", type: "bytes32" } ] };
const domain = off.getDomainTypedData();
const sig = { r: e.signature.r, s: e.signature.s, v: e.signature.v };
const recovered = verifyTypedData(domain, types, message, sig);
const uid = Offchain.getOffchainUID(2, e.schemaUid, ZeroAddress, BigInt(e.time), 0n, false, ZeroHash, e.data, e.salt);
const att = { domain, primaryType: "Attest", types, message, uid, version: 2, signature: sig };
const ok = off.verifyOffchainAttestationSignature(e.signer, att);
const decoded = new SchemaEncoder(e.schema).decodeData(e.data).map(x => [x.name, String(x.value.value)]);
const url = "https://base.easscan.org" + createOffchainURL({ sig: att, signer: e.signer });
console.log(JSON.stringify({ signer: e.signer, recovered, sdk_verify: ok, uid, decoded, url }, null, 1));
