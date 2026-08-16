#!/usr/bin/env bash
# Tests for lanes.sh, the engine this action ships.
#
# This suite is the only thing between a push here and every consumer's
# required check, so it runs the real engine — not a reimplementation of it —
# against a stubbed `gh`. Fixtures arrive as environment variables (FILES,
# SUBJECTS, CHANGED to override the changed_files count, *_FAIL to simulate
# API failures).
#
# Its own failure mode is a false pass, so every behavior is asserted in both
# directions: the case that must succeed and the case that must be refused.
set -u

here=$(cd "$(dirname "$0")" && pwd)
stub=$(mktemp -d)
cat > "$stub/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"/files"*)
    [ "${FILES_FAIL:-0}" = 1 ] && exit 1
    # Fixture entries are "newpath" or "newpath:oldpath" (a rename); emit the
    # same TSV shape the real --jq produces.
    for f in $FILES; do
      new=${f%%:*}; old=""
      [ "$f" = "$new" ] || old=${f#*:}
      printf '%s\t%s\n' "$new" "$old"
    done
    ;;
  *"/commits/"*"/pulls"*)
    [ "${PULLS_FAIL:-0}" = 1 ] && exit 1
    # Space-separated fixture of open-PR numbers heading this commit.
    for p in ${SHARED_PRS:-$PR}; do printf '%s\n' "$p"; done
    ;;
  *"/commits"*)
    [ "${COMMITS_FAIL:-0}" = 1 ] && exit 1
    # Fixture lines are "subject" (one parent) or "N:subject"; emit the same
    # parent-count TSV the real --jq produces.
    printf '%s\n' "$SUBJECTS" | while IFS= read -r s; do
      case "$s" in
        [0-9]:*) printf '%s\t%s\n' "${s%%:*}" "${s#*:}" ;;
        *) printf '1\t%s\n' "$s" ;;
      esac
    done
    ;;
  *".head.sha"*)
    [ "${HEAD_FAIL:-0}" = 1 ] && exit 1
    echo "${HEAD_SHA:-headsha}"
    ;;
  *".changed_files"*)
    if [ -n "${CHANGED:-}" ]; then echo "$CHANGED"; else echo $FILES | wc -w; fi
    ;;
  *".commits"*)
    if [ -n "${NCOMMITS:-}" ]; then echo "$NCOMMITS"; else printf '%s' "$SUBJECTS" | grep -c .; fi
    ;;
esac
EOF
chmod +x "$stub/gh"

