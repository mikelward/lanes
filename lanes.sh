#!/usr/bin/env bash
# Two CI lanes: lets docs-only pull requests merge without the
# heavy jobs, while one required check — the `gate` mode — still reports on
# every pull request.
#
# Why this exists: a ruleset can only require named checks, and a required
# check that never reports blocks the pull request forever. A `paths:` filter
# on `pull_request` skips the whole workflow for docs-only diffs, which is
# exactly that trap. So the workflow runs on every pull request; `classify`
# decides whether the heavy jobs may skip, and `gate` — the only mode a
# ruleset should require — independently re-derives that decision before
# blessing a skip, so a classification bug turns into a red check instead of
# a silent merge.
#
# One source of truth: both modes run THIS file against the SAME config, so
# the docs rule cannot drift between them. What the gate adds is
# re-execution plus a cross-check against what actually ran.
set -euo pipefail

# --- Consumer config -------------------------------------------------------
#
# Sourced rather than passed as inputs, and that is the load-bearing choice
# here. Both modes evaluate the policy, and the gate's whole value is
# re-deriving the classification independently *under the same rules*. Policy
# supplied at each call site would be two copies in one workflow file, and an
# edit to one copy would leave the gate re-deriving against rules that
# classify never used — a check that reports green on validation it did not
# perform. A file is one copy by construction.
#
# On a pull_request event the file sourced here is the PULL REQUEST'S copy of
# it, since the checkout is the merge ref. So the policy cannot be trusted to
# say whether edits to the policy are documentation -- that would let a pull
# request answer the one question its answer must not decide, and both modes
# would agree with it, the gate being independent of classify's output but
# not of the policy they share. is_policy_file() settles it in the engine
# instead: the config is code, always, whatever the config says.
#
# The config defines is_docs() and LANE_PREFIXES, and may override
# dispatch_without_pr_ok(). Everything else is engine.

LANES_CONFIG=${LANES_CONFIG:?the config path must be set}
if [ ! -f "$LANES_CONFIG" ]; then
  echo "::error::No lanes config at '${LANES_CONFIG}' — refusing to classify without a policy." >&2
  exit 1
fi

# The policy is NEVER sourced into this shell. Every question is put to a
# child that shares nothing back but an exit status or one line of stdout.
#
# On a pull_request event the checkout is the merge ref, so this file is the
# pull request's own copy -- and a sourced file IS the shell, not a set of
# definitions. It would control the positional parameters (a config holding
# `set -- classify` makes `lanes.sh gate` run the classify arm and exit 0
# without ever reading CLASSIFY or RESULTS -- the required check green over
# failed heavy jobs), the environment the engine reads later, PATH, and a
# `gh()` function shadowing every API call the classification rests on.
#
# There is no list of those to defend, which is the point: the previous
# version guarded the config PATH and left the shell wide open behind it.
# Isolation is structural, so the vectors do not have to be enumerated.
#
# stdout is sent to stderr while the policy loads, so a config that prints
# cannot be mistaken for the answer.
policy_query() {
  local fn=$1
  shift
  (
    # shellcheck source=/dev/null
    . "$LANES_CONFIG" >&2 || exit 9
    declare -F is_docs >/dev/null || exit 8
    # `$fn` rather than `$@` because a config holding `set --` replaces the
    # child's own argv. It can clobber `fn` too -- but everything it can do
    # in here ends at this child's exit status, which the engine reads as a
    # refusal, so the worst it buys is failing its own query closed.
    "$fn" "$@"
  )
}

_policy_prefixes() { printf '%s' "${LANE_PREFIXES:-}"; }

# Classify a whole file list in ONE child, rather than one per path: the
# policy is sourced once, and a 3,000-file diff does not become 3,000 forks.
_policy_classify() {
  local new old
  while IFS=$'\t' read -r new old; do
    test -n "$new" || continue
    is_docs "$new" || exit 1
    if [ -n "$old" ]; then is_docs "$old" || exit 1; fi
  done <<< "$1"
  exit 0
}

# The default is refusal; a repo whose workflow legitimately dispatches
# without a pull request (a deploy-force on the default branch) overrides
# this in its config.
_policy_dispatch_ok() {
  if declare -F dispatch_without_pr_ok >/dev/null; then
    dispatch_without_pr_ok
  else
    return 1
  fi
}

# A config that loads but declares nothing would leave the engine with no
# policy at all, and "no policy" must never read as "nothing is docs" — that
# is a silent full-lane forever, which looks like the safe direction but
# hides a broken config indefinitely. Refuse instead. Read once, here, into
# engine state the policy cannot reach afterwards.
if ! LANE_PREFIXES=$(policy_query _policy_prefixes); then
  echo "::error::${LANES_CONFIG} could not be loaded, or defines no is_docs() — refusing to classify without a path policy." >&2
  exit 1
