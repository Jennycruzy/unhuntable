#!/usr/bin/env python3
"""Encrypt a stop to the guard's box key. Prints the guard input JSON.
usage: seal.py <box_pub_hex> <shard> <coin> <long|short> <trigger> <size>"""
import sys, json, os, hashlib
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives import serialization
gpk = bytes.fromhex(sys.argv[1]); shard, coin, side = sys.argv[2], sys.argv[3], sys.argv[4]
trigger, size = float(sys.argv[5]), float(sys.argv[6])
esk = X25519PrivateKey.generate()
epk = esk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
key = hashlib.sha256(b"unhuntable-box-v1" + esk.exchange(X25519PublicKey.from_public_bytes(gpk)) + epk + gpk).digest()
nonce = os.urandom(12)
pt = json.dumps({"coin": coin, "side": side, "trigger": trigger, "size": size}).encode()
ct = ChaCha20Poly1305(key).encrypt(nonce, pt, shard.encode())
print(json.dumps({"op": "seal", "shard": shard, "box": {"epk": epk.hex(), "nonce": nonce.hex(), "ct": ct.hex()}}))
