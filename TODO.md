# TODO

## Trusted verdicts need an explicit publisher

- [ ] Two problems in this repository turned out to be the same problem seen
      from different triggers, and untangling that took seven rounds of
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
      `statuses: write` scoped to jobs that execute no PR code and hold no
      other privilege — see the initializer/finalizer split below for why
      that is two jobs, not one):
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
      - `classify` and every heavy job must explicitly check out the
        synthetic merge (`refs/pull/<pr>/merge`) — NOT the head SHA, and
        not either one interchangeably. `readPolicy` (lanes.mjs L54-89)
        reads `.github/lanes.conf` from whatever the job's own checkout put
        on disk, while `changedPaths` (~L247) diffs against the base
        through the API independently of that checkout — so a head-only
        checkout on a branch that predates a base-side policy change would
        classify against a stale policy the branch never saw, producing a
        false skip for a path the base now treats as code. Only the
        merge snapshot keeps the two in agreement, and it's also what a
        normal `pull_request` run already builds, so heavy jobs test what
        will actually land rather than the head alone. The finalizer needs
        it too, for the identical reason: `main()` (lanes.mjs:863) reads
        `.github/lanes.conf` off disk before dispatching to either mode, so
        the finalizer's own independent re-derivation of a docs-only skip
        (`gate` mode, lanes.mjs:818-824) fails outright with no checkout at
        all — an earlier "neither the initializer nor the finalizer makes
        any checkout" line was wrong for the finalizer specifically, caught
        below. Checking out to read a policy file is not "executing PR
        code," same as `classify` already does it safely today; only the
        initializer is genuinely checkout-free, since it only posts
        `pending` and never calls `gate`.
      - The heavy job still executes the PR's own arbitrary code, exactly
        as it already does under plain `pull_request` — that is unavoidable
        for any CI that builds untrusted PRs and is not new risk. What
        would be new risk is a secret reachable from that execution, and
        `permissions: contents: read` is NOT what prevents that — it only
        narrows the auto-generated `GITHUB_TOKEN`'s scope. The separate
        `secrets` context is available to every job in a `pull_request_target`
        run regardless of the `permissions:` block, where a plain
        `pull_request` run from a fork would have withheld it. So `classify`
        and every heavy job must not reference `secrets.*` anywhere —
        directly, in an `env:`, or through a called reusable action — and
        must not carry a protected `environment:`. `statuses: write` must
        live only on the initializer and finalizer jobs below, never
        anywhere the PR's own code runs, and neither of those two jobs may
        hold any other secret either.
      - Posting `pending` "before gated work starts" is necessary but not
        sufficient against a **retarget or title edit**, which the
        `edited` trigger (`README.md` ~L98-106) exists to re-run precisely
        because it changes nothing about the head SHA — "a base change has
        to start a fresh run or the old verdict simply stands," in that
        note's own words. Under the explicit-publisher design, "the old
        verdict simply stands" literally: the previous run's `lanes:
        success` status remains the latest one GitHub reports for that SHA
        for as long as it takes the new run's publisher job to reach a
        runner and overwrite it, and anything that reads the ruleset
        during that queue-latency window — a human merge, auto-merge — can
        act on the stale verdict. Every consumer workflow needs a
        `concurrency:` group keyed on the PR (or the dispatch target)
        with `cancel-in-progress: true`, so an in-flight run superseded by
        a newer event is canceled before its terminal write can land after
        the newer run's and win a last-write-wins race on the commit
        status. That closes the *overlapping-runs* half of this cleanly.
        The *first-write latency* half — the gap between the retarget/edit
        firing and the new run's first job actually reaching a runner —
        cannot be closed to zero by anything in this design; it is bounded
        by ordinary Actions queuing time, the same bound every CI-based
        required check already lives with today (a `pull_request` run's
        own check-run doesn't reach "in progress" instantly either). Two
        things are still unconfirmed and belong at implementation time
        rather than asserted here: whether GitHub's required-check
        evaluation for the Statuses API is strictly last-write-wins by
        creation time (it is for what this file has read informally; not
        verified against live docs), and whether posting `pending`
        immediately — as the very first action of every run, before even
        checkout — measurably narrows the window in practice given
        `pending` still doesn't count as satisfying a required check, so a
        merge attempted in that narrower window is refused rather than
        waved through on staleness.
      - "A dedicated publisher job" is one job in name only — it cannot be
        one job in fact. Posting `pending` before anything else runs means
        that job has no `needs:` on `classify`/the heavy jobs and starts
        immediately; posting the terminal result means reading their
        outputs, which requires exactly that `needs:`. No single job can
        both run before its dependencies and depend on them. So this is
        **two** jobs: an **initializer** with no `needs:`, first in the
        graph, that posts `pending` and does nothing else; and a
        **finalizer** with `needs: [classify, <every heavy job>]`, last in
        the graph, that reads their results and posts the terminal status
        — the same job `verifyDispatchBinding`/`stillPinned` and the
        merge-snapshot certification above already describe, just named
        correctly now. The initializer is API-only (no checkout); the
        finalizer checks out the merge snapshot to independently re-run
        `gate` (per the bullet above) but, like `classify`, only reads
        `.github/lanes.conf` from it and never executes anything else the
        checkout contains. Both hold `statuses: write` and nothing else
        beyond what `action.yml` already documents, and neither executes
        PR code — the "dedicated publisher" privilege scoping already
        specified applies to both of them, not to a single job
        that was never implementable as specified.
      - This is now correctly scoped as an action-side change (`lanes.mjs`
        gains real logic and tests), not the "consumer-template change, not
        an action change" this file previously and wrongly claimed —
        retracted here rather than left standing uncorrected.

      **Round six surfaced four more real gaps in a single pass, not one
      at a time — that acceleration is the signal to stop iterating in
      prose, not a reason to keep going.** All four are genuine (verified
      below) and none reshape an earlier finding; they are left as an
      explicit punch list for the implementation rather than redesigned
      into more paragraphs, because a design that keeps growing new
      corners under scrutiny needs code and CI to converge it, not another
      round of text:
      - The initializer and finalizer need `pull-requests: read` and
        `contents: read` alongside `statuses: write`, not "nothing else."
        `action.yml` L46-50 already documents the engine's own token
        requirement — "no more than read access to contents and pull
        requests" — which every earlier "no other privilege" line above
        contradicts for any job that actually calls the engine.
      - Nothing orders the initializer ahead of `classify` or the
        finalizer. "First in the graph" was prose, not a `needs:` edge;
        runner scheduling can let the finalizer finish and publish before
        a delayed initializer's `pending` ever lands, and the later write
        becomes the last word for that SHA regardless of which one meant
        to be first.
      - The finalizer needs a cancellation-aware condition
        (`!cancelled()`), not the `always()` the current consumer template
        already uses on its gate job to report failed dependencies
        (`README.md:134`) — carried over unchanged, that pattern defeats
        the `concurrency`/`cancel-in-progress` fix above, because GitHub
        does not stop a job whose condition still evaluates true just
        because the workflow was canceled. An outdated finalizer under
        `always()` runs to completion regardless and can still publish its
        stale result after a newer run's.
      - `actions/cache` (or any persistent-state action) in a heavy job
        moved to `pull_request_target` is a channel this design has not
        addressed at all: a cache write there is attributed to the trusted
        base/default ref rather than a PR-scoped one, so PR-controlled
        code could plant a poisoned entry that a later run on the base
        branch — holding real secrets — restores and executes. Forbidding
        `secrets.*` in the heavy job, above, does nothing about this;
        caching needs its own answer (disabled, explicitly scoped, or
        proven unreachable from a PR-controlled key) before this design is
        safe to build, and this file does not have that answer yet.
      - **The most fundamental open item, and the reason the whole
        publisher mechanism is unproven, not just its ordering and
        checkout details:** a `statuses: write` commit status is not
        authenticated to any particular workflow file or trigger — any
        Actions run in the repo with that permission can write the
        `lanes` context on any commit it can name, including its own head.
        A same-repo PR can add a brand-new workflow triggered on plain
        `push` (which, like any `push`-triggered run, executes the
        definition the PR branch itself supplies) that calls
        `repos.createCommitStatus` directly and mints its own
        `lanes: success`, bypassing the initializer/finalizer entirely —
        no `pull_request_target` trust boundary is even in play, because
        nothing about this route depends on the `classify`/`lanes`/heavy
        job graph at all. An "expected source" restriction on the required
        check does not distinguish the trusted publisher from this forgery
        either, since both run as the generic GitHub Actions token
        identity. Closing this needs a credential PR-controlled Actions
        code cannot obtain — a dedicated GitHub App whose **App ID and
        private key**, not a minted installation token, are held as the
        secret reachable by **both the initializer and the finalizer**,
        not the finalizer alone as an earlier revision said: once the
        ruleset restricts the required check to this app's identity, an
        initializer still posting `pending` as the generic Actions
        identity would not invalidate the prior App-authenticated
        `lanes: success` at all, reopening the exact stale-status window
        the `pending`-first design already fixed for a retarget or title
        edit. (An installation token expires in an hour, so storing one
        directly would leave every later run unable to publish and every
        consumer PR blocked; each job mints a fresh installation token
        from the stored credential itself.) The ruleset's required check
        stays restricted to that app as its source — which is real
        infrastructure (provisioning the
        app, storing its credential, confirming GitHub's required-check
        "expected source" feature actually restricts by app identity on
        this account's plan), not a consumer-template detail.

        **A bare repository or organization secret does not achieve any of
        this.** A same-repo PR's own added `push` workflow, described
        above, could reference `${{ secrets.APP_PRIVATE_KEY }}` exactly as
        the legitimate initializer/finalizer do — Actions secrets at that
        scope are not job-restricted — mint its own installation token
        from the real credential, and post a status that genuinely does
        carry the required App's identity, defeating the whole point. The
        credential has to live in a GitHub **Environment** with a
        deployment branch/ref policy restricted to the trusted base ref
        (e.g. `main`), so only a job whose run satisfies that policy can
        reach it. Whether this closes the hole rests on the same
        unverified `pull_request_target` field semantics flagged above:
        it works only if that trigger's `github.ref` is genuinely the base
        branch (matching the environment's policy) while a same-repo PR's
        own `push`-triggered forgery runs under the PR branch's own ref
        (failing it) — confirm this against GitHub's live docs before
        implementing, not assumed from what this file has read informally.

        Until this is resolved, the explicit-publisher mechanism this
        whole design section describes should be understood as unproven
        against the exact self-certification threat it exists to close.

      **Round eight: the engine capability itself now exists, resolving the
      "unproven" line above at the mechanism level, not at the rollout
      level.** `lanes.mjs` gained a `publishing` layer: `signAppJwt` (a
      short-lived App JWT, RS256, Node's own `node:crypto`, no dependency),
      `installationId`/`installationToken` (the JWT-then-installation-token
      exchange GitHub's own App-auth flow requires), and `publishStatus`
      (posts the `lanes` context directly via `repos.createCommitStatus` on
      the commit `statusSha` resolves from the event payload — never
      `GITHUB_SHA`, which is the base tip under `pull_request_target`, not
      the pull request). Two new callers: a new `init` mode does nothing but
      resolve the commit and post `pending`, exactly the initializer this
      file already specified, with no checkout, no policy read, and no
      binding verification, since `pending` never satisfies a required check
      either way; `gate` mode grew an opt-in second half (`publishResult`)
      that publishes the terminal state after computing the verdict as
      before, then re-throws whatever `gate()` threw so the job's own log
      still reports red — the status is IN ADDITION to that, never instead
      of it. Both are gated on `app-id`/`app-private-key` being supplied at
      all: a consumer that supplies neither is completely unaffected, and
      keeps relying on the ambient Actions check-run exactly as it does
      today. All of it is unit-tested against a stubbed API, plus one real
      RSA round trip that signs a JWT and verifies its signature against the
      matching public key — the one place this file's claim about GitHub's
      own auth flow is checked against something other than description.

      **What round eight does NOT resolve, and is still open:** the
      workflow-level rollout this mechanism exists to serve. Nothing yet
      moves `classify` or a consumer's heavy jobs to `pull_request_target`,
      builds the merge snapshot instead of the head, enforces the
      no-`secrets.*`-in-a-heavy-job rule, orders the initializer ahead of
      `classify`/the finalizer with `needs:`, or adds the
      `concurrency`/`cancel-in-progress` group and the finalizer's
      `!cancelled()` condition — all four are still consumer-workflow work,
      not engine work, and belong to whichever pull request actually pilots
      a consumer onto this. The `actions/cache` poisoning item from round
      six is untouched and still has no answer. And the one platform fact
      this whole design leans on — that a `pull_request_target` run's
      `github.ref` genuinely resolves to the base branch, which is what an
      environment's branch-policy restriction is trusted to act on — remains
      unverified against live docs, exactly as flagged above; nothing in
      this round depended on it, since the publishing layer reasons entirely
      from the event payload and the API, never from `GITHUB_REF`.

      **Round nine sharpened what "the mechanism exists" does not cover: a
      publisher that CANNOT post at all leaves a stale verdict standing
      un-revalidated, and requiring only the App-posted `lanes` status never
      sees it.** Neither `init` nor `gate` swallows an authentication or
      publish failure -- both re-throw, so the job that hit it fails its own
      Actions check-run -- but that check-run was never in the required-check
      list README.md instructed, only the `lanes` status context was. A run
      whose App credential has gone bad (revoked, expired, the App
      uninstalled) cannot post `pending` OR a fresh terminal state, so
      whatever `lanes: success` a previous, healthy run already posted on
      that commit simply stands, and a ruleset requiring `lanes` alone
      accepts it -- even across a retarget or title edit that should have
      started a fresh, unvalidated verdict.

      **The first fix attempted (superseded within the same round) was
      wrong, and worth recording rather than erasing.** It instructed
      requiring `init` and the finalizer job (renamed `finalize`, away from
      `lanes`, so its own check-run is never confused with the App-posted
      status of the same name) ALONGSIDE the App-posted `lanes` status, on
      the reasoning that both job definitions load from the base branch
      under `pull_request_target` exactly like `lanes` itself, so requiring
      them costs nothing a same-repo pull request could forge. That reasoning
      is correct about the job DEFINITION and wrong about what a required
      check actually reads: GitHub attributes a `pull_request_target` job's
      own ambient check-run to `GITHUB_SHA`, which is the BASE branch's tip,
      not the pull request's head -- the identical fact the second superseded
      design attempt above was rejected over. Requiring `init` or `finalize`
      by name would have left every pull request's own head waiting forever
      for a check that only ever reports against `main`, blocking every merge
      through this pattern rather than protecting it. Caught by the same
      round of review before merging, and reverted.

      **What stands instead: `lanes` alone remains the only required check,
      and the stale-status gap is left open rather than falsely closed.**
      There is no App-authenticated signal available to fix it -- the only
      thing the App can write at all is the `lanes` status itself, and
      minting the token to write it is exactly what is failing when this gap
      is live. `init`/`finalize`'s own job failures are real and visible in
      the Actions tab (or a notification wired to them), which is an
      operational mitigation, not one a required check can enforce. The
      finalizer keeps its `finalize` name regardless, purely so its check-run
      in the Actions tab is not visually confused with the status of the same
      name -- that naming choice was never the part that was wrong. The
      underlying "first-write latency" window this design has flagged since
      round three -- the gap between a new event firing and its own fresh
      status actually landing -- remains untouched by any of this and still
      is not, and cannot be, closed to zero by anything here.

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
      `pull_request_target` on its own. Five rounds of real findings
      landed on this note and were fixed here (the split-workflow flaw,
      the engine/SHA-attribution gap, merge-snapshot precision and secrets
      scoping, the stale-status ordering window, and a single job
      description that quietly required running both before and after its
      own dependencies). **A sixth round then landed four more, all real,
      in one pass — accelerating rather than converging, unlike every
      round before it — and that is where this stopped rewriting prose
      instead of code.** Those four are recorded above as an explicit,
      unresolved punch list rather than fixed here. A seventh round then
      landed the most fundamental item yet — that a `statuses: write`
      commit status authenticates nothing about which workflow wrote it,
      so the entire explicit-publisher mechanism is unproven against
      same-repo forgery via an unrelated `push`-triggered workflow —
      appended to the same punch list as one more open item rather than
      redesigned, on the same judgment: a document which keeps growing new
      corners the more it is scrutinized needs an implementation and a
      live CI run to actually converge, not another paragraph. This note
      stops iterating as prose here: a
      design this security-sensitive gets the rest of its scrutiny against
      the actual `lanes.mjs` diff, where a reviewer can see what the code
      does rather than judge how precisely a TODO describes it, and where
      the platform-semantics questions this file has had to leave
      unverified (exact `pull_request_target` field values, Statuses-API
      ordering guarantees) get answered by a live run instead of a guess.

## Review and merge gates

- [ ] Verify the settings half of the fleet's bar — every repository works
      the same: comprehensive automated review, required merge gates, and
      auto-merge. The workflow files (CI and the codex-review set) are all
      present here; what git cannot show, and the 2026-08-18 audit could
      not verify, is the settings half: a ruleset on the default branch
      requiring the CI gate, the `codex` status, conversation resolution
      and up-to-date branches, and the auto-merge setting enabled.

- [ ] **Flip the main ruleset to require `lanes codex zizmor`** — the
      fleet standard, replacing any rule naming `test` directly — now that
      `lanes` reports on every pull request and zizmor.yml runs unfiltered
      (its `paths:` filter is gone precisely so it can be required: a
      paths-filtered workflow creates no check run at all on a
      non-matching PR, which would leave the ruleset waiting forever —
      this repo pilots that change; the sibling repos' zizmor workflows
      follow once this has proven out). The docs-only skip is
      deliberately NOT enabled yet: ci.yml's test job runs
      unconditionally, because while the ruleset still requires `test`, a
      skipped `test` would count as satisfied with nothing re-verifying
      the skip. Sequence: (1) this branch merges with `lanes` and
      `zizmor` reporting on every PR and `test` unconditional; (2) the
      ruleset flips — `repo-rules mikelward/lanes` with no arguments
      applies the standard set, a step outside what a session without
      ruleset API access can do; (3) a follow-up PR gives the test job
      `needs: classify` and
      `if: needs.classify.outputs.docs_only != 'true'`, and flips the
      workflows.test.mjs pin that holds it unconditional.
