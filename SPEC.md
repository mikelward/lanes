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

**The engine the lane's jobs run is `@main`, never `uses: ./`.** Done the
obvious way, with `./`, a branch would be judged by its own copy of the
engine: rewrite `isDocs` to return `true`, skip the suite, and `lanes`
agrees, being the same rewritten engine. With `@main` the merged engine
judges the branch, and a pull request cannot tamper with the gate that
judges it. The cost is that classify and gate exercise the *previous*
commit's engine, not the one under review — acceptable, because the `test`
job runs the branch's own code, and that is where the correctness
protection lives. The branch's own *manifest* is exercised too, by the
separable step the original decision described: a `uses: ./` classify run
inside the `test` job, where it is safe because nothing gates on its
output — its exit status feeds the test job's result, which the `@main`
gate assesses. Without that step, a change to `action.yml`'s wiring would
first be loaded by Actions on consumers, after merging.

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
