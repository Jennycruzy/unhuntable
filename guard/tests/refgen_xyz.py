# trade.xyz (HIP-3 dex "xyz"): isolated leverage and an opening order on NVDA (asset 110000 + 2).
import json
from eth_account import Account
from hyperliquid.utils.signing import sign_l1_action, order_request_to_order_wire, order_wires_to_order_action
w = Account.from_key("0x" + "22"*32)
out = {"addr": w.address.lower()}
lev = {"type": "updateLeverage", "asset": 110002, "isCross": False, "leverage": 5}
out["lev"] = {"action": lev, "nonce": 1730000000020, "sig": sign_l1_action(w, dict(lev), None, 1730000000020, None, True)}
o = order_request_to_order_wire({"coin":"x","is_buy":False,"sz":0.112,"limit_px":172.93,"order_type":{"limit":{"tif":"Ioc"}},"reduce_only":False}, 110002)
a = order_wires_to_order_action([o], None)
out["open"] = {"action": a, "nonce": 1730000000021, "sig": sign_l1_action(w, a, None, 1730000000021, None, True)}
print(json.dumps(out, indent=1))
