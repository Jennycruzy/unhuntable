#!/usr/bin/env bash
# Tests scripts/check-repo.sh in a throwaway git repo.
# Banned words and labels are built at run time (split with "+") so this file passes the check itself.
# usage: scripts/test-check-repo.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

git init -q -b main .
git config user.name alice
git config user.email alice@example.invalid
git config commit.gpgsign false
mkdir -p scripts src
cp "$here/check-repo.sh" scripts/
echo "Plain words about what this does." > README.md
echo "export const total = 1;" > src/a.ts
git add -A
git commit -q -m "Add readme and source"
base=$(git rev-parse HEAD)

failures=0
w() { printf '%s' "${1//+/}"; }

run() { scripts/check-repo.sh "$@" 2>&1; }

expect() {
  local want=$1 name=$2 out code
  shift 2
  out=$(run "$@")
  code=$?
  if [ "$want" = pass ] && [ $code -eq 0 ] && grep -q '^check-repo: clean$' <<<"$out"; then
    echo "ok   $name"
  elif [ "$want" = fail ] && [ $code -ne 0 ] && grep -q '^FAIL: ' <<<"$out"; then
    echo "ok   $name"
  else
    echo "BAD  $name (wanted $want, exit $code)"; echo "$out" | sed 's/^/     /'
    failures=$((failures + 1))
  fi
}

# Track one file for a single check, then put the repo back.
with_file() {
  local want=$1 name=$2 path=$3 content=$4
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$content" > "$path"
  git add -- "$path"
  expect "$want" "$name"
  git rm -q -f --cached -- "$path" >/dev/null
  rm -f -- "$path"
}

expect pass "clean repo" "$base..HEAD"

for word in mile+stone mile+stones ga+te ga+tes pha+se pha+ses check+point check+points au+dit au+dits \
  sp+ec sp+ecs TO+DO place+holder place+holders "com+ing soon" "no+t yet" mo+ck mo+cks st+ub st+ubs pend+ing; do
  with_file fail "banned word in prose: $(w "$word")" docs/note.md "This line has the $(w "$word") word in it."
done
with_file fail "banned word in any case" docs/note.md "$(w Mile+Stone) reached."

with_file pass "longer identifiers pass" src/b.ts "const aggregate = navigate(refill_pending, pendingCount);"
with_file pass "$(w mo+ck) inside test/ passes" test/helper.ts "// a $(w mo+ck) fetch for tests"
with_file pass "$(w st+ub) inside tests/ passes" guard/tests/x.rs "// $(w st+ub) answer"
with_file pass "$(w mo+ck) in a .test.ts file passes" src/a.test.ts "// $(w mo+ck) fetch"
with_file fail "$(w mo+ck) in src/ fails" src/b.ts "// $(w mo+ck) fetch"
with_file pass "quoted $(w pend+ing) passes" src/b.ts "const s = \"$(w pend+ing)\"; const t = '$(w pend+ing)';"
with_file fail "$(w pend+ing) in prose fails" src/b.ts "// the order is $(w pend+ing) until filled"
with_file fail "quoted and bare $(w pend+ing) on one line fails" src/b.ts "if (s === \"$(w pend+ing)\") return; // still $(w pend+ing)"

with_file fail "file name with a version label" "$(w report_v+0.py)" "print(1)"
with_file fail "file name with -v label" "$(w notes-v+2.md)" "Plain."
with_file fail "file name with G label" "$(w G+1/run.sh)" "echo"
with_file fail "file name with A label" "$(w attacks_A+4.py)" "print(1)"
with_file fail "file name with a date" "$(w report-20+26-11-03.md)" "Plain."
with_file pass "ordinary file names pass" guard/tests/ref3.json "{}"

git commit -q --allow-empty -m "Release $(w v+1.2) of the client"
expect fail "commit message with a version tag" "$base..HEAD"
git reset -q --hard "$base"
git commit -q --allow-empty -m "Add the $(w check+point) code"
expect fail "commit message with a banned word" "$base..HEAD"
git reset -q --hard "$base"
git commit -q --allow-empty -m "Add the planner" -m "$(w Gener+ated by) [Claude Code](https://$(w claude+.ai/code)/session_x)"
expect fail "commit message with an attribution footer" "$base..HEAD"
git reset -q --hard "$base"
git commit -q --allow-empty -m "Add the planner"
expect pass "plain commit message" "$base..HEAD"
git reset -q --hard "$base"

printf 'Add the planner\n\nIt splits a position.\n\n---\n_%s [Claude Code](https://%s/session_x)_\n' "$(w Gener+ated by)" "$(w claude+.ai/code)" > "$tmp/pr-attrib.md"
expect fail "--text with an attribution footer" --text "$tmp/pr-attrib.md"
printf 'Add a fix\n\n%s\n' "$(w Co+-Authored-By): someone" > "$tmp/pr-coauthor.md"
expect fail "--text with a co-author line" --text "$tmp/pr-coauthor.md"
printf 'Add a fix\n\nThis is %s.\n' "$(w "no+t yet") done" > "$tmp/pr-word.md"
expect fail "--text with a banned word" --text "$tmp/pr-word.md"
printf 'Add a fix for %s\n' "$(w v+0.4)" > "$tmp/pr-label.md"
expect fail "--text with a version label" --text "$tmp/pr-label.md"
printf 'Add the planner\n\nIt splits a position into pieces. Status can be "%s".\n' "$(w pend+ing)" > "$tmp/pr-plain.md"
expect pass "--text with a plain body" --text "$tmp/pr-plain.md"
expect fail "--text with a missing file" --text "$tmp/none.md"

if [ $failures -ne 0 ]; then
  echo "test-check-repo: $failures wrong"
  exit 1
fi
echo "test-check-repo: all good"
