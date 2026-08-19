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
      equivalent), rather than relying on the automatic per-job check-run
      GitHub attributes to the dispatch ref. That needs `statuses: write`
      (more privilege than any consumer workflow holds today), new code and
      tests here, and its own pull request piloted against this repo before
      any consumer adopts it — see the root README's "pilot before merge"
      convention. Until this lands, no consumer's `workflow_dispatch`
      documentation should recommend `--ref <PR-head-branch>` as a way to
      satisfy a PR's required check.

## Review and merge gates

- [ ] Verify the settings half of the fleet's bar — every repository works
      the same: comprehensive automated review, required merge gates, and
      auto-merge. The workflow files (CI and the codex-review set) are all
      present here; what git cannot show, and the 2026-08-18 audit could
      not verify, is the settings half: a ruleset on the default branch
      requiring the CI gate, the `codex` status, conversation resolution
      and up-to-date branches, and the auto-merge setting enabled.
