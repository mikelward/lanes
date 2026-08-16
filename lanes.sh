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
# IFS is deliberately left at its default. Narrowing it to newline+tab is the
# usual hardening, and here it is actively wrong: every `read` below sets IFS
# for itself, and the two unquoted expansions that remain -- the prefix list
# and the heavy-job results -- are space-separated by design, so removing
# space from IFS stops them splitting at all. The suite caught that.

# --- Consumer policy -------------------------------------------------------
#
# The policy is DATA. It is parsed, never executed, and that is the whole of
# the trust story: nothing a consumer writes in it runs anywhere.
#
# This began as a sourced shell file, which cost four review rounds to
# discover was indefensible. On a pull_request event the checkout is the
# merge ref, so the file is the PULL REQUEST'S copy -- and a sourced file IS
# the shell. It controlled the positional parameters (`set -- classify` made
# `lanes.sh gate` run the classify arm and exit 0 without ever reading
# CLASSIFY or RESULTS), the environment read later, PATH, and a `gh()`
# function shadowing every API call the classification rests on. Isolating it
# in a subshell fixed the reach into engine state and none of the rest: a
# subshell still inherits the token, the network and a writable disk.
#
# Each of those was a different name for the same mistake, which was letting
# it run at all. So it does not.
#
# Patterns are matched with `case`, which expands the pattern word once. A
# variable's VALUE is not re-scanned, so `$(...)` or a backtick inside a rule
# is inert text rather than a command -- verified by test, not assumed.
#
# Format, one directive per line:
#
#   docs <pattern>          paths matching this are documentation
#   code <pattern>          paths matching this are code
#   prefixes <words>        commit-subject prefixes the docs lane accepts
#   dispatch-without-pr refuse|allow
#
# `docs` and `code` are ordered: FIRST match wins, and anything matching no
# rule is code. Full-line comments start with `#`; a trailing comment starts
# at whitespace-then-`#`, so a pattern cannot contain " #".
#
# Patterns are path-AWARE: `*` never crosses `/`, so `*.md` means markdown at
# the repository root and nothing deeper. Use `docs/*.md` for one level down
# and `**/*.md` for any depth. That is gitignore's rule rather than bash's --
# a bare `case` would let `*` cross `/` -- and matches_pattern below is what
# enforces it.

LANES_CONFIG=${LANES_CONFIG:?the config path must be set}
if [ ! -f "$LANES_CONFIG" ]; then
  echo "::error::No lanes config at '${LANES_CONFIG}' — refusing to classify without a policy." >&2
  exit 1
fi

# Rules as verdict<TAB>pattern lines, in file order.
RULES=''
LANE_PREFIXES=''
DISPATCH_WITHOUT_PR=refuse

parse_policy() {
  local line directive rest lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    # Trailing comment, then surrounding whitespace.
    case "$line" in *" #"*) line=${line%%" #"*} ;; esac
    line=${line#"${line%%[![:space:]]*}"}
    line=${line%"${line##*[![:space:]]}"}
    test -n "$line" || continue
    case "$line" in '#'*) continue ;; esac

    directive=${line%%[[:space:]]*}
    rest=${line#"$directive"}
    rest=${rest#"${rest%%[![:space:]]*}"}

    case "$directive" in
      docs|code)
        if [ -z "$rest" ]; then
          echo "::error::${LANES_CONFIG}:${lineno}: '${directive}' needs a pattern." >&2
          return 1
        fi
        RULES="${RULES}${directive}	${rest}
"
        ;;
      prefixes)
        if [ -z "$rest" ]; then
          echo "::error::${LANES_CONFIG}:${lineno}: 'prefixes' needs at least one prefix." >&2
          return 1
        fi
        LANE_PREFIXES=$rest
        ;;
      dispatch-without-pr)
        case "$rest" in
          refuse|allow) DISPATCH_WITHOUT_PR=$rest ;;
          *)
            echo "::error::${LANES_CONFIG}:${lineno}: 'dispatch-without-pr' takes refuse or allow, not '${rest}'." >&2
            return 1
            ;;
        esac
        ;;
      *)
        # Refused rather than skipped. A typo'd directive silently ignored is
        # a policy that quietly does less than it says -- which for a `code`
        # rule means paths the author excluded riding the docs lane.
        echo "::error::${LANES_CONFIG}:${lineno}: unknown directive '${directive}'." >&2
        return 1
        ;;
    esac
  done < "$LANES_CONFIG"
}

