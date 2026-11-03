#!/usr/bin/env bash
# Repo hygiene check, run by CI on every push and pull request (and by hand before a commit).
# Fails on: internal working labels, AI attribution, and key material.
# usage: scripts/check-repo.sh [commit-range]   e.g. origin/main..HEAD
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

MONTHS='Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'
LABELS="(\\bv[0-9]+\\.[0-9]+(\\.[0-9]+)?\\b|\\bG[0-9](\\.[0-9]+)?\\b|_v[0-9]\\b|\\bA[1-9]\\b|\\b[0-9]{1,2} ($MONTHS)\\b)"
ATTRIB='(co-authored-by|generated with \[?claude|noreply@anthropic\.com)'
SECRETS='(wk_[0-9a-f]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(api_key|private_key|secret_key|payment_key)"[[:space:]]*:[[:space:]]*"[^"]{8,}")'

fail=0
files=$(git ls-files | grep -v -E '(^|/)(Cargo\.lock|package-lock\.json)$|^scripts/check-repo\.sh$')

check_files() {
  local name=$1 pattern=$2 flags=$3
  local hits
  hits=$(echo "$files" | xargs -r grep -n -I $flags -E "$pattern" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "FAIL: $name in files:"; echo "$hits"; fail=1
  fi
}
check_files "internal label" "$LABELS" ""
check_files "AI attribution" "$ATTRIB" "-i"
check_files "key material" "$SECRETS" ""

range=${1:-}
if [ -n "$range" ]; then
  msgs=$(git log --format='%H%n%B' "$range" 2>/dev/null || true)
  if echo "$msgs" | grep -n -E "$LABELS"; then echo "FAIL: internal label in commit messages ($range)"; fail=1; fi
  if echo "$msgs" | grep -n -i -E "$ATTRIB"; then echo "FAIL: AI attribution in commit messages ($range)"; fail=1; fi
fi

[ $fail -eq 0 ] && echo "check-repo: clean"
exit $fail
