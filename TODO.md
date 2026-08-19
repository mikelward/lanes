# TODO

## Safe manual re-dispatch

- [ ] A workflow_dispatch-based manual re-run of a consumer's gate cannot
      safely validate a same-repository PR today, and every consumer that
      tried it (vcs, unixtools, scripts, conf) removed the input rather than
      ship the hole. The problem: GitHub ties BOTH "which copy of the
      workflow file executes" and "which commit SHA the resulting check-run
      is attributed to" to the same dispatch ref. Dispatching against a PR
      branch to validate that PR's head therefore also executes that
      branch's own copy of the workflow — a PR could rewrite its `lanes`
      job to always succeed and mint its own required check, defeating
      `verifyDispatchBinding` from the inside, since the guard lives in the
      file the PR branch controls. Dispatching against a trusted ref (e.g.
      `main`) instead avoids that, but then the check-run lands on `main`'s
      tip, not the PR's head, and `verifyDispatchBinding` correctly refuses
      the mismatch — so a dispatch can never *succeed* either way.
      A real fix needs a distinct mechanism: a mode where a trusted-ref
      dispatch resolves the named PR's actual head SHA via the API and
      posts a commit status directly onto it (`repos.createCommitStatus` or
      equivalent) under the `lanes` context explicitly — the API's own
      default context does not satisfy a ruleset requiring `lanes` by name.
      Post a `pending` status on that head BEFORE any gated work starts,
      too, not only the terminal result: if checkout, classification, a
      heavy job, or the finalizer itself fails or is canceled partway
      through, the head's previous status (a stale success from an earlier
      run, say) must not silently remain the latest one GitHub reports.
      Posting the status correctly is not sufficient by itself: every job
      the consumer's workflow gates on (the classify/gate steps here, and
      the consumer's own heavy jobs) must also explicitly check out a
      pinned snapshot, or a code PR could earn a green `lanes` status built
      and tested against `main` — the status-writing path has to bind
      execution to the commit it certifies, not just attribution. That
      snapshot has to be the synthetic MERGE of head and base, resolving
      and pinning both, not the head commit alone — a normal `pull_request`
      run already tests the merge result, and a head-only build could pass
      a dispatch while failing once actually merged. The status still
      posts on the head SHA (that is what a required check tracks), even
      though the heavy jobs build the merge.
      That needs `statuses: write` (more privilege than any consumer
      workflow holds today) plus new code and tests here — and per
      AGENTS.md's "Piloting happens BEFORE the merge, not after", it does
      NOT get piloted against this repository (which deliberately runs no
      lane on itself): point one consumer's workflow at
      `mikelward/lanes@<branch>` and take that consumer's pull request
      through review, merging here only once it is green. Until this lands,
      no consumer's `workflow_dispatch` documentation should recommend
      `--ref <PR-head-branch>` as a way to satisfy a PR's required check.
      Two more review rounds on this note surfaced real design constraints
      worth recording rather than continuing to expand as prose: the
      terminal publisher has to re-settle the PR's binding (the existing
      `verifyDispatchBinding`/`stillPinned` guarantees — exactly one open
      PR, head, base ref, base SHA) immediately before writing the status,
      not just at the start, since a retarget or a second PR sharing the
      head could otherwise land a stale verdict; and `statuses: write` has
      to be scoped to a dedicated publisher/finalizer job, never granted at
      workflow scope or to any job that executes the PR's own code, or that
      job's token becomes a way to self-certify. This note stops iterating
      as prose here — a design this security-sensitive gets the rest of its
      scrutiny against the actual implementation, where a reviewer can see
      what the code does rather than judge how precisely a TODO describes
      it.

## The gate job itself is not trusted

