# lanes

Sorts a pull request into one of two CI lanes — code or docs — and
holds one required check that refuses to bless a skip nothing justified.

## Why this exists

A branch-protection rule can only require checks *by name*, and a required
check that never reports blocks the pull request forever. So the obvious
implementation — a `paths:` filter that skips the workflow for
documentation-only diffs — is exactly the trap: the check never runs, so it
never reports, so nothing merges.

The way around it is to let every pull request run the workflow, and move the
decision inside:

- **the code lane** is the default and the common case — every heavy job runs;
- **the docs lane** lets those jobs skip when nothing in the diff can
  change what they would validate;
- **the gate** is the single check a ruleset should require — conventionally
  named `lanes` in a consumer's workflow (see Usage below); "gate" is the
  engine's own term for the mechanism, not the label it ships under. It
  reports on every pull request in either lane, and before it accepts a skip
  it re-derives the classification itself rather than trusting the job output
  that caused it.

Most of what is here is the gate refusing things: a truncated file listing, a
commit heading more than one open pull request, a dispatched run that names a
different pull request than the commit belongs to, a docs-lane commit whose
subject reads like a behavior change. A gate that errs toward green is worse
than no gate, because the ruleset reports it as verification that never
happened.

## Usage

Two jobs, plus a policy file.

### 1. The policy — `.github/lanes.conf`

The path is fixed, and symlinks anywhere along it are refused. It is not an
input: making it configurable meant working out which file was *actually*
being read, and every route into that — a symlinked file, a symlinked
directory, a link chain, a `..` segment, an absolute spelling — was a way to
change the rules while the guard watched a different name.

The spelling must match the directory listing, for the same reason. A
case-insensitive runner (macOS, Windows) opens `.github/LANES.conf` through
the lowercase path quite happily while the files API reports the repository's
own spelling — leaving the engine reading a policy under a name no guard
recognizes.

```
# Ordered: the FIRST matching rule wins, and anything matching no rule is code.
code docs/REFERENCE.md    # compiled in by a test; see the trap below
docs *.md
docs docs/*.md

# Commit-subject prefixes the docs lane accepts. On that lane every commit
# must carry one, so nothing riding it reads like a behavior change.
prefixes design docs todo test build refactor

# Optional; defaults to refuse. `allow` accepts a PR-less dispatch against
# ANY ref -- including a pull request's own branch, running that branch's own
# copy of this workflow -- so prefer `allow-on-default-branch` for the one
# legitimate case, a maintainer's release-force dispatch with no pull request
# to name. It takes no argument: the allowed branch is always the
# repository's own default, fetched fresh from the API at verification time
# -- never a name this file supplies, because this file itself is read from
# whatever branch the dispatch checked out, and a policy-named branch would
# let an attacker's own branch simply name itself.
dispatch-without-pr refuse

# Optional; defaults to YES. Whether the PULL REQUEST TITLE must carry a prefix
# too. Two independent reasons: under a SQUASH merge the title is the subject
# that lands, so linting only the commits leaves it unchecked; and whatever the
# merge strategy, the title is what the pull request LIST shows, so a prefix
# says at a glance whether a pull request changes what the app does. On by
# default because the errors are asymmetric — off when it was wanted is silent,
# on when it was not is a red check naming the one-line fix. Set it to `no` if
# neither reason applies; the commit subjects are linted either way.
lint-title yes
```

**`*` never crosses `/`.** Matching is `path.matchesGlob`, Node's own, rather
than anything written here — deliberately. The hand-rolled matcher this
replaced cost three review rounds (`*` crossing `/`, `**/` failing to match
zero segments, a mixed `a/**/b/**/c` combination), every one of which the
standard implementation gets right without being asked:

| pattern | matches |
|---|---|
| `*.md` | `README.md` — **not** `docs/DESIGN.md` |
| `docs/*.md` | `docs/DESIGN.md` — **not** `docs/a/B.md` |
| `**/*.md` | markdown at any depth, `README.md` included |
| `docs/**` | everything under `docs/` |