parse_policy || exit 1

# A policy that parsed but declares nothing would leave the engine with no
# rules at all, and "no rules" must never read as "nothing is docs" — that is
# a silent full-lane forever, which looks like the safe direction but hides a
# broken config indefinitely. Refuse instead.
if [ -z "$RULES" ]; then
  echo "::error::${LANES_CONFIG} declares no docs or code rules — refusing to classify without a path policy." >&2
  exit 1
fi
if [ -z "$LANE_PREFIXES" ]; then
  echo "::error::${LANES_CONFIG} sets no prefixes — refusing to lint subjects against an empty prefix list." >&2
  exit 1
fi

# How many `/` a string contains.
slashes() {
  local rest=${1//[!\/]/}
  printf '%s' "${#rest}"
}

# Does a path match a rule pattern?
#
# Path-AWARE, which bash `case` is not: a bare `*` in a case pattern happily
# crosses `/`, so `*.md` would match `docs/DESIGN.md` and a root-only rule
# would be impossible to write. Depth is enforced separately -- a pattern
# without `**` must match a path of the SAME depth, so `*` is confined to one
# segment the way it is in gitignore and every other tool anyone has used.
#
#   *.md         matches README.md, NOT docs/DESIGN.md
#   docs/*.md    matches docs/DESIGN.md, NOT docs/a/B.md
#   **/*.md      matches markdown at any depth
#   docs/**      matches everything under docs/
#
# `**` opts out of the depth check and falls through to `case`, where it
# behaves as an ordinary crossing wildcard.
matches_pattern() {
  local path=$1 pattern=$2
  # `**/` means zero OR MORE segments, and the zero case needs its own try:
  # as a bare case pattern `**/*.md` still requires a literal `/`, so it would
  # miss README.md -- the root file the rule most obviously ought to cover.
  # Each recursion drops one `**/`, so this terminates.
  case "$pattern" in
    *'**/'*)
      # Split around the first `**/` rather than using ${var/pat/rep}: there
      # the unquoted `/` inside the pattern would terminate it, and a glob
      # `**/` would match far more than the literal three characters.
      matches_pattern "$path" "${pattern%%'**/'*}${pattern#*'**/'}" && return 0
      ;;
  esac
  case "$pattern" in
    *'**'*) ;;
    *) test "$(slashes "$path")" = "$(slashes "$pattern")" || return 1 ;;
  esac
  # Unquoted on purpose: this is glob matching. The value is not re-scanned
  # for expansions, so a rule holding $(...) is text, not a command.
  # shellcheck disable=SC2254
  case "$path" in
    $pattern) return 0 ;;
  esac
  return 1
}

# First match wins; unmatched is code.
is_docs() {
  local path=$1 verdict pattern
  while IFS=$'\t' read -r verdict pattern; do
    test -n "$pattern" || continue
    if matches_pattern "$path" "$pattern"; then
      test "$verdict" = docs
      return
    fi
  done <<< "$RULES"
  return 1
}


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


