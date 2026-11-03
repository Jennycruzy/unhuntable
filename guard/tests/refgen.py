import json
from eth_account import Account
from hyperliquid.utils.signing import sign_l1_action, sign_approve_builder_fee, order_request_to_order_wire, order_wires_to_order_action, float_to_wire
w = Account.from_key("0x" + "11"*32)
out = {"addr": w.address.lower(), "cases": []}
for (asset, is_buy, px, sz, builder, nonce) in [
    (1, False, 2187.3, 0.0051, None, 1730000000000),
    (1, True, 2316.6, 0.0123, {"b": "0x1234567890abcdef1234567890abcdef12345678", "f": 10}, 1730000000001),
    (0, False, 104321.0, 0.00011, None, 1730000000002),
]:
    o = order_request_to_order_wire({"coin":"x","is_buy":is_buy,"sz":sz,"limit_px":px,"order_type":{"limit":{"tif":"Ioc"}},"reduce_only":True}, asset)
    a = order_wires_to_order_action([o], builder)
    sig = sign_l1_action(w, a, None, nonce, None, True)
    out["cases"].append({"action": a, "nonce": nonce, "sig": sig})
bf = {"maxFeeRate": "0.01%", "builder": "0x1234567890abcdef1234567890abcdef12345678", "nonce": 1730000000003, "type": "approveBuilderFee"}
out["builder_fee"] = {"action": dict(bf), "sig": sign_approve_builder_fee(w, bf, True)}
print(json.dumps(out, indent=1))
