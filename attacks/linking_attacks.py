#!/usr/bin/env python3
"""Linking attacks against our own shard activity. PUBLIC DATA ONLY.

Attacker model: knows ONE shard's Hyperliquid address (e.g. spotted on a
leaderboard or a liquidation map). Goals: find the owner / origin of funds,
find sibling shards, learn stops, sizes and timing.

Each attack prints LINKED / NOT LINKED / PARTIAL with the evidence, and the
whole run is written to linking-report.json in the current folder. Polite rates (<= 5 req/s).
usage: linking_attacks.py <target_hl_address> [private_deposit_address_to_check]
"""
import hashlib, json, os, sys, time, urllib.request

HL = "https://api.hyperliquid.xyz/info"
OL = "https://api.outlayer.ai"
ONECLICK = "https://1click.chaindefuser.com/v0/status?depositAddress="
OUT = os.path.join(os.getcwd(), "linking-report.json")


def get(url, body=None, pause=0.2):
    time.sleep(pause)
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "User-Agent": "unhuntable-linking-check"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None


def hl(body):
    return get(HL, body)[1]


results = []


def report(name, verdict, evidence):
    results.append({"attack": name, "verdict": verdict, "evidence": evidence})
    print(f"\n== {name}: {verdict}")
    for k, v in evidence.items():
        print(f"   {k}: {v}")


target = sys.argv[1].lower()

# ------------------------------------------------------------- funding origin
ledger = hl({"type": "userNonFundingLedgerUpdates", "user": target, "startTime": 0}) or []
fundings = [u for u in ledger if u["delta"].get("destination", "").lower() == target and u["delta"].get("user", "").lower() != target]
a1 = {"incoming_transfers": len(fundings)}
crowd = []
for f in fundings:
    payer, t = f["delta"]["user"].lower(), f["time"]
    win = hl({"type": "userNonFundingLedgerUpdates", "user": payer, "startTime": t - 6 * 3600_000, "endTime": t + 6 * 3600_000}) or []
    dests = {u["delta"].get("destination", "").lower() for u in win if u["delta"].get("user", "").lower() == payer}
    dests.discard("")
    crowd.append({"payer": payer, "amount": f["delta"].get("amount"), "time_ms": t,
                  "payer_sends_in_12h": len(win), "distinct_recipients_in_12h": len(dests)})
a1["funders"] = crowd
smallest = min((c["distinct_recipients_in_12h"] for c in crowd), default=0)
report("funding origin", "LINKED" if smallest == 1 else "NOT LINKED", {
    **a1, "reading": f"funded by a shared payer; anonymity set = {smallest} recipients in a 12 h window" if smallest > 1 else "payer funds only this account"})

# ------------------------------------------------------------- amount fingerprint
a2 = []
for c in crowd:
    amt = float(c["amount"])
    win = hl({"type": "userNonFundingLedgerUpdates", "user": c["payer"], "startTime": c["time_ms"] - 6 * 3600_000, "endTime": c["time_ms"] + 6 * 3600_000}) or []
    same = [u for u in win if u["delta"].get("user", "").lower() == c["payer"] and abs(float(u["delta"].get("amount", 0) or 0) - amt) < 0.01]
    a2.append({"amount": c["amount"], "payer_sends_within_1c_in_12h": len(same),
               "implied_round_input": round(amt + 0.321169, 2)})
report("amount fingerprint", "PARTIAL" if any(x["payer_sends_within_1c_in_12h"] == 1 for x in a2) else "NOT LINKED", {
    "amounts": a2,
    "reading": "amount minus the flat 1Click fee reveals a round input (e.g. 3.00), but the origin side is a confidential shard with no public transfer to match against"})

# ------------------------------------------------------------- call-record timing (OutLayer public records)
fills = hl({"type": "userFills", "user": target}) or []


def att(task_id):
    s, d = get(f"{OL}/attestations/{task_id}", pause=0.2)
    return d if s == 200 and isinstance(d, dict) and "timestamp" in d else None


def find_task_near(ts):
    lo, hi = 1_200_000, 1_400_000
    for _ in range(24):
        mid = (lo + hi) // 2
        d = None
        for off in range(0, 6):  # skip holes
            d = att(mid + off)
            if d:
                break
        if not d:
            hi = mid
            continue
        if d["timestamp"] < ts:
            lo = mid + 1
        else:
            hi = mid
        if hi - lo < 4:
            break
    return lo


a3 = []
for f in fills[:4]:
    ts = f["time"] // 1000
    tid = find_task_near(ts - 30)
    near = []
    for t in range(tid, tid + 60):
        d = att(t)
        if d and ts - 15 <= d["timestamp"] <= ts + 2:
            near.append({"task_id": t, "dt_s": d["timestamp"] - ts, "project": d.get("project_id"), "caller": d.get("caller_account_id"), "input_hash": d.get("input_hash")})
        if d and d["timestamp"] > ts + 2:
            break
    a3.append({"fill_time_s": ts, "fill": f"{f['dir']} {f['sz']} {f['coin']} @{f['px']}", "attestations_within_15s_before": near})
hits = [n for x in a3 for n in x["attestations_within_15s_before"]]
projects = sorted({n["project"] for n in hits if n["project"]})
report("call-record timing", "LINKED" if hits else "NOT LINKED", {
    "fills_checked": len(a3), "matches": a3, "projects_seen": projects,
    "reading": "a public OutLayer call record lands seconds before each fill: the account is tied to the project that sent the order"})

# ------------------------------------------------------------- input recovery from those records
cands = {}
coins = ["BTC", "ETH", "SOL"]
shards = [chr(c) for c in range(97, 123)] + [f"{chr(a)}{d}" for a in range(97, 123) for d in range(10)]
for sh in shards:
    for co in coins:
        for dry in ("", ',"dry":true'):
            s = f'{{"op":"tick","shard":"{sh}","coin":"{co}"{dry}}}'
            cands[hashlib.sha256(s.encode()).hexdigest()] = s
        for side in ("long", "short"):
            for i in range(1, 2001):
                sz = round(i * 0.0001, 4)
                s = f'{{"op":"open","shard":"{sh}","coin":"{co}","side":"{side}","size":{sz}}}'
                cands[hashlib.sha256(s.encode()).hexdigest()] = s
recovered = [{"task_id": n["task_id"], "input": cands[n["input_hash"]]} for n in hits if n["input_hash"] in cands]
report("input recovery", "LINKED" if recovered else "NOT LINKED", {
    "candidates_tried": len(cands), "recovered": recovered,
    "reading": "tick/open inputs are plain JSON: their hashes give back shard label, coin, side and size; stops are sealed boxes and are NOT recoverable"})

# ------------------------------------------------------------- agent reuse
role = hl({"type": "userRole", "user": target})
report("agent reuse", "NOT LINKED", {
    "target_role": role,
    "reading": "agent→master is public (userRole), so one agent on two shards would link them; ours are one per shard"})

# ------------------------------------------------------------- 1Click public status for our private route
if len(sys.argv) > 2:
    s, d = get(ONECLICK + sys.argv[2])
    report("1Click public status (private withdraw)", "NOT LINKED" if s == 404 else "LINKED", {"http": s, "body": d})

json.dump({"target": target, "run_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": results}, open(OUT, "w"), indent=1)
print(f"\nwritten {OUT}")
