#!/usr/bin/env bash
# Repo hygiene check, run by CI on every push and pull request (and by hand before a commit).
# Fails on: internal working labels, AI attribution, key material, banned words,
# and labels in file names.
# usage: scripts/check-repo.sh [commit-range]   e.g. origin/main..HEAD
#        scripts/check-repo.sh --text <file>    check one text file, such as a pull request title and body
set -uo pipefail

text_file=""
if [ "${1:-}" = "--text" ]; then
  if [ -z "${2:-}" ] || [ ! -f "$2" ]; then echo "FAIL: --text needs a file to check"; exit 2; fi
  text_file=$2
fi

MONTHS='Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec'
LABELS="(\\bv[0-9]+\\.[0-9]+(\\.[0-9]+)?\\b|\\bG[0-9](\\.[0-9]+)?\\b|_v[0-9]\\b|\\bA[1-9]\\b|\\b[0-9]{1,2} ($MONTHS)\\b)"
ATTRIB='(co-authored-by|generated with \[?claude|noreply@anthropic\.com)'
SECRETS='(wk_[0-9a-f]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(api_key|private_key|secret_key|payment_key)"[[:space:]]*:[[:space:]]*"[^"]{8,}")'

# Banned words, matched as whole words, any case. grep -w treats letters, digits and _ as
# word characters, so longer identifiers (aggregate, refill_pending, pendingCount) never match.
WORDS='milestones?|gates?|phases?|checkpoints?|audits?|specs?|todo|placeholders?|coming soon|not yet'
# Allowed in test code only.
TEST_WORDS='mocks?|stubs?'
TEST_PATHS='(^|/)tests?/|\.test\.ts$'
# Labels in file paths: _v0, -v2, G1, A4 style tokens and dates.
PATH_LABELS='(^|[^A-Za-z0-9])(v[0-9]+|[GA][0-9]+)([^A-Za-z0-9]|$)|[0-9]{4}-[0-9]{2}-[0-9]{2}'
# Field names of outside APIs that look like labels; removed from a line before the label check.
# payload_v2: the request field of NEAR's MPC signer (v1.signer sign).
# 1cs_v1: 1Click's asset id prefix for native coins, as PingPay's offers name them.
EXTERNAL_NAMES='payload_v2|1cs_v1'
# Wider attribution set for pull request text.
TEXT_ATTRIB='(co-authored-by|generated (with|by)|claude\.ai/code|noreply@anthropic\.com)'

fail=0

report() {
  local name=$1 hits=$2
  if [ -n "$hits" ]; then
    echo "FAIL: $name"; echo "$hits"; fail=1
  fi
}

# "pending" passes as a quoted status value ("pending" or 'pending'); anywhere else in prose it fails.
# Reads grep -n output; $1 is how many "<field>:" prefixes come before the line text.
bare_pending() {
  local skip=$1 l body i
  while IFS= read -r l; do
    body=$l
    for ((i = 0; i < skip; i++)); do body=${body#*:}; done
    body=$(printf '%s\n' "$body" | sed -E "s/[\"']pending[\"']//gI")
    if printf '%s\n' "$body" | grep -q -i -w 'pending'; then printf '%s\n' "$l"; fi
  done
}

# Banned words in text read from stdin (commit messages, pull request text).
words_in_text() {
  local t; t=$(cat)
  printf '%s\n' "$t" | grep -n -i -w -E "$WORDS|$TEST_WORDS" || true
  printf '%s\n' "$t" | grep -n -i -w 'pending' | bare_pending 1
}

if [ -n "$text_file" ]; then
  report "internal label in $text_file:" "$(grep -n -E "$LABELS" "$text_file" || true)"
  report "AI attribution in $text_file:" "$(grep -n -i -E "$TEXT_ATTRIB" "$text_file" || true)"
  report "banned word in $text_file:" "$(words_in_text < "$text_file")"
  [ $fail -eq 0 ] && echo "check-repo: clean"
  exit $fail
fi

cd "$(git rev-parse --show-toplevel)"

# exit/exit.js is the generated exit page bundle; its sources are checked, and CI rebuilds it and fails if it differs.
files=$(git ls-files | grep -v -E '(^|/)(Cargo\.lock|package-lock\.json)$|^scripts/check-repo\.sh$|^exit/exit\.js$')

check_files() {
  local name=$1 pattern=$2 flags=$3
  local hits
  hits=$(echo "$files" | xargs -r grep -n -I $flags -E "$pattern" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "FAIL: $name in files:"; echo "$hits"; fail=1
  fi
}
label_hits=$(echo "$files" | xargs -r grep -n -I -E "$LABELS" 2>/dev/null | while IFS= read -r l; do
  body=${l#*:}; body=${body#*:}
  if printf '%s\n' "$body" | sed -E "s/$EXTERNAL_NAMES//g" | grep -q -E "$LABELS"; then printf '%s\n' "$l"; fi
done)
report "internal label in files:" "$label_hits"
check_files "AI attribution" "$ATTRIB" "-i"
check_files "key material" "$SECRETS" ""

word_hits=$(
  echo "$files" | xargs -r grep -n -I -i -w -E "$WORDS" 2>/dev/null
  echo "$files" | grep -v -E "$TEST_PATHS" | xargs -r grep -n -I -i -w -E "$TEST_WORDS" 2>/dev/null
  echo "$files" | xargs -r grep -n -I -i -w 'pending' 2>/dev/null | bare_pending 2
)
report "banned word in files:" "$word_hits"
report "internal label in file names:" "$(git ls-files | grep -E "$PATH_LABELS" || true)"

range=${1:-}
if [ -n "$range" ]; then
  msgs=$(git log --format='%H%n%B' "$range" 2>/dev/null || true)
  if echo "$msgs" | grep -n -E "$LABELS"; then echo "FAIL: internal label in commit messages ($range)"; fail=1; fi
  if echo "$msgs" | grep -n -i -E "$TEXT_ATTRIB"; then echo "FAIL: AI attribution in commit messages ($range)"; fail=1; fi
  report "banned word in commit messages ($range):" "$(printf '%s\n' "$msgs" | words_in_text)"
fi

[ $fail -eq 0 ] && echo "check-repo: clean"
exit $fail
