#!/usr/bin/env python3
"""Hyperliquid MASTER actions for a shard, signed by the shard's OutLayer wallet
(/wallet/v1/evm/sign-typed-data). Every signature is recovered locally with the
official SDK and must equal the shard's EVM address before anything is sent.
usage: hlmaster.py <keyfile> approve_agent <agent_addr>
       hlmaster.py <keyfile> approve_builder <builder_addr> <maxFeeRate e.g. 0.01%>
       hlmaster.py <keyfile> class_transfer <amount> <to_perp true|false>
       hlmaster.py <keyfile> spot_send <destination> <amount>
       hlmaster.py <keyfile> state
add --dry to sign + verify without sending."""
import os, sys, json, time, uuid, requests
from hyperliquid.utils.signing import recover_user_from_user_signed_action
HOME = os.environ.get("UNHUNTABLE_PRIVATE", os.path.expanduser("~/unhuntable-private"))
kf, cmd, args = sys.argv[1], sys.argv[2], [a for a in sys.argv[3:] if a != "--dry"]
dry = "--dry" in sys.argv
api = json.load(open(f"{HOME}/keys/{kf}"))["api_key"]
H = {"Authorization": f"Bearer {api}", "Content-Type": "application/json"}
me = requests.get("https://api.outlayer.ai/wallet/v1/address?chain=base", headers=H).json()["address"].lower()
HL = "https://api.hyperliquid.xyz"
USDC_SPOT = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"

def log(rec):
    rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()); rec["wallet"] = kf
    open(f"{HOME}/g0/hl-master.jsonl", "a").write(json.dumps(rec) + "\n")

if cmd == "state":
    for t in ("clearinghouseState", "spotClearinghouseState"):
        print(t, json.dumps(requests.post(f"{HL}/info", json={"type": t, "user": me}).json())[:600])
    print("extraAgents", requests.post(f"{HL}/info", json={"type": "extraAgents", "user": me}).json())
    print("maxBuilderFee", requests.post(f"{HL}/info", json={"type": "maxBuilderFee", "user": me, "builder": os.environ.get("UNHUNTABLE_BUILDER", "0x" + "0" * 40)}).json())
    sys.exit()

n = int(time.time() * 1000)
if cmd == "approve_agent":
    primary = "HyperliquidTransaction:ApproveAgent"
    types = [{"name":"hyperliquidChain","type":"string"},{"name":"agentAddress","type":"address"},{"name":"agentName","type":"string"},{"name":"nonce","type":"uint64"}]
    action = {"type":"approveAgent","agentAddress":args[0].lower(),"agentName":"","nonce":n}
elif cmd == "approve_builder":
    primary = "HyperliquidTransaction:ApproveBuilderFee"
    types = [{"name":"hyperliquidChain","type":"string"},{"name":"maxFeeRate","type":"string"},{"name":"builder","type":"address"},{"name":"nonce","type":"uint64"}]
    action = {"type":"approveBuilderFee","maxFeeRate":args[1],"builder":args[0].lower(),"nonce":n}
elif cmd == "class_transfer":
    primary = "HyperliquidTransaction:UsdClassTransfer"
    types = [{"name":"hyperliquidChain","type":"string"},{"name":"amount","type":"string"},{"name":"toPerp","type":"bool"},{"name":"nonce","type":"uint64"}]
    action = {"type":"usdClassTransfer","amount":args[0],"toPerp":args[1]=="true","nonce":n}
elif cmd == "spot_send":
    primary = "HyperliquidTransaction:SpotSend"
    types = [{"name":"hyperliquidChain","type":"string"},{"name":"destination","type":"string"},{"name":"token","type":"string"},{"name":"amount","type":"string"},{"name":"time","type":"uint64"}]
    action = {"type":"spotSend","destination":args[0].lower(),"token":USDC_SPOT,"amount":args[1],"time":n}
else:
    sys.exit("unknown command")
action["signatureChainId"] = "0x66eee"; action["hyperliquidChain"] = "Mainnet"
msg = {t["name"]: action[t["name"]] for t in types}
td = {"domain":{"name":"HyperliquidSignTransaction","version":"1","chainId":421614,"verifyingContract":"0x0000000000000000000000000000000000000000"},
      "types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}], primary: types},
      "primaryType": primary, "message": msg}
r = requests.post("https://api.outlayer.ai/wallet/v1/evm/sign-typed-data", headers={**H, "X-Idempotency-Key": str(uuid.uuid4())}, json={"chain":"arbitrum","typed_data":td}).json()
sig = r["signature"]; s = {"r":"0x"+sig[2:66], "s":"0x"+sig[66:130], "v":int(sig[130:132],16)}
rec_addr = recover_user_from_user_signed_action(dict(action), s, types, primary, True).lower()
print("signer", rec_addr, "wallet", me, "MATCH" if rec_addr == me else "MISMATCH")
if rec_addr != me:
    sys.exit("signature does not recover to the wallet; nothing sent")
if dry:
    print("dry: not sent", json.dumps(action)); sys.exit()
resp = requests.post(f"{HL}/exchange", json={"action": action, "nonce": n, "signature": s})
print("HL", resp.status_code, resp.text[:400])
log({"cmd": cmd, "action": action, "http": resp.status_code, "resp": resp.text[:400]})