fi
if [ -z "$LANE_PREFIXES" ]; then
  echo "::error::${LANES_CONFIG} sets no LANE_PREFIXES — refusing to lint subjects against an empty prefix list." >&2
  exit 1
fi

# --- Engine ----------------------------------------------------------------

# Non-empty lines in a block, counted without grep.
#
# `grep -c .` needs a `|| true` because it exits 1 on zero matches -- and that
# `|| true` would equally swallow a command-not-found, turning a missing
# dependency into an empty count and a comparison that is malformed rather
# than wrong-but-loud. Counting in the shell has no failure mode to mask, and
# drops grep from the classification path entirely.
count_lines() {
  local n=0 line
  while IFS= read -r line; do
    if [ -n "$line" ]; then n=$((n + 1)); fi
  done <<< "$1"
  printf '%s' "$n"
}


# Is this path the policy file the engine sourced?
#
# Compared with leading "./" stripped from both sides, because the config
# input is a path a consumer writes by hand (".github/lanes.conf",
# "./.github/lanes.conf") while the API always reports repo-relative paths.
# A guard that a spelling can slip past is not a guard.
is_policy_file() {
  local a=${1#./} b=${LANES_CONFIG#./}
  test "$a" = "$b"
}

has_lane_prefix() {
  local subject=$1 p
  for p in $LANE_PREFIXES; do
    case "$subject" in "$p: "*) return 0 ;; esac
  done
  return 1
}

# The complete file list, or a hard failure — never a silent prefix of it.
# Two ways a naive listing lies: the endpoint caps at 3,000 files, returning
# a clean-looking truncation; and a pagination failure after the first page
# exits non-zero into a process substitution, where bash discards the status.
# So the output is captured with its status checked, and the count is
# reconciled against the PR's own changed_files figure before anything is
# classified.
pr_files() {
  local declared files listed
  declared=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.changed_files') || {
    echo "::error::Could not read the pull request's changed_files count." >&2
    return 1
  }
  # Both sides of every entry: a rename carries its new path in `filename`
  # and its old one in `previous_filename`, and classifying only the new
  # side would let a source file renamed into docs ride the docs lane while
  # deleting code. One TSV line per entry keeps the count reconcilable
  # against changed_files.
  files=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}/files" --paginate \
            --jq '.[] | [.filename, .previous_filename // ""] | @tsv') || {
    echo "::error::Could not list the pull request's files." >&2
    return 1
  }
  listed=$(count_lines "$files")
  if [ "$listed" -ne "$declared" ]; then
    echo "::error::File list incomplete: listed ${listed} of ${declared} changed files (the API caps at 3,000) — refusing to classify." >&2
    return 1
  fi
  printf '%s\n' "$files"
}

# Every open pull request the given commit currently heads, one number per
# line — or a hard failure when the listing cannot be completed, because a
# per-commit check must not be minted on an association nobody verified.
open_prs_heading() {
  HEAD_Q="$1" gh api "repos/${GITHUB_REPOSITORY}/commits/$1/pulls" --paginate \
    --jq '.[] | select(.state == "open" and .head.sha == env.HEAD_Q) | .number'
}