# The default fixture policy: a Rust-shaped consumer, so the path cases below
# exercise an ordered rule (a crate tree wins over the markdown arm) rather
# than a single pattern that could not tell ordering bugs apart.
cat > "$stub/default.conf" <<'EOF'
is_docs() {
  case "$1" in
    crates/*) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}
LANE_PREFIXES="design docs todo test build refactor"
EOF

# A deliberately different policy, used only to prove the config is
# load-bearing. Without this the whole suite would still pass against an
# engine that ignored the config and hard-coded the default one -- the exact
# false pass this file exists to prevent.
cat > "$stub/other.conf" <<'EOF'
is_docs() {
  case "$1" in
    *.txt) return 0 ;;
    *) return 1 ;;
  esac
}
LANE_PREFIXES="notes"
EOF

# A config that loads but declares no policy, and one that declares paths but
# no prefixes. Both must be refused rather than silently meaning "nothing is
# docs" / "no subject can pass".
: > "$stub/empty.conf"
cat > "$stub/noprefix.conf" <<'EOF'
is_docs() { return 0; }
EOF

# A policy that claims everything is documentation, itself included. This is
# what a pull request would ship to buy its own skip, so the engine's refusal
# has to hold against it rather than against a well-behaved config.
cat > "$stub/hostile.conf" <<'EOF'
is_docs() { return 0; }
LANE_PREFIXES="docs"
EOF

# Configs that try to escape into the engine rather than merely lie to it.
# A sourced file IS the shell, so these are the shapes a path guard cannot
# see: argv, the environment the engine reads later, and the API client
# itself.
cat > "$stub/escape-argv.conf" <<'EOF'
is_docs() { return 1; }
LANE_PREFIXES="docs"
set -- classify
EOF
cat > "$stub/escape-env.conf" <<'EOF'
is_docs() { return 1; }
LANE_PREFIXES="docs"
CLASSIFY=success
RESULTS="everything=success"
EOF
cat > "$stub/escape-gh.conf" <<'EOF'
is_docs() { return 0; }
LANE_PREFIXES="docs"
gh() { echo 0; }
EOF

# A config that allows a dispatched run with no pull request.
cat > "$stub/dispatch-ok.conf" <<'EOF'
is_docs() { case "$1" in *.md) return 0 ;; *) return 1 ;; esac; }
LANE_PREFIXES="docs"
dispatch_without_pr_ok() { return 0; }
EOF

export PATH="$stub:$PATH" GITHUB_REPOSITORY=example/repo PR=1 \
       GITHUB_EVENT_NAME=pull_request GITHUB_SHA=headsha \
       GITHUB_REF=refs/pull/1/merge \
       LANES_CONFIG="$stub/default.conf"

fails=0
# SC2001: the sed indents every line of a captured multi-line block, which a
# ${var//search/replace} cannot do as legibly for the first line.
# shellcheck disable=SC2001
check() {
  local desc=$1 want_exit=$2 want_out=$3 got got_exit
  shift 3
  # Invoked exactly as the action invokes it — directly, not via `bash` — so
  # a missing executable bit fails here, before a push, instead of as a
  # Permission denied in somebody else's classify job.
  got=$(env "$@" "$here/lanes.sh" "${MODE:-classify}" 2>&1)
  got_exit=$?
  if [ "$got_exit" -ne "$want_exit" ]; then
    echo "FAIL: $desc — exit $got_exit, wanted $want_exit"; echo "$got" | sed 's/^/    /'
    fails=1
  elif [ -n "$want_out" ] && ! printf '%s' "$got" | grep -qF "$want_out"; then
    echo "FAIL: $desc — output lacks '$want_out'"; echo "$got" | sed 's/^/    /'
    fails=1
  else
    echo "ok: $desc"
  fi
}

# --- the config is read, not assumed
# Both directions against a policy that inverts the default one: .txt is
# docs there and markdown is not. An engine ignoring the config
# answers both of these backwards.
check "a consumer's own policy decides docs"  0 "docs_only=true"  FILES="NOTES.txt" LANES_CONFIG="$stub/other.conf"
check "a consumer's own policy decides code"  0 "docs_only=false" FILES="README.md" LANES_CONFIG="$stub/other.conf"
MODE=gate
check "that policy's prefixes are the lane's" 0 "" FILES="NOTES.txt" SUBJECTS="notes: jot" CLASSIFY=success RESULTS="a=skipped" LANES_CONFIG="$stub/other.conf"
check "the default table does not leak in"    1 "lacks a prefix" FILES="NOTES.txt" SUBJECTS="docs: jot" CLASSIFY=success RESULTS="a=skipped" LANES_CONFIG="$stub/other.conf"
MODE=classify

# --- a config that cannot supply a policy is refused, never defaulted
check "a missing config is refused"      1 "No lanes config" FILES="README.md" LANES_CONFIG="$stub/nope.conf"
check "a config with no rule is refused"  1 "no is_docs" FILES="README.md" LANES_CONFIG="$stub/empty.conf"
check "a config with no prefixes refused"  1 "no LANE_PREFIXES" FILES="README.md" LANES_CONFIG="$stub/noprefix.conf"
MODE=sniff
check "an unknown mode is refused"        2 "unknown mode" FILES="README.md"
MODE=classify

# --- the pr input must name the run's own pull request
# The number is the caller's claim, not the event's fact. Without this, a
# miswired consumer classifies PR B and hangs B's clean verdict on A's commit.
check "the triggering PR classifies normally"  0 "docs_only=true"  FILES="README.md"
check "a pr naming another PR is refused"      1 "belongs to" FILES="README.md" PR=2 GITHUB_REF=refs/pull/1/merge SHARED_PRS=2
check "an unset ref is refused, not waved through" 1 "belongs to" FILES="README.md" GITHUB_REF=
check "a non-PR ref is refused"                1 "belongs to" FILES="README.md" GITHUB_REF=refs/heads/main
check "a prefix collision is not a match"      1 "belongs to" FILES="README.md" PR=1 GITHUB_REF=refs/pull/11/merge
MODE=gate
check "the gate refuses a mis-named pr too"    1 "belongs to" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="a=skipped" PR=2 GITHUB_REF=refs/pull/1/merge SHARED_PRS=2
MODE=classify

# --- the policy file is code, and the ENGINE decides that
# On a pull_request event the sourced config is the pull request's own copy,
# so asking it whether edits to itself are documentation lets the pull request
# answer the one question its answer must not decide. Both modes would agree,
# since the gate is independent of classify's output but not of the policy.
check "editing the policy is code"             0 "docs_only=false" FILES="$stub/hostile.conf" LANES_CONFIG="$stub/hostile.conf"
check "a hostile policy cannot buy its skip"   0 "docs_only=false" FILES="$stub/hostile.conf src/main.rs" LANES_CONFIG="$stub/hostile.conf"
check "renaming the policy away is code"       0 "docs_only=false" FILES="docs/old.md:$stub/hostile.conf" LANES_CONFIG="$stub/hostile.conf"
# The real asymmetry: a consumer writes "./.github/lanes.conf" by hand while
# the API always reports repo-relative paths. Uses a config in the working
# directory so both spellings of one file can actually be expressed.
cp "$stub/hostile.conf" ./lanes-selftest.conf
check "a ./ spelling does not slip past"       0 "docs_only=false" FILES="lanes-selftest.conf" LANES_CONFIG="./lanes-selftest.conf"
check "and the plain spelling still matches"   0 "docs_only=false" FILES="lanes-selftest.conf" LANES_CONFIG="lanes-selftest.conf"
rm -f ./lanes-selftest.conf
check "an ordinary docs PR is unaffected"      0 "docs_only=true"  FILES="README.md"
MODE=gate
check "the gate refuses a policy-edit skip"    1 "refusing the skip" FILES="$stub/hostile.conf" SUBJECTS="docs: x" CLASSIFY=success RESULTS="a=skipped" LANES_CONFIG="$stub/hostile.conf"
MODE=classify

# --- the policy never reaches this shell
# `set -- classify` once made `lanes.sh gate` run the classify arm and exit 0
# without reading CLASSIFY or RESULTS at all: the required check green over
# failed heavy jobs. Each of these is a different reach out of the policy and
# into the engine, and each must fail closed rather than be defended by name.
MODE=gate
check "argv cannot be rewritten by the policy"  1 "" FILES="src/main.rs" CLASSIFY=failure RESULTS="check=failure" LANES_CONFIG="$stub/escape-argv.conf"
check "the policy cannot forge the results"     1 "nothing vouches" FILES="src/main.rs" CLASSIFY=failure RESULTS="check=failure" LANES_CONFIG="$stub/escape-env.conf"
check "the policy cannot shadow the API client" 1 "nothing vouches" FILES="src/main.rs" CLASSIFY=failure RESULTS="check=failure" LANES_CONFIG="$stub/escape-gh.conf"
MODE=classify
# Inert, not fatal: argv is captured before the policy loads, so `set --`
# reaches nothing and the policy's own verdict stands -- code, here.
check "an escaping policy classifies as code"   0 "docs_only=false" FILES="src/main.rs" LANES_CONFIG="$stub/escape-argv.conf"
check "a well-behaved policy still answers"     0 "docs_only=true" FILES="README.md"

# --- the gate needs an actual verdict to relay
# ${RESULTS:?} catches unset and empty but not whitespace, and a string of
# spaces word-splits to nothing: zero iterations, all_success still standing
# at its initial true, and the gate passes having been told nothing. Reachable
# by ordinary misconfiguration -- consumers build this from needs.<job>.result,
# so a renamed job renders empty.
MODE=gate
check "whitespace results are not a pass"    1 "named no heavy jobs" FILES="src/main.rs" CLASSIFY=success RESULTS=" "
check "a tab-only results input too"         1 "named no heavy jobs" FILES="src/main.rs" CLASSIFY=success RESULTS="$(printf '\t')"
check "one job vanishing names that job"     1 "Job 'msrv' reported no result" FILES="src/main.rs" CLASSIFY=success RESULTS="check=success msrv="
check "a token with no = is refused"         1 "Malformed entry" FILES="src/main.rs" CLASSIFY=success RESULTS="check=success garbage"
check "a real all-green input still passes"  0 "" FILES="src/main.rs" CLASSIFY=success RESULTS="check=success msrv=success"
MODE=classify

# --- classify: the rule itself, both directions per shape
check "markdown-only diff is docs"        0 "docs_only=true"  FILES="README.md docs/DESIGN.md"
check "code file makes it code"           0 "docs_only=false" FILES="README.md crates/app/src/main.rs"
check "markdown under a code tree is code" 0 "docs_only=false" FILES="crates/app/README.md"
check "a shared head never rides the docs lane" 0 "docs_only=false" FILES="README.md" SHARED_PRS="1 2"
check "a lone foreign head PR never rides the lane" 0 "docs_only=false" FILES="README.md" SHARED_PRS="2"
check "unlistable head PRs are code on a PR event" 0 "docs_only=false" FILES="README.md" PULLS_FAIL=1
check "an unmatched path is code"         0 "docs_only=false" FILES=".editorconfig"
check "empty diff is not docs"            0 "docs_only=false" FILES="" CHANGED=0
check "non-PR events are code"            0 "docs_only=false" FILES="README.md" GITHUB_EVENT_NAME=push

# --- classify: a dispatched run judges the PR its input names, or nothing
check "dispatch naming a PR classifies it" 0 "docs_only=true"  FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch
check "dispatch without a PR is refused"   1 "must name the pull request" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch PR=
check "a config may allow a PR-less dispatch" 0 "docs_only=false" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch PR= LANES_CONFIG="$stub/dispatch-ok.conf"
check "shared head is refused"             1 "cannot vouch for exactly one" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch SHARED_PRS="1 2"
check "unlistable head PRs are refused"    1 "refusing to report" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch PULLS_FAIL=1
check "dispatch for another PR's commit refused" 1 "must not label" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch HEAD_SHA=otherhead
check "unreadable head refuses the dispatch" 1 "refusing to report" FILES="README.md" GITHUB_EVENT_NAME=workflow_dispatch HEAD_FAIL=1

# --- classify: renames are judged on both sides
check "md-to-md rename stays docs"        0 "docs_only=true"  FILES="docs/NEW.md:docs/OLD.md"
check "code renamed into docs is code"    0 "docs_only=false" FILES="docs/A.md:crates/app/src/a.rs"

# --- classify: an untrustworthy file list must never classify as docs
check "truncated file list is not docs"   0 "docs_only=false" FILES="README.md" CHANGED=3000
check "files API failure is not docs"     0 "docs_only=false" FILES="README.md" FILES_FAIL=1

# --- gate: every verdict combination (RESULTS carries the heavy jobs)
export MODE=gate
ALLOK="check=success msrv=success"
ALLSKIP="check=skipped msrv=skipped"
check "all heavy jobs green passes"       0 "" FILES="a.rs" CLASSIFY=success RESULTS="$ALLOK"
check "justified skip with prefixes"      0 "" FILES="README.md" SUBJECTS="docs: Fix a typo" CLASSIFY=success RESULTS="$ALLSKIP"
check "design prefix rides the lane"      0 "" FILES="docs/DESIGN.md" SUBJECTS="design: Let a block take a label" CLASSIFY=success RESULTS="$ALLSKIP"
check "merge commits are exempt"          0 "" FILES="README.md" SUBJECTS="2:Merge branch 'main' into x" CLASSIFY=success RESULTS="$ALLSKIP"
check "a fake merge subject is not exempt" 1 "lacks a prefix" FILES="README.md" SUBJECTS="Merge installation sections" CLASSIFY=success RESULTS="$ALLSKIP"
check "bare subject fails the lane"       1 "lacks a prefix" FILES="README.md" SUBJECTS="Fix a typo" CLASSIFY=success RESULTS="$ALLSKIP"
check "a prefix outside the table fails"  1 "lacks a prefix" FILES="README.md" SUBJECTS="chore: tidy" CLASSIFY=success RESULTS="$ALLSKIP"
check "a dispatched skip still lints"     1 "lacks a prefix" FILES="README.md" SUBJECTS="Fix a typo" CLASSIFY=success RESULTS="$ALLSKIP" GITHUB_EVENT_NAME=workflow_dispatch
check "gate refuses a mis-bound dispatch"  1 "must not label" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" GITHUB_EVENT_NAME=workflow_dispatch HEAD_SHA=otherhead
check "gate refuses a shared head"         1 "cannot vouch for exactly one" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" GITHUB_EVENT_NAME=workflow_dispatch SHARED_PRS="1 2"
check "skip on a code diff is refused"    1 "refusing the skip" FILES="crates/a.rs" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP"
check "skip on a shared head is refused"  1 "refusing the skip" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" SHARED_PRS="1 2"
check "skip vouched by a foreign PR is refused" 1 "refusing the skip" FILES="README.md" SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP" SHARED_PRS="2"
check "skip on a truncated list refused"  1 "refusing the skip" FILES="README.md" CHANGED=3000 SUBJECTS="docs: x" CLASSIFY=success RESULTS="$ALLSKIP"
check "commits API failure fails lint"    1 "cannot be verified" FILES="README.md" COMMITS_FAIL=1 CLASSIFY=success RESULTS="$ALLSKIP"
check "truncated commit list fails lint"  1 "Commit list incomplete" FILES="README.md" SUBJECTS="docs: x" NCOMMITS=300 CLASSIFY=success RESULTS="$ALLSKIP"
check "red job fails the gate"            1 "not all green" FILES="a.rs" CLASSIFY=success RESULTS="check=failure msrv=success"
check "half-skipped is not justified"     1 "not all green" FILES="a.rs" CLASSIFY=success RESULTS="check=skipped msrv=success"
check "canceled job fails the gate"       1 "not all green" FILES="a.rs" CLASSIFY=success RESULTS="check=cancelled msrv=cancelled"
check "failed classify fails the gate"    1 "nothing vouches" FILES="a.rs" CLASSIFY=failure RESULTS="$ALLSKIP"

# --- action.yml: no expression may reach a shell as script text
#
# GitHub substitutes ${{ }} into a `run:` body before bash parses it, so an
# interpolated input becomes shell SOURCE rather than shell DATA -- a value
# like `x"; exit 0; #` ends the quoted argument and the fixed `exit 1` below
# it never runs. Binding through `env:` passes the value as data instead.
#
# Asserted as a whole-file property rather than by hunting for the known bad
# spellings: every line carrying an expression must BE an env binding. A new
# step that interpolates anywhere else fails here, in whatever notation, and
# has to be rewritten rather than remembered.
manifest_dir=$(cd "$here" && pwd)
bad_interp=0
in_runs=0
# SC2016: the single quotes are the point -- these patterns match the literal
# characters `${{`, which must not expand in the one check whose job is to
# find them unexpanded.
# shellcheck disable=SC2016
while IFS= read -r line; do
  case "$line" in
    "runs:") in_runs=1; continue ;;
  esac
  test "$in_runs" = 1 || continue
  # Comment lines are skipped: this manifest has to be able to *discuss*
  # ${{ }} in the note explaining why it never uses one, and a check that
  # cannot tell directive from prose fires on its own documentation.
  case "${line#"${line%%[![:space:]]*}"}" in
    '#'*) continue ;;
  esac
  case "$line" in
    *'${{'*) ;;
    *) continue ;;
  esac
  # The only permitted shape: an env binding whose whole value is one
  # expression, e.g. `        PR: ${{ inputs.pr }}`.
  case "$line" in
    *[!\ ]*:\ '${{ '*' }}') ;;
    *) echo "FAIL: action.yml interpolates outside an env binding: $line"; bad_interp=1 ;;
  esac
done < "$manifest_dir/action.yml"
if [ "$bad_interp" -eq 0 ]; then
  echo "ok: action.yml passes every expression through env, never into script text"
else
  fails=1
fi

# Prove the check above can actually fail -- an assertion that never fires on
# a bad input is a green light nobody earned.
# shellcheck disable=SC2016
probe=$(printf 'runs:\n  steps:\n    - run: echo "${{ inputs.mode }}"\n')
# shellcheck disable=SC2016
if printf '%s\n' "$probe" | {
     seen=0; inr=0
     while IFS= read -r l; do
       case "$l" in "runs:") inr=1; continue ;; esac
       test "$inr" = 1 || continue
       case "$l" in *'${{'*) ;; *) continue ;; esac
       case "$l" in *[!\ ]*:\ '${{ '*' }}') ;; *) seen=1 ;; esac
     done
     test "$seen" = 1
   }; then
  echo "ok: the interpolation check rejects a run: body that interpolates"
else
  echo "FAIL: the interpolation check passed a known-bad manifest"
  fails=1
fi

rm -rf "$stub"
if [ "$fails" -ne 0 ]; then echo "lanes tests FAILED"; exit 1; fi
echo "lanes tests passed"