Full-line comments start with `#`; a trailing comment starts at
whitespace-then-`#`, so a pattern cannot contain `" #"`. An unknown directive
is an error rather than a skipped line — a typo silently ignored is a policy
that quietly does less than it says.

### 2. The jobs

```yaml
on:
  pull_request:
    # `edited` is load-bearing, not tidiness. A retarget changes what the diff
    # is measured against while the head -- and any `lanes` check run already
    # minted on it -- stays exactly where it was, so a base change has to start
    # a fresh run or the old verdict simply stands. Title and body edits re-run
    # too, deliberately: the title is a subject a squash merge lands, and
    # skipping `lanes` on a "harmless" edit would be worse than running it,
    # because GitHub counts a SKIPPED required check as satisfied.
    types: [opened, synchronize, reopened, edited]

jobs:
  classify:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      docs_only: ${{ steps.lane.outputs.docs_only }}
      base_sha: ${{ steps.lane.outputs.base_sha }}
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
      - uses: mikelward/lanes@main
        id: lane
        with:
          mode: classify
          pr: ${{ github.event.pull_request.number }}

  # ... your heavy jobs, each with:
  #   needs: classify
  #   if: needs.classify.outputs.docs_only != 'true'

  lanes:
    name: lanes
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [classify, check, msrv]
    if: always()
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
      - uses: mikelward/lanes@main
        with:
          mode: gate
          pr: ${{ github.event.pull_request.number }}
          classify-result: ${{ needs.classify.result }}
          # Only read on a dispatched run, and harmless on a pull_request one,
          # which takes the same commit from its own event payload. Wire it
          # anyway: without it a PR-bound workflow_dispatch cannot certify a
          # green, because nothing else records the base the heavy jobs built
          # against — `lanes` runs after them.
          base-sha: ${{ needs.classify.outputs.base_sha }}
          results: >-
            check=${{ needs.check.result }}
            msrv=${{ needs.msrv.result }}
```

Then require **`lanes`** — and only `lanes` — in the ruleset for your default
branch. Requiring a heavy job directly reintroduces the original trap: it
never reports on the docs lane, so nothing merges.

`permissions: contents: read` and `pull-requests: read` are enough; the engine
writes nothing.

### Trusted publishing

The template above trusts the ambient Actions check-run to report `lanes`'s
own pass/fail -- which is only as trustworthy as the job DEFINITION that
produced it, and under plain `pull_request` that definition is the pull
request's own copy. A pull request touching its own workflow file can rewrite
the `lanes` job to `exit 0`.

`mode: init` and two new inputs, `app-id`/`app-private-key`, are the
alternative: authenticate as a dedicated GitHub App and post the `lanes`
commit status directly, by API call, onto the exact commit the triggering
event named -- never trusting whichever commit the ambient check-run happens
to attribute a job to. Supply neither input and nothing changes: `gate` mode
behaves exactly as it always has. Supply both and `gate` mode additionally
publishes the terminal status this way, and a new no-checkout `init` job (no
`needs:`, first in the graph) posts `pending` before anything else runs:

```yaml
jobs:
  init:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: lanes
    permissions:
      statuses: write
    steps:
      - uses: mikelward/lanes@main
        with:
          mode: init
          app-id: ${{ secrets.LANES_APP_ID }}
          app-private-key: ${{ secrets.LANES_APP_PRIVATE_KEY }}

  # ... classify and your heavy jobs, as above ...

  finalize:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [init, classify, check, msrv]
    if: ${{ !cancelled() }}
    environment: lanes
    permissions:
      statuses: write
      pull-requests: read
      contents: read
    steps:
      - uses: actions/checkout@v5
        with: { persist-credentials: false }
      - uses: mikelward/lanes@main
        with:
          mode: gate
          # ...same inputs as above, plus:
          app-id: ${{ secrets.LANES_APP_ID }}
          app-private-key: ${{ secrets.LANES_APP_PRIVATE_KEY }}
```