# 0 = every changed file is docs; 1 = code, or an empty diff;
# 2 = the file list could not be trusted (API failure or truncation).
docs_only() {
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request)
      # A commit can head more than one open PR (stacked PRs: same branch,
      # different bases), and a check run is per-commit — a gate minted for
      # this PR's justified skip would satisfy the other PR's required
      # check too, even where that PR's diff is code. So a shared head
      # never rides the docs lane: classified as code, the heavy jobs run,
      # and the gate on this SHA is backed by real validation whichever PR
      # reads it. (On pull_request events GITHUB_SHA is the merge commit,
      # not the head, so the PR's own head is looked up first.)
      test -n "${PR:-}" || return 1
      local prhead prs
      prhead=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.head.sha') || return 2
      prs=$(open_prs_heading "$prhead") || return 2
      # The sole open PR must be THIS one, not merely a count of one: the
      # originating PR can close while its run is in flight, leaving a
      # stacked twin as the single open PR the gate would then vouch for.
      if [ "$(count_lines "$prs")" -ne 1 ] || [ "${prs%%$'\n'*}" != "$PR" ]; then return 1; fi
      ;;
    # A dispatched run may stand in for a PR run, but only by naming the PR,
    # so classification still judges the PR's real diff rather than waving
    # the branch through. verify_dispatch_binding (below) has already bound
    # the named PR to the checked-out commit before this runs.
    workflow_dispatch) test -n "${PR:-}" || return 1 ;;
    *) return 1 ;;
  esac
  local files any=false new old
  files=$(pr_files) || return 2
  # The policy file is code, and the ENGINE decides that -- never the policy.
  # Asking the policy whether edits to itself are documentation would let a
  # pull request answer the one question its answer must not decide, and both
  # modes would agree, the gate being independent of classify's output but
  # not of the policy they share. Checked here, before the policy is
  # consulted at all, on both sides of a rename so moving the file out of the
  # way cannot launder it.
  while IFS=$'\t' read -r new old; do
    test -n "$new" || continue
    any=true
    is_policy_file "$new" && return 1
    if [ -n "$old" ]; then is_policy_file "$old" && return 1; fi
  done <<< "$files"
  # An empty diff is not a docs diff; refuse to vouch for it.
  test "$any" = true || return 1
  # Everything else is the policy's call, made in a child process.
  policy_query _policy_classify "$files"
  case $? in
    0) return 0 ;;
    1) return 1 ;;
    # 8/9 are a policy that vanished or stopped loading between the check at
    # startup and now; anything else is a child that died. Neither is a
    # classification, so neither may read as one.
    *) return 2 ;;
  esac
}



# On the docs lane every commit subject must carry a docs-lane prefix. A
# commits listing that cannot be completed fails the lint — an unverified
# prefix is not a verified one.
lint_prefixes() {
  local declared subjects listed bad=0 subject
  # Same reconciliation as pr_files, for the same reason: the commits
  # endpoint stops at 250 commits and exits cleanly, so an unprefixed
  # subject past the cap would simply never be seen. The PR's own commit
  # count says how many there are supposed to be.
  declared=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.commits') || {
    echo "::error::Could not read the pull request's commit count — the prefix rule cannot be verified."
    return 1
  }
  # Parent count travels with each subject so merge commits are identified
  # structurally — a docs commit whose subject merely starts with "Merge "
  # is not a merge commit and gets no exemption.
  subjects=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}/commits" --paginate \
               --jq '.[] | [(.parents | length), (.commit.message | split("\n")[0])] | @tsv') || {
    echo "::error::Could not enumerate the pull request's commits — the prefix rule cannot be verified."
    return 1
  }
  if [ -z "$subjects" ]; then
    echo "::error::Commit enumeration returned nothing — the prefix rule cannot be verified."
    return 1
  fi
  listed=$(count_lines "$subjects")
  if [ "$listed" -ne "$declared" ]; then
    echo "::error::Commit list incomplete: listed ${listed} of ${declared} commits (the API caps at 250) — the prefix rule cannot be verified."
    return 1
  fi
  local parents
  while IFS=$'\t' read -r parents subject; do
    # Merge commits are exempt — the sibling repos rebase-merge, so they
    # never land on the default branch — and a merge commit is one with more
    # than one parent, not one whose subject happens to start with the word.
    if [ "${parents:-1}" -gt 1 ]; then continue; fi
    if has_lane_prefix "$subject"; then continue; fi
    local list="" p
    for p in $LANE_PREFIXES; do list="${list}${p}:/"; done
    echo "::error::Docs-lane commit subject lacks a prefix:" \
         "'${subject}' — prefix it (${list%/})" \
         "so it never reads like a behavior-change subject."
    bad=1
  done <<< "$subjects"
  return "$bad"
}

