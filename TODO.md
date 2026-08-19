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
      own green required check. This is not a bug in the workflow_dispatch
      item above, or specific to any one consumer — it is how
      `pull_request`-triggered CI works everywhere, and it predates every
      consumer this fleet has retrofitted. Codex found it reviewing
      unixtools#30 (mikelward/unixtools); the owner asked for it to be
      designed here rather than accepted as risk or patched ad hoc per
      consumer.
      **This is not a new problem in this fleet — `mikelward/codex-review`
      already solved it for `codex-review-check.yml`, and
      `docs/CONSUMER.md` there is the reference.** The shape: trigger on
      `pull_request_target` instead of `pull_request`. GitHub loads that
      trigger's job definition from the **base** branch always, so a PR
      cannot alter what its own required check runs. `pull_request_target`
      is normally dangerous — it hands elevated permissions and secrets to
      whatever the job executes, and if that includes the PR's own code, a
      malicious PR can exfiltrate them — but `codex-review-check.yml`'s
      job never executes anything from the PR tree; it checks out the PR
      head only to parse it as data. That is what makes the trigger safe
      there, and it is true of `classify`/`lanes` here too: both call the
      `mikelward/lanes` action, which reads the pull request through the
      GitHub API and never checks out or runs anything the PR supplies.
      **The design, concretely:**
      - `classify` and `lanes` (gate) move to `pull_request_target`. Their
        job definitions become immune to PR-branch tampering, the same way
        `check-consumer.yml`'s is.
      - The consumer's own heavy job (`build`/`test`) STAYS on plain
        `pull_request` — sandboxed, no secrets, and it is the one job that
        legitimately has to build and run the PR's own code. Moving it to
        `pull_request_target` would trade this hole for the classic
        `pull_request_target` one: untrusted code running with real
        permissions.
      - `pull_request` and `pull_request_target` firing on the same file
        are two SEPARATE workflow runs, not two events in one run —
        `needs:` cannot bridge them, so the gate job cannot simply
        `needs: build` the way it does now. Bridge with either
        `workflow_run` (GitHub's documented pattern for exactly this: a
        privileged workflow that triggers on another workflow's
        completion and is always loaded from the default branch,
        regardless of what triggered the workflow it is reacting to) or
        have the trusted gate job poll the heavy job's check-run /
        commit-status directly via the API, matched by head SHA. Either
        way this is the SAME primitive as the workflow_dispatch fix above
        — a trusted, secrets-scoped process that re-attests to a result it
        read rather than one it computed — so one engine change plausibly
        closes both holes at once; design them together, not twice.
      - Inherited gotcha, hard-won in `codex-review`'s own history:
        `pull_request_target` sets `GITHUB_SHA` to the BASE branch tip, not
        the pull request head. Anything here that needs the head SHA must
        say `github.event.pull_request.head.sha` explicitly — never bare
        `github.sha` — the same discipline the workflow_dispatch fix above
        already requires.
      - Same privilege isolation as the dispatch fix: whatever token can
        write the final result belongs only on the dedicated gate job,
        never on the heavy job that executes the PR's own code.
      **Alternatives considered and why they are not the design:**
      - GitHub rulesets have a "require workflows to pass" rule type that
        may pin a required workflow's source independently of the PR
        branch. Not adopted as the design because its exact semantics are
        unverified — `docs.github.com` was unreachable while investigating
        this — so confirm directly against GitHub's current docs before
        relying on it; it may turn out to be a simpler answer than the
        `pull_request_target` split above, or unavailable on this account's
        plan.
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
