# SPEC

Decisions about this repository that are not visible from its code, recorded
so they are not re-litigated from scratch. A decision belongs here when it was
close, when the losing option keeps looking attractive, or when the reasoning
lives outside the files it affects.

## This repository runs `lanes` on itself — a reversed decision

**Decided (reversing the original):** `ci.yml` carries the same `classify` /
`test` / `lanes` structure every consumer does, with a `.github/lanes.conf`,
and the main ruleset to require `lanes codex zizmor` — the fleet standard,
with no exception — once the staged migration TODO.md records completes.
Until that flip the ruleset still requires `test` directly, which is why
the docs-only skip stays disabled for now (below): a skipped check the
ruleset still requires would count as satisfied unverified.
Requiring `zizmor` forced its workflow to drop the
`paths:` filter it was ported with: a paths-filtered workflow creates no
check run at all on a non-matching pull request (unlike a skipped job,
which reports "skipped" and satisfies a ruleset), so the filter and the
requirement cannot coexist. This repository pilots that change for the
fleet; the accepted cost, recorded in the workflow's header, is that a
PyPI outage now fails a required check instead of an advisory one.
The original decision — no lane here, `test` required
directly — stood on "there is nothing to skip," which is still true (the
suite is sub-second), but skipping was never what the reversal is about.

**Why it reversed: the integration gap, plus the exception's own cost.**
The suite is entirely unit-level against a stubbed API, so before this,
nothing here ran the engine *as an action* — the manifest resolving, the
runtime existing, the entry point executing on a runner. Consumers were the
first place that happened, on their weekly runs, after a merge here was
already live for all of them. Now every pull request here exercises the
action end to end before merging. And the original decision made this the
one repository whose merge-gate recipe differed, which every piece of fleet
tooling (repo-rules and its siblings) would have had to special-case
forever; the standard with zero exceptions beat the standard with one.

**The engine the lane's jobs run is `@main`, never `uses: $/`.** Done the
obvious way, with `$/`, a branch would be judged by its own copy of the
engine: rewrite `isDocs` to return `true`, skip the suite, and `lanes`
agrees, being the same rewritten engine. With `@main` the merged engine
judges the branch, and a pull request cannot tamper with the gate that
judges it. The cost is that classify and gate exercise the *previous*
commit's engine, not the one under review — acceptable, because the `test`
job runs the branch's own code, and that is where the correctness
protection lives. The branch's own *manifest* is exercised too, by the
separable step the original decision described: a `uses: $/` classify run
inside the `test` job, where it is safe because nothing gates on its
output — its exit status feeds the test job's result, which the `@main`
gate assesses. Without that step, a change to `action.yml`'s wiring would
first be loaded by Actions on consumers, after merging. `$/` is GitHub's
self-repository form rather than the workspace-relative `./`: Actions
resolves it to the running commit, so the manifest it loads is the pull
request's own as the repository holds it, independent of what any earlier
step left in the workspace — and zizmor's `self-repository` audit (1.30.0)
treats `./` as the finding it is.

**The accepted failure mode: a broken `main` wedges its own fix.** If a
merge breaks the engine badly enough that `mode: classify` or `mode: gate`
errors at runtime, the required `lanes` check goes red on the very pull
request that fixes it. That same broken `main` already wedges every
consumer's required check identically — this repository merely joins an
existing shared failure domain, as the one member where the fix must land.
Recovery is the repository admin editing the ruleset (or bypassing it) for
that one merge, restoring it after. Accepted deliberately: the event needs
a bug that both slipped the suite and crashes the engine at runtime, and
the alternative was permanent tooling exceptions to guard against it.

## The fleet standard is App-identity trusted publishing

**Decided (2026-09-09, owner):** the standard shape for a consumer's required
`lanes` check is the trusted-publishing form — the initializer/finalizer
posting the `lanes` status authenticated as a dedicated GitHub App, with the
App credential in a `lanes` environment restricted to the default branch, and
the ruleset requiring the `lanes` status from that App as its source. The
ambient form (the `classify`/`lanes` template that trusts the Actions
check-run) stays documented as the minimal fallback for a consumer that has
not provisioned the App, but it is not the standard: a same-repo pull request
can rewrite its own workflow definition or post its own `lanes` status, so the
ambient check is only as trustworthy as the branch it runs from.

**Why it is now a decision and not a hope.** The design carried a long
"unproven" caveat in `TODO.md` because it rested on three platform facts this
repository could not verify (docs.github.com was unreachable). All three are
now confirmed — `pull_request_target` source/ref is always the default branch;
environment branch policies evaluate against the execution ref, so a
default-ref policy admits the trusted jobs and refuses a PR-branch forgery; and
a ruleset can pin a required status to a specific App source. Together they
close the self-certification hole the caveat was about. See `TODO.md` for the
citations and the remaining rollout work (the consumer-workflow migration,
piloted on one consumer before merge, and the still-open `actions/cache`
question — the cache stays on until that has a real answer, because the
fleet's CI is expensive).

**One residual is accepted, not closed, and the standard owns it knowingly.**
Self-certification (forgery) is closed; freshness is not. If the App
credential goes bad — revoked, expired, the App uninstalled — a run can post
neither `pending` nor a fresh verdict, so a prior App-posted `lanes: success`
stands un-revalidated across a retarget or title edit, and a ruleset requiring
only `lanes` accepts it. This cannot be closed by an App-authenticated signal,
because the only thing the App can write is the `lanes` status itself and
minting the token to write it is exactly what is failing (round nine in
`TODO.md`). It is mitigated operationally — `init`/`finalize` job failures are
visible in the Actions tab, or a notification wired to them — not by a required
check. Adopting App-identity as the standard is a decision made with this gap
open, on the judgment that a forgery-closed gate with a visible
credential-health failure mode beats the ambient check it replaces; it is not
a claim that the gate is fail-closed in every mode.
