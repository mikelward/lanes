# SPEC

Decisions about this repository that are not visible from its code, recorded
so they are not re-litigated from scratch. A decision belongs here when it was
close, when the losing option keeps looking attractive, or when the reasoning
lives outside the files it affects.

## This repository does not run `lanes` on itself

**Decided:** no `classify` / `gate` jobs in `ci.yml`, and no
`.github/lanes.conf`. The suite runs on every pull request, unconditionally.

**Why: this is the security-sensitive one, so it stays simple.** Consumers
track `@main` and there is no release step, so a merge here is live in every
consumer's required check on their next pull request. What makes that
acceptable is that reading these files *is* reading what runs — no build, no
dependencies, and CI plain enough to check at a glance. Wiring the engine to
judge its own pull requests spends exactly that: it adds two jobs, a policy
file, a second required check, and a self-referential trust path, all around
the one thing everybody else is trusting unpinned. Machinery here is not free
the way it is in a consumer, because a mistake in it is a mistake in the
thing being trusted.

The self-reference is not hypothetical. Done the obvious way, with `uses: ./`,
a branch would be judged by its own copy of the engine: rewrite `isDocs` to
return `true`, skip every heavy job, and `gate` agrees, being the same
rewritten engine. Avoiding that means `classify` and `gate` must run
`mikelward/lanes@main` — so the lane would exercise the *previous* commit,
not the one under review. That is the shape this repository has already spent
twenty-five findings closing, and adding a fresh instance of it to guard a
sub-second suite is a bad trade.

**And there is nothing to skip.** The whole suite is about half a second,
nearly all of it Node's startup and the entry-point cases that spawn
subprocesses; a CI job here is dominated by checkout and `setup-node` either
way. The lane exists to skip heavy jobs. There are none. A consumer with a
real build is where it pays.

**The argument against, since it will come back.** The suite is entirely
unit-level against a stubbed API, so nothing here runs the engine *as an
action* — the manifest resolving, the runtime existing, the entry point
executing on a runner. That gap is real. It does not buy back the lane,
because the lane would test the previous commit anyway; and the coverage is
separable from it — one step running `uses: ./` inside the existing job would
get it with no policy file, no second required check, and no self-judging
path, since that job already executes the branch's code.

**Revisit if** this repository grows a job worth skipping. The separable
integration step can be added on its own merits at any time; it does not
depend on this decision.
