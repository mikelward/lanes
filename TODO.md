# TODO

## Trusted verdicts need an explicit publisher

- [ ] Two problems in this repository turned out to be the same problem seen
      from different triggers, and untangling that took three rounds of
      Codex review — worth recording so the next reader doesn't re-walk it.

      **Problem 1: manual re-dispatch.** A workflow_dispatch-based manual
      re-run of a consumer's gate cannot safely validate a same-repository
      PR today, and every consumer that tried it (vcs, unixtools, scripts,
      conf) removed the input rather than ship the hole. GitHub ties BOTH
      "which copy of the workflow file executes" and "which commit SHA the
      resulting check-run is attributed to" to the same dispatch ref.
      Dispatching against a PR branch to validate that PR's head therefore
      also executes that branch's own copy of the workflow — a PR could
      rewrite its `lanes` job to always succeed. Dispatching against a
      trusted ref (e.g. `main`) instead avoids that, but then the check-run
      lands on `main`'s tip, not the PR's head, and `verifyDispatchBinding`
      correctly refuses the mismatch — so a dispatch can never *succeed*
      either way.

      **Problem 2: every ordinary PR run.** Every consumer's `classify`/
      `lanes` gate jobs trigger on plain `pull_request` today, and that
      trigger loads the job DEFINITION from the pull request's own merge
      ref — not from the base branch. A pull request touching its own
      `.github/workflows/ci.yml` (or `test.yml`) can therefore rewrite the
      `lanes` job to `run: exit 0` and mint its own green required check.
      Codex found it reviewing unixtools#30; the owner asked for it to be
      designed here rather than accepted as risk or patched ad hoc per
      consumer. `mikelward/codex-review` already solved the job-definition
      half of an analogous problem for `codex-review-check.yml`
      (`pull_request_target`, whose trigger loads the job definition from
      the base branch always), documented in its own `docs/CONSUMER.md` —
      but that check's heavy work is Codex's AI review, which "never checks
      out or executes pull request code at all"; `lanes` consumers are
      different in kind, since the heavy job's entire purpose IS to execute
      the PR's own code.

      Two design attempts here were each wrong in a way Codex caught, and
      both wrong turns are worth recording rather than erasing:

      1. **First attempt (superseded):** move only `classify`/`lanes` to
         `pull_request_target`, leave the heavy job on plain `pull_request`,
         bridge with `workflow_run` or API polling. Fatal: the heavy job's
         own definition still loads from the PR's merge ref, so a PR could
         fake its build/test result while keeping the job name — the same
         hole, one hop removed — and `classify`'s `docs_only` output could
         no longer gate the heavy job via `needs:` across separate runs.
      2. **Second attempt (superseded):** move the WHOLE workflow —
         `classify`, the heavy job(s), and `lanes` — to `pull_request_target`
         together, keeping every job's Actions check-run as the reporting
         mechanism. This fixes both flaws in attempt 1 (`needs:` works
         again inside one run; the heavy job's definition is tamper-proof
         too), but Codex found it wrong on two counts that an earlier "no
         engine change, no new privilege" claim in this file had missed:
         - `lanes.mjs` does not understand `pull_request_target` at all.
           `classify` (lanes.mjs ~L593-608) accepts only `pull_request` and
           `workflow_dispatch` as events, returning `false` for anything
           else — so every docs-only PR would take the code lane instead of
           skipping. `verifyPrBinding` (~L363-365) and `verifyEventBinding`
           (~L388-390) both `return` immediately for any event other than
           `pull_request`, silently **disabling** the force-push, retarget,
           base-movement, and shared-head checks rather than refusing to
           run — the opposite of this repository's fail-closed rule.
         - Even with the engine fixed, a `pull_request_target` run's own
           `GITHUB_SHA` is the base branch tip, not the PR's head — so
           reporting through the ordinary Actions check-run (as `classify`/
           `lanes` do today) would post `lanes: success` on the base
           commit, and the PR's head would sit forever waiting for a
           required check nothing ever posts against it. (Confirm the
           exact field semantics against GitHub's live docs before
           implementing — `docs.github.com` was unreachable while
           investigating this, so nothing here is copied from a page
           actually read.)

      **The corrected design merges the two problems' fixes, because they
      turn out to need the identical mechanism:** an explicit, trusted
      publisher that resolves the target PR's *actual* head SHA via the API
      and posts a commit status directly onto it (`repos.createCommitStatus`
      or equivalent) under the `lanes` context by name — never relying on
      whatever commit the triggering event's default Actions check-run
      happens to attribute to. That single mechanism serves both triggers:
      a trusted-ref `workflow_dispatch` naming a PR number, and a
      `pull_request_target` run carrying the event payload's own PR.
      Concretely, on top of what "Problem 1" above already scoped
      (pending-before-gated-work, merge-snapshot building so the status
      certifies what a normal `pull_request` run would have tested rather
      than a head-only build, binding revalidation immediately before the
      terminal write via `verifyDispatchBinding`/`stillPinned`, and
      `statuses: write` scoped to a dedicated publisher job that executes
      no PR code and holds no other privilege):
      - `lanes.mjs` needs `pull_request_target` added everywhere
        `pull_request` is currently the only accepted event for binding
        purposes — `classify`, `verifyPrBinding`, `verifyEventBinding` —
        reasoning from the event payload's `pull_request.head.sha` /
        `pull_request.base.*` fields (the same fields a `pull_request` run
        already reads) rather than from `GITHUB_SHA`/`GITHUB_REF`, since
        those two env vars mean something different under this trigger.
        New tests need both directions (docs skip, code fails-closed)
        under the new event name, the same standard "Testing" already
        holds every other event to.
      - Every job the consumer's workflow gates on — `classify`, the heavy
        job(s), and the publisher itself — must explicitly check out
        `github.event.pull_request.head.sha` or the synthetic merge
        (`refs/pull/<pr>/merge`) rather than the trigger's default
        checkout, which under `pull_request_target` is the base branch.
      - The heavy job still executes the PR's own arbitrary code, exactly
        as it already does under plain `pull_request` — that is unavoidable
        for any CI that builds untrusted PRs and is not new risk. What
        would be new risk is a secret reachable from that execution; the
        heavy job must keep declaring `permissions: contents: read` and
        nothing else, and `statuses: write` must live only on the publisher
        job, never anywhere the PR's own code runs.
      - This is now correctly scoped as an action-side change (`lanes.mjs`
        gains real logic and tests), not the "consumer-template change, not
        an action change" this file previously and wrongly claimed —
        retracted here rather than left standing uncorrected.

      **Alternatives considered and why they are not the design:**
      - GitHub rulesets have a "require workflows to pass" rule type that
        may pin a required workflow's source independently of the PR
        branch. Not adopted as the design because its exact semantics are
        unverified — `docs.github.com` was unreachable while investigating
        this — so confirm directly against GitHub's current docs before
        relying on it; it may turn out to be a simpler answer than
        `pull_request_target`, or unavailable on this account's plan.
      - CODEOWNERS + a required review on `.github/workflows/**` would also
        close this (GitHub does not let a PR's own author satisfy a
        required review), but every PR in this fleet is opened and merged
        autonomously by an agent under the owner's standing authorization
        — the fleet's "drive to merge" convention. Requiring a human
        review on every PR touching a workflow file would block that
        specifically for CI/workflow changes, which are common. Rejected
        as the default fix for that reason; worth having as a defense in
        depth once the real fix lands, not instead of it.

      Per AGENTS.md's "Piloting happens BEFORE the merge, not after", this
      does NOT get piloted against this repository (which deliberately
      runs no lane on itself): point one consumer's workflow at
      `mikelward/lanes@<branch>` and take that consumer's pull request
      through review, merging here only once it is green. Until this
      lands, no consumer's `workflow_dispatch` documentation should
      recommend `--ref <PR-head-branch>` as a way to satisfy a PR's
      required check, and no consumer should move its gate to
      `pull_request_target` on its own. This note stops iterating as prose
      here — a design this security-sensitive gets the rest of its
      scrutiny against the actual `lanes.mjs` diff, where a reviewer can
      see what the code does rather than judge how precisely a TODO
      describes it.

## Review and merge gates

- [ ] Verify the settings half of the fleet's bar — every repository works
      the same: comprehensive automated review, required merge gates, and
      auto-merge. The workflow files (CI and the codex-review set) are all
      present here; what git cannot show, and the 2026-08-18 audit could
      not verify, is the settings half: a ruleset on the default branch
      requiring the CI gate, the `codex` status, conversation resolution
      and up-to-date branches, and the auto-merge setting enabled.