**Require only the App-posted `lanes` status -- never `init` or `finalize`'s
own Actions check-run.** It is tempting to require those too, on the
reasoning that neither mode swallows a failure to authenticate or publish
(both re-throw), so the job that hit it reports red -- and an earlier
revision of this section said exactly that. It is wrong, and the reason is
the same fact this whole design already turns on: under `pull_request_target`
GitHub attributes a job's own ambient check-run to `GITHUB_SHA`, which is the
BASE branch's tip, not the pull request's head. Requiring `init` or
`finalize` by name would leave the pull request's own head waiting forever
for a check that only ever reports on `main`'s tip -- blocking every merge
through this pattern, not protecting it. The job is still named `finalize`
rather than `lanes`, so its own check-run in the Actions tab is never
visually confused with the App-posted status of the same name, but that
check-run is not, and cannot be, part of what the ruleset requires.

**This leaves one gap genuinely open, not solved.** A run whose App
credential has gone bad -- revoked, expired, the App uninstalled -- cannot
post `pending` or a fresh verdict at all, so whatever `lanes: success` a
PREVIOUS, healthy run already posted on that commit simply stands,
un-revalidated, across a retarget or title edit that should have started a
fresh one. There is no App-authenticated signal available to close this: the
only thing the App can write is the `lanes` status itself, and minting the
token to write it is exactly what is failing. Watch `init`/`finalize`'s own
job failures in the Actions tab (or wire a notification to them) as an
operational signal instead -- they are real and visible there, just not
something a required check can act on. See `TODO.md`.

**Both jobs above declare `environment: lanes`, and that is not optional.**
Without it, an environment-scoped secret is invisible to the job regardless
of what the workflow references -- `init` fails authentication outright, and
`gate` silently falls back to the ambient check-run instead of publishing
through the App, defeating the whole mechanism with no error to notice it by.
Name the environment whatever you like, but every job reading either secret
needs it, not just the one that happens to be listed first.

**This is the mechanism, not yet the whole pattern.** The App credential must
live in a GitHub Environment restricted to your trusted base ref, never a
bare repository or organization secret -- a same-repo pull request's own
`push`-triggered workflow can read a bare secret exactly as the legitimate
jobs do. And publishing the status correctly is only half of what a
`pull_request_target`-based rollout needs: `classify` and every heavy job
still have to move to that trigger too, check out the merge snapshot rather
than the head, and reference no `secrets.*` anywhere, or the tampering this
exists to close reopens one hop over. See `TODO.md` for what is proven here
and what is still open before rolling this out on a consumer.

### Renaming an existing consumer's check

The instruction above is for a fresh install. An existing consumer whose
ruleset already requires the old name cannot get to a new one by editing the
job and the ruleset in either order: rename the job first and the ruleset
waits forever for a check nothing publishes any more; rename the ruleset
first and it waits forever for a check nothing has published yet. Either way
every merge blocks — this is the same "check that never reports" trap the
gate exists to avoid, self-inflicted by the rename.

There is no single atomic step, but there is a safe *sequence*, because
adding a required check and removing one carry different risk: adding one
that has never reported blocks every merge; removing one never does.

1. **Add the new job alongside the old one**, both running `mode: gate` —
   don't rename the existing job yet. This PR still satisfies the ruleset
   (the old name still reports) while making the new name report for the
   first time. Merge it.
