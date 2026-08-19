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

## Review and merge gates

- [ ] Verify the settings half of the fleet's bar — every repository works
      the same: comprehensive automated review, required merge gates, and
      auto-merge. The workflow files (CI and the codex-review set) are all
      present here; what git cannot show, and the 2026-08-18 audit could
      not verify, is the settings half: a ruleset on the default branch
      requiring the CI gate, the `codex` status, conversation resolution
      and up-to-date branches, and the auto-merge setting enabled.
