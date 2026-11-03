#!/usr/bin/env python3
"""Wrap a guard call in a sealed box. Adds a random 32-byte salt.
usage: gbox.py '<plain json input>'  → prints {"box":{...}} for tools/gcall.sh"""
import sys, json, os, hashlib
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives import serialization
GPK = bytes.fromhex("4ce000976eed106c7e738ef4419fcf1cfa7ccca273740e6dc645d77f67276367")  # guard box_pub
inner = json.loads(sys.argv[1]); inner["salt"] = os.urandom(32).hex()
esk = X25519PrivateKey.generate()
epk = esk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
key = hashlib.sha256(b"unhuntable-box-v1" + esk.exchange(X25519PublicKey.from_public_bytes(GPK)) + epk + GPK).digest()
nonce = os.urandom(12)
ct = ChaCha20Poly1305(key).encrypt(nonce, json.dumps(inner).encode(), b"unhuntable-call-v1")
print(json.dumps({"box": {"epk": epk.hex(), "nonce": nonce.hex(), "ct": ct.hex()}}))