2. **Confirm the new name has reported successfully on a `pull_request`
   run** — this PR's own run. Not a push to your default branch, even if
   you've wired one: `gate`'s all-heavy-jobs-green path reports success
   without checking the run is still bound to a pull request at all when
   there is no `pr` to bind to, which is exactly the case for a push event —
   so a green push run confirms nothing about the path a required check
   actually exercises. And if any *other* pull request is open, its head
   predates step 1 and has never run the new job either. Flipping the
   ruleset while one of those sits unrebased leaves it waiting on a check
   that will never report against its current head, same as the trap this
   sequence exists to avoid. Wait for each open PR's next ordinary push (or
   update it yourself) before moving on, not just the PR that added the job.
3. **Flip the ruleset** to require the new name instead of the old one. A
   tool that refuses to require a check that has never reported (as
   `mikelward/scripts`' `repo-rules` does) turns step 2 into an enforced
   precondition rather than a thing to remember.
4. **Remove the old job** now that nothing requires it. This PR's head only
   publishes the new name, which the ruleset (as of step 3) already accepts.

Steps 1 and 4 are ordinary pull requests; step 3 is the one that touches
branch protection outside a PR, and it is the only step where getting the
order wrong reintroduces the block step 1 was there to prevent.

## What binds a verdict to the diff it was computed for

A check run lands on a commit, and is read by whatever the pull request looks
like *later*. Those two drift apart constantly in normal use — a force-push, a
retarget, a stacked base moving underneath, a second pull request opened on the
same head — and every one of them ends with a verdict labelling work nobody
verified. So a verdict is bound at both ends:

- **To its own trigger.** The head and base the run was started for come from
  the event payload (`GITHUB_EVENT_PATH`), not from inputs — a consumer cannot
  forget to wire them, and a run outlived by a force-push refuses rather than
  judging the replacement's diff. The base is checked by **ancestry**, for every
  base: an ordinary advance leaves the event's base commit an ancestor of the
  tip and is fine, while a rewrite is refused. Exempting a branch for being the
  default one would assume a branch protection no consumer has promised.
- **To exactly one pull request.** A commit can head several open ones, and the
  check is per-commit — so a gate minted for the docs one would satisfy the
  code one. Ambiguity is refused, not resolved.
- **After the fact, not only before it.** Every listing answers with the *current*
  state, so the binding is re-read after the diff and after the prefix lint, and
  a pull request that moved in between is refused. The `edited` and `synchronize`
  events start a fresh run but cancel nothing, so both verdicts would otherwise
  land on the same commit with no ordering between them.
- **To one base commit, exactly, on both verdicts.** At settlement the **event's**
  base commit must still be the branch tip. *Exact* rather than un-rewritten,
  because ancestry is not enough on either path: green rests on the heavy jobs
  having built `merge(head, base)`, and a skip — which looks laxer, resting on a
  classification rather than evidence — is not, since `base...head` is measured
  from the **merge base**, so advancing the base *into the head's own history*
  **drops** commits from the diff rather than adding paths to it, and a head
  that changes code and then reverts it reads as documentation from the old base
  and as code from the new one. The *event's* commit rather than the tip the run
  read, because the two verdicts rest on bases read at different moments — the
  heavy jobs built against the base near the event, the classification against
  the tip when the gate runs — so pinning the live tip guards one and lets the
  other go stale. Requiring the event's commit to still be the tip collapses the
  difference. The window is only as long as the run, and the remedy is the
  ordinary one — GitHub's own *require branches to be up to date*, or one push.

### Require branches to be up to date

**Turn on *require branches to be up to date before merging* in the ruleset, next
to requiring `lanes`.** It is a prerequisite, not a nicety, and it is what keeps a
published verdict honest.

A check run lands on a commit; the ruleset reads it whenever you press Merge.
Between those two moments the diff can change out from under it in two ways — the
pull request is **retargeted**, or someone **pushes to the base branch** — and
both move the merge base, so `base...head` is no longer what was classified. A
skip blessed against the old diff is still sitting there, green.

Nothing inside a GitHub Action can expire a check that has already been
published. The up-to-date requirement is GitHub refusing the merge instead: the
head is behind, so the branch must be updated, and updating it pushes a commit
that re-runs everything.

**It does not cover every retarget, and the gap is worth knowing.** It fires when
the head is *behind* the new base. Retarget to a branch the head is already
**ahead** of — an older release branch that `main` has since moved past — and the
head already contains it, so nothing is behind and nothing is forced. The diff is
now everything between that branch and the old base, none of which was
classified, and the old green skip still stands. **Keep `edited` in your
`pull_request` types** (the example above has it): that is what starts a fresh
run on a retarget, and it is the half the up-to-date rule cannot reach. The two
together cover both directions; neither alone does.

An earlier version of this action tried to answer the same question by reading
the caller's workflow and looking for an `edited` trigger. It is gone, and the
reasons are worth keeping: it took a dozen review findings to approximate a YAML
parser and the list of valid spellings never ended; it could be handed a
different file than the one that started the run; and — decisively — `edited`
fires on a retarget but **nothing at all fires when the base branch is pushed
to**, so it was blind to half the problem by construction.

If you cannot use the setting, the fallback is a single-writer sweep that
recomputes and republishes `lanes` when the base moves. Note *single-writer*: two
workflows publishing one check is an ordering race, and the PR's own run would
have to stop publishing `lanes` for the sweep to own it. A sweep is also
eventually consistent, so it narrows the window rather than closing it — a
backstop, not a replacement for the setting.

## Why the policy is data, and at a fixed path

Both modes evaluate the policy. `gate`'s value is re-deriving the
classification **independently, under the same rules** — it distrusts
`classify`'s *output*, not `classify`'s *policy*. A file is one copy by
construction; rules passed at each call site would be two copies in one
workflow, and an edit to one would leave the gate re-deriving under rules
`classify` never used.

**The policy never executes.** It is parsed as data, and that is the whole of
the trust story. It began as a sourced shell file, which took four review
rounds to establish was indefensible: on a `pull_request` event the checkout
is the merge ref, so the file is the *pull request's* copy — and a sourced
file **is** the shell. It controlled the engine's argv (a config holding
`set -- classify` made `gate` run the classify arm and exit 0 without reading
its inputs), the environment read afterwards, `PATH`, and even the API client.