# On a pull_request run the named PR must BE the one that triggered it.
#
# The number arrives as an input, so it is the caller's *claim*, not the
# event's fact — and the rest of this engine then reasons entirely about
# whichever pull request that claim points at. A consumer that miswires it
# (a hard-coded number, a copy-pasted expression naming the wrong event
# field) makes both modes inspect pull request B, find B docs-only, skip
# the heavy jobs, and hang a green gate on code pull request A's commit.
# Every downstream guard here is about which commits a PR heads; none of them
# notices that the PR under examination is the wrong one.
#
# GITHUB_REF settles it without a JSON parse: on a pull_request event GitHub
# sets it to refs/pull/<n>/merge, which is the event's own statement of which
# pull request this run belongs to. Unset or unparsable is refused rather
# than waved through — the fail-closed direction, matching the dispatch
# binding below.
verify_pr_binding() {
  test "${GITHUB_EVENT_NAME:-}" = "pull_request" || return 0
  # No claim to check. docs_only classifies a PR-less run as code, so the
  # full lane runs and there is nothing to bind.
  test -n "${PR:-}" || return 0
  case "${GITHUB_REF:-}" in
    refs/pull/"$PR"/*) return 0 ;;
  esac
  echo "::error::The pr input names #${PR}, but this run belongs to '${GITHUB_REF:-<unset>}' — a verdict computed for one pull request must not label another's commit."
  return 1
}

# On a dispatched run the named PR must BE the checked-out commit: `--ref`
# selects the branch and `-f pr=` supplies the input independently, so
# nothing else stops a dispatch on code PR A's branch from naming docs PR B
# and landing B's clean verdict on A's head SHA. Verified in BOTH modes —
# classify failing already cascades to a red gate, and gate re-checks so the
# required check never reports for a commit the named PR does not head.
# (Kept in the engine even where a consumer's workflow declares no dispatch
# trigger: the engine is identical everywhere, and a trigger added later is
# born guarded.)
verify_dispatch_binding() {
  test "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" || return 0
  # An unnamed PR cannot be verified, so it is refused — unless the config
  # says a PR-less dispatch is legitimate here (deploy-force on the default
  # branch), in which case docs_only classifies it as code and the full lane
  # runs.
  if [ -z "${PR:-}" ]; then
    if policy_query _policy_dispatch_ok; then return 0; fi
    echo "::error::A dispatched run must name the pull request it reports for (the pr input) — refusing without one."
    return 1
  fi
  local head
  head=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR}" --jq '.head.sha') || {
    echo "::error::Could not read PR #${PR}'s head SHA — refusing to report for it."
    return 1
  }
  if [ "$head" != "${GITHUB_SHA:?}" ]; then
    echo "::error::Dispatched commit ${GITHUB_SHA} is not PR #${PR}'s head (${head}) — a verdict computed for one pull request must not label another's commit."
    return 1
  fi
  # SHA equality alone is not a complete association: a commit can head more
  # than one open PR (same branch, different bases), and a check run is
  # per-commit, so a gate minted for the docs PR would satisfy the code PR
  # too. Require the named PR to be the ONLY open PR this commit heads;
  # ambiguity is refused rather than resolved, the fail-closed direction.
  local heads
  heads=$(open_prs_heading "${GITHUB_SHA}") || {
    echo "::error::Could not list the pull requests this commit heads — refusing to report for it."
    return 1
  }
  if [ "$(count_lines "$heads")" -ne 1 ] || [ "${heads%%$'\n'*}" != "$PR" ]; then
    echo "::error::Commit ${GITHUB_SHA} heads these open pull requests: $(printf '%s' "$heads" | tr '\n' ' ')— a per-commit gate cannot vouch for exactly one, so a dispatched run refuses to report."
    return 1
  fi
}

case "${1:?usage: lanes.sh classify|gate}" in
  classify)
    verify_pr_binding || exit 1
    verify_dispatch_binding || exit 1
    # Any failure to establish docs-only — code paths, an untrustworthy file
    # list, a non-PR event — classifies as code: the heavy jobs run, which is
    # always the safe direction. The gate is where an unjustified SKIP fails.
    if docs_only; then echo "docs_only=true"; else echo "docs_only=false"; fi
    ;;
  gate)
    verify_pr_binding || exit 1
    verify_dispatch_binding || exit 1
    # Results arrive via env: CLASSIFY (needs.classify.result) and RESULTS —
    # space-separated `job=result` pairs for every heavy job, supplied by the
    # workflow so the engine needs no per-repo job names.
    if [ "${CLASSIFY:?}" != "success" ]; then
      echo "::error::classify did not succeed (result: ${CLASSIFY}) — nothing vouches for this diff."
      exit 1
    fi
    all_success=true
    all_skipped=true
    for pair in ${RESULTS:?}; do
      case "${pair#*=}" in
        success) all_skipped=false ;;
        skipped) all_success=false ;;
        *) all_success=false; all_skipped=false ;;
      esac
    done
    if [ "$all_success" = true ]; then
      exit 0
    fi
    if [ "$all_skipped" = true ]; then
      # The skip is only as good as the reason for it: re-derive the
      # classification here, independently of the output that caused it.
      # docs_only's failure modes (code file, truncated or unlistable file
      # list) all land here as a refusal.
      if ! docs_only; then
        echo "::error::Heavy jobs were skipped but the diff could not be verified as docs-only — refusing the skip."
        exit 1
      fi
      lint_prefixes
      exit 0
    fi
    echo "::error::Heavy job results '${RESULTS}' — not all green, and not a justified skip."
    exit 1
    ;;
  *)
    echo "unknown mode: $1" >&2
    exit 2
    ;;
esac