- [ ] Every consumer's `classify`/`lanes` gate jobs trigger on plain
      `pull_request` today, and that trigger loads the job DEFINITION from
      the pull request's own merge ref — not from the base branch. A pull
      request touching its own `.github/workflows/ci.yml` (or `test.yml`)
      can therefore rewrite the `lanes` job to `run: exit 0` and mint its
      own green required check. This is not specific to any one consumer —
      it is how `pull_request`-triggered CI works everywhere, and it
      predates every consumer this fleet has retrofitted. Codex found it
      reviewing unixtools#30 (mikelward/unixtools); the owner asked for it
      to be designed here rather than accepted as risk or patched ad hoc
      per consumer.

      **Not a new problem for this account** — `mikelward/codex-review`
      already solved the job-definition half of it for
      `codex-review-check.yml`, documented in its own `docs/CONSUMER.md`:
      trigger on `pull_request_target` instead of `pull_request`. GitHub
      loads that trigger's job definition from the **base** branch always,
      so a PR cannot alter what its own required check runs.

      **First pass at this design (superseded below) split the workflow**:
      `classify`/`lanes` on `pull_request_target`, the heavy `build`/`test`
      job left on plain `pull_request`, bridged by `workflow_run` or API
      polling. Codex found the fatal flaw in review: the heavy job's own
      workflow definition would STILL load from the PR's merge ref, so a
      PR could replace its build/test steps with `exit 0` while keeping
      the job name, and the "trusted" gate would faithfully read that fake
      success and publish `lanes: success` — the same hole, one hop
      removed. `check-consumer.yml` never ran into this because its heavy
      work is Codex's AI review, which "never checks out or executes pull
      request code at all" — `lanes` consumers are different in kind: the
      heavy job's entire job is to execute the PR's own code, which
      `codex-review` never had to solve.

      **The corrected design: move the WHOLE workflow to
      `pull_request_target`** — `classify`, the heavy job(s), and `lanes`
      together, not split. That fixes both halves of Codex's finding at
      once and removes the cross-run bridge entirely, since every job is
      now part of the same trusted run and `needs:` works normally again
      (this also answers Codex's second finding: `classify`'s
      `docs_only` output gates the heavy job via a plain `needs:`
      dependency in the same run, exactly as it does today — nothing
      cross-run to preserve).
      - `pull_request_target`'s default checkout is the BASE branch, not
        the PR — every job must explicitly check out
        `github.event.pull_request.head.sha` (the head) or
        `refs/pull/<pr>/merge` (the merge snapshot a normal `pull_request`
        run already tests) rather than relying on the default. Get this
        wrong and the heavy job silently builds `main`.
      - The heavy job still executes the PR's own arbitrary code — that
        was already true under plain `pull_request` and does not change.
        What `pull_request_target` adds is real risk ONLY if the job also
        holds secrets the executed code could exfiltrate. It must not:
        every consumer's heavy job already declares `permissions:
        contents: read` and nothing else, and that has to stay true here —
        no secrets, no elevated token, on any job that builds the PR's
        code. With nothing worth stealing, running that code under a
        trusted job definition is a strict improvement over today (job
        definition tamper-proof) with no new exposure (still arbitrary
        code execution on the runner, exactly as unavoidable under plain
        `pull_request` CI for any project that builds untrusted PRs).
      - This needs no `lanes.mjs` engine change and no new privilege
        (`statuses: write` etc.) — `classify`/`gate` keep reporting through
        their own Actions check-run, same mechanism as today, just under a
        trigger the PR branch cannot rewrite. It is a consumer-template
        change, not an action change, and is UNRELATED to the
        `workflow_dispatch` fix above beyond sharing this file — that one
        still needs its own `statuses: write` publisher mechanism if it is
        ever pursued; don't conflate the two designs again.

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
      through review, merging here only once it is green.

## Review and merge gates

- [ ] Verify the settings half of the fleet's bar — every repository works
      the same: comprehensive automated review, required merge gates, and
      auto-merge. The workflow files (CI and the codex-review set) are all
      present here; what git cannot show, and the 2026-08-18 audit could
      not verify, is the settings half: a ruleset on the default branch
      requiring the CI gate, the `codex` status, conversation resolution
      and up-to-date branches, and the auto-merge setting enabled.