**The path is fixed and symlinks are refused**, so there is nothing to
resolve. That replaced five review rounds of resolution logic, all of it
defending a knob nobody had asked for.

**And the engine, not the policy, decides that the policy file is code.**
Asking the policy whether edits to the policy need review lets a pull request
answer the one question its answer must not decide — and the gate would agree,
being independent of `classify`'s output but not of the rules they share.

A policy that cannot supply rules is **refused, not defaulted**: a missing
file, no rules, no prefixes, an unknown directive. Defaulting would look like
the safe direction — full lane forever — while hiding a broken config
indefinitely.

## The two modes fail in opposite directions, on purpose

**`classify` never fails.** It answers one question — may the heavy jobs
skip? — and every failure to establish "yes" is "no", which runs them: a
truncated listing, an unreadable count, a 500 from the API, an unreadable
policy, a run that cannot be bound to its own pull request. The reason is
reported as a `::warning::` rather than swallowed.

**`gate` fails on all of it.** There the same failure means an
already-taken skip cannot be justified, and blessing it would be the forged
verdict this exists to prevent.

That asymmetry is safe because the gate repeats every check classify shrugs
off — it re-reads the policy, re-verifies the binding, and re-derives the
classification before accepting a skip. So nothing is waved through: a broken
policy still turns the required check red, one job later, having run the full
lane in the meantime.

Reading it backwards costs something either way. A gate that shrugged would
bless any skip during an API outage; a classify that failed hard turned a
transient blip into a blocked pull request, since the gate refuses when
`needs.classify.result` is anything but success.

## Writing your policy

Start with markdown, and keep it boring:

```
docs *.md
prefixes docs test build
```

