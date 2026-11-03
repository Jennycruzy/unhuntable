import json, hashlib, os
from eth_account import Account
from hyperliquid.utils.signing import sign_l1_action, order_request_to_order_wire, order_wires_to_order_action
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives import serialization
raw = lambda k: k.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
w = Account.from_key("0x" + "22"*32)
out = {"addr": w.address.lower()}
lev = {"type": "updateLeverage", "asset": 1, "isCross": True, "leverage": 10}
out["lev"] = {"action": lev, "nonce": 1730000000010, "sig": sign_l1_action(w, dict(lev), None, 1730000000010, None, True)}
o = order_request_to_order_wire({"coin":"x","is_buy":True,"sz":0.0045,"limit_px":2331.0,"order_type":{"limit":{"tif":"Ioc"}},"reduce_only":False}, 1)
a = order_wires_to_order_action([o], None)
out["open"] = {"action": a, "nonce": 1730000000011, "sig": sign_l1_action(w, a, None, 1730000000011, None, True)}
# sealed box: guard secret = 0x33*32 ; client side as the real client will do it
gsk = X25519PrivateKey.from_private_bytes(bytes([0x33])*32); gpk = raw(gsk.public_key())
esk = X25519PrivateKey.generate(); epk = raw(esk.public_key())
shared = esk.exchange(X25519PublicKey.from_public_bytes(gpk))
key = hashlib.sha256(b"unhuntable-box-v1" + shared + epk + gpk).digest()
nonce = os.urandom(12); pt = json.dumps({"coin":"ETH","side":"long","trigger":2100.5,"size":0.0045}).encode()
ct = ChaCha20Poly1305(key).encrypt(nonce, pt, b"a")
out["box"] = {"gpk": gpk.hex(), "epk": epk.hex(), "nonce": nonce.hex(), "ct": ct.hex(), "aad": "a", "pt": pt.decode()}
print(json.dumps(out, indent=1))