# Every repo-relative path that IS the policy, resolved once at startup.
#
# Two of them, because a configured path and the file it sources are not the
# same thing. `.github/lanes.conf` may be a symlink to `.github/policy.sh`:
# a pull request editing the TARGET changes the sourced policy, and the API
# reports the target's own path, which a comparison against the configured
# name never matches. A `..` segment aliases the same way in the other
# direction -- `.github/../.github/lanes.conf` is a path the API will never
# report -- so the configured spelling is canonicalized too.
#
# Both are guarded: editing the link itself is a policy change (it decides
# what gets sourced) and so is editing what it points at.
# Every repo-relative path whose modification changes WHICH FILE the engine
# reads as the policy.
#
# Three review rounds were spent enumerating routes into this one by one --
# the configured spelling, then a multi-hop link chain, then a symlinked
# DIRECTORY component -- so it is now answered structurally instead. Walk the
# configured path one component at a time from the repository root; any
# component that is a symlink is itself a policy path (retargeting it selects
# a different file) and is recorded before being resolved, after which the
# walk restarts against the rewritten path. Nothing is left to enumerate:
# every component is examined, and resolution is followed transitively.
#
# Plain directory components are not recorded -- a directory never appears in
# a pull request's file list, so guarding it would only add noise.
policy_paths() {
  local remaining=${LANES_CONFIG#./} prefix='' comp rest target rebased steps=0
  # An absolute path is not a repository path, so no API-reported filename
  # can ever equal one and there is nothing under it to walk. Record it and
  # stop: still guarded if a caller compares against the same spelling, and
  # no pretence of resolving a tree the diff cannot describe.
  case "$remaining" in
    /*) printf '%s\n' "$remaining"; return 0 ;;
  esac
  # The configured spelling, recorded as written. Git tracks a file at its
  # real path, so a path THROUGH a symlinked directory should never appear in
  # a diff -- but recording it can only widen the guard.
  printf '%s\n' "$remaining"
  # ...and normalized, BEFORE the walk. `..` and `.` segments are a spelling
  # the API never reports: an edit to `.github/../.github/lanes.conf` arrives
  # as `.github/lanes.conf`. Normalizing only inside the symlink branch --
  # which is where it ended up when this became a component walk -- leaves a
  # plain `..` path unnormalized, which is how this regressed after having
  # been fixed once already.
  #
  # -s normalizes without resolving links, so the walk below still sees every
  # intermediate. A failure here is fatal: a policy path this cannot pin down
  # is one the guard cannot enforce, and continuing would enforce it partly.
  if ! remaining=$(realpath -m -s --relative-to="$PWD" "$remaining" 2>&1); then
    echo "::error::Could not normalize the policy path '${LANES_CONFIG}': ${remaining}" >&2
    return 1
  fi
  case "$remaining" in
    ../*|/*)
      echo "::error::The policy path '${LANES_CONFIG}' resolves outside the repository — refusing, since no changed file can ever be compared against it." >&2
      return 1
      ;;
  esac
  printf '%s\n' "$remaining"
  while [ -n "$remaining" ]; do
    # A cycle among links would otherwise spin here. The bound is generous
    # because it counts components as well as hops.
    steps=$((steps + 1))
    if [ "$steps" -gt 100 ]; then
      echo "::error::The policy path resolves through more than 100 steps — refusing rather than following a possible symlink cycle." >&2
      return 1
    fi

    comp=${remaining%%/*}
    if [ "$comp" = "$remaining" ]; then rest=''; else rest=${remaining#*/}; fi
    if [ -n "$prefix" ]; then prefix="$prefix/$comp"; else prefix=$comp; fi

    if [ -L "$prefix" ]; then
      # A link, at any depth. Record it, then follow it.
      printf '%s\n' "$prefix"
      if ! target=$(readlink "$prefix" 2>&1); then
        echo "::error::Could not read the symlink '${prefix}' on the way to the policy: ${target}" >&2
        return 1
      fi
      case "$target" in
        /*) rebased=$target ;;
        *) rebased="$(dirname "$prefix")/$target" ;;
      esac
      # -s so this normalizes `..` WITHOUT resolving links: resolving here
      # would skip straight past the intermediates this walk exists to find.
      #
      # A failure returns NON-zero. Returning 0 here -- as this did -- hands
      # back the entries emitted so far as though they were the whole answer,
      # so an edit to the unresolved remainder sails past a guard that looks
      # like it ran. A guard that cannot complete has not passed.
      if ! rebased=$(realpath -m -s --relative-to="$PWD" "$rebased" 2>&1); then
        echo "::error::Could not resolve the policy symlink '${prefix}' -> '${target}': ${rebased}" >&2
        return 1
      fi
      # A link out of the repository ends the walk; the API can never report
      # such a path, so there is nothing further to guard.
      case "$rebased" in ../*|/*) return 0 ;; esac
      if [ -n "$rest" ]; then remaining="$rebased/$rest"; else remaining=$rebased; fi
      prefix=''
      continue
    fi

    if [ -z "$rest" ]; then
      # The file itself, wherever the walk ended up.
      printf '%s\n' "$prefix"
    fi
    remaining=$rest
  done
}

# Resolved once, before anything is classified: the engine's own idea of
# which paths count as the policy must not be recomputed per file, and must
# not depend on anything the policy can influence.
# A failure here is fatal rather than a smaller answer: policy_paths returning
# non-zero means it could not establish which paths ARE the policy, and an
# engine that cannot answer that must not classify anything.
if ! POLICY_PATHS=$(policy_paths); then
  exit 1
fi

is_policy_file() {
  local candidate=${1#./} known
  while IFS= read -r known; do
    test -n "$known" || continue
    test "$candidate" = "$known" && return 0
  done <<< "$POLICY_PATHS"
  return 1
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
  # A non-numeric count makes `[ -ne ]` exit 2, and an `if` reads that as
  # false -- so the reconciliation below would be SKIPPED rather than failed,
  # and a truncated listing would sail through as though it had been checked.
  # The one guard here whose whole job is catching a partial list must not
  # have "and if the count is unreadable, don't check" as a silent branch.
  case "$declared" in
    ''|*[!0-9]*)
      echo "::error::The pull request reported an unreadable changed_files count ('${declared}') — refusing to classify against a total that cannot be compared." >&2
      return 1
      ;;
  esac
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
  # Everything else is the policy's call. Evaluated here rather than in a
  # child, because the policy is data now -- there is nothing to contain.
  while IFS=$'\t' read -r new old; do
    test -n "$new" || continue
    is_docs "$new" || return 1
    # A rename is only docs if the path it LEFT was docs too.
    if [ -n "$old" ]; then is_docs "$old" || return 1; fi
  done <<< "$files"
  return 0
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
  case "$declared" in
    ''|*[!0-9]*)
      echo "::error::The pull request reported an unreadable commit count ('${declared}') — the prefix rule cannot be verified against a total that cannot be compared."
      return 1
      ;;
  esac
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
    if [ "$DISPATCH_WITHOUT_PR" = allow ]; then return 0; fi
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
    pairs=0
    for pair in ${RESULTS:?}; do
      # Not a job result at all, or a job whose result rendered empty. Both
      # would fall to the catch-all below and fail closed anyway, but with a
      # message naming the whole string rather than the entry at fault --
      # and an empty value is the single most informative symptom there is
      # here, since it means `needs.<job>.result` resolved to nothing and
      # that job is the one to go looking for.
      case "$pair" in
        *=?*) ;;
        *=)
          echo "::error::Job '${pair%=}' reported no result — it was probably renamed or removed while the results input still names it."
          exit 1
          ;;
        *)
          echo "::error::Malformed entry '${pair}' in the results input — expected job=result pairs."
          exit 1
          ;;
      esac
      pairs=$((pairs + 1))
      case "${pair#*=}" in
        success) all_skipped=false ;;
        skipped) all_success=false ;;
        *) all_success=false; all_skipped=false ;;
      esac
    done
    # `${RESULTS:?}` catches unset and empty, but not whitespace — and a
    # string of spaces word-splits to nothing, running the loop zero times
    # and leaving all_success standing at its initial true. The gate would
    # then pass having received no heavy-job verdict at all, which is the
    # fail-OPEN direction and the only one that matters here. It is reachable
    # by ordinary misconfiguration rather than malice: consumers build this
    # from `${{ needs.<job>.result }}`, and a renamed or deleted job renders
    # empty, collapsing the whole input to whitespace.
    if [ "$pairs" -eq 0 ]; then
      echo "::error::The results input named no heavy jobs — nothing reported, so there is nothing to pass. Check that every job in it still exists."
      exit 1
    fi
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