The direction to move in is **narrower, not wider** — ideally only markdown
under a dedicated `docs/` tree. "Dotfile" is a naming convention rather than a
semantic category (`.npmrc` changes dependency resolution, `.nvmrc` picks a
runtime, `.gitignore` can hide files from CI's own staging steps), so nothing
rides the lane by looking incidental. Every widening is a chance to skip a job
that would have caught something; every narrowing costs only time.

### The trap: build inputs that do not look like build inputs

This is the one that will bite you, because the file gives no sign of it.

A repository can embed a documentation file into what it builds or tests, and
then that file is a build input wearing a `.md` extension:

- Rust: `include_str!("../../docs/REFERENCE.md")` compiles the file into the
  binary, and a test can assert on its contents. `#![doc = include_str!(...)]`
  goes further and runs the code fences in it as doctests.
- JavaScript: a snapshot or fixture test that reads a `.md` file.
- Anything with a generator or a `build.rs` that reads files at build time.

A real example: one consumer has a test that parses `docs/REFERENCE.md` and
asserts every builtin it names matches the code's actual option handling — a
guard written *because* that prose had gone stale once. Under a plain `*.md`
policy that file rides the docs lane, so editing it skips the very
test that exists to catch editing it wrong.

**Do not solve this with a hand-maintained exclusion list.** It drifts exactly
like the prose did, and it drifts silently. Derive it: have a test that scans
your source for embedding constructs, resolves each referenced path, and
asserts that anything documentation-shaped among them is matched by a `code`
rule in your policy. Then the day someone embeds a new file, CI says so
— which is the only moment anybody has the knowledge.

That test belongs in the consumer, not here: which constructs embed files is a
property of your language, and this engine deliberately knows nothing about
your repository beyond the policy you hand it.

## What the gate refuses

Each of these is a case where a skip *looks* justified and is not:

- **A truncated listing.** The files endpoint caps at 3,000 and the commits
  endpoint at 250, both exiting cleanly, so a naive read silently sees a
  prefix of the diff. Both counts are reconciled against the pull request's
  own figures before anything is classified.
- **A rename out of code.** A rename carries its new path and its old one;
  judging only the new side would let a source file renamed into `docs/` ride
  the docs lane while deleting code.
- **A shared head.** A commit can head more than one open pull request
  (stacked branches), and a check run is per-commit — so a gate minted for a
  docs-lane pull request's justified skip would satisfy a stacked code pull
  request's required check too. Shared heads classify as code.
- **A mis-bound dispatch.** `--ref` picks the branch and `-f pr=` supplies the
  number independently, so nothing else stops a dispatch on code PR A's branch
  from naming docs-only PR B and landing B's clean verdict on A's head.
- **An unprefixed subject.** Merge commits are exempt structurally, by parent
  count — a commit whose subject merely starts with "Merge" is not one.

## Versioning

There is none: consumers track `@main`, and whatever `main` points at is what
they run. That is the feature — a fix reaches every consumer without a pull
request in each one — and it is why every change here goes through a pull
request with the suite green before it merges.

The failure direction is what keeps that boring: a broken engine makes the gate
**red**, which blocks merges rather than letting anything through. The bad case
is a stalled gate that a revert clears, not a forged verdict.

## No dependencies, on purpose

Node's standard library, nothing else — no `package.json`, no lockfile, no
build step. What consumers run is the source in this repository, which is what
lets an unpinned `@main` reference be reviewed by reading it: `main.mjs` is the
entry point the manifest names and does nothing but call into `lanes.mjs`,
which defines and exports and never invokes. The two were one file, separated
by an `import.meta.url === \`file://${process.argv[1]}\`` guard — a URL
compared against a path, which differ under a checkout containing a space or a
`#`, and the failure was the gate exiting 0 without reading the diff.
`node --test lanes.test.mjs workflows.test.mjs` runs the real engine against a
stubbed API, asserting both directions of every behavior, and pins this
repository's own workflows.

## License

MIT.
