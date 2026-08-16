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
- **the gate** is the single check a ruleset should require. It reports on
  every pull request in either lane, and before it accepts a skip it
  re-derives the classification itself rather than trusting the job output
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

```bash
# Which paths cannot change what the heavy jobs validate.
# Ordered: the first arm that matches wins.
is_docs() {
  case "$1" in
    docs/REFERENCE.md) return 1 ;;  # compiled in; see the trap below
    *.md) return 0 ;;
    *) return 1 ;;                  # everything else is code
  esac
}

# The commit-subject prefixes this repository's conventions give
# docs-lane commits. On the docs lane every commit must carry
# one, so nothing on that lane reads like a behavior change.
LANE_PREFIXES="design docs todo test build refactor"
```

Optionally, if a dispatched run with no pull request is legitimate here:

```bash
dispatch_without_pr_ok() { return 0; }
```

### 2. The jobs

```yaml
jobs:
  classify:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      docs_only: ${{ steps.lane.outputs.docs_only }}
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

  gate:
    name: gate
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
          results: >-
            check=${{ needs.check.result }}
            msrv=${{ needs.msrv.result }}
```

Then require **`gate`** — and only `gate` — in the ruleset for your default
branch. Requiring a heavy job directly reintroduces the original trap: it
never reports on the docs lane, so nothing merges.

`permissions: contents: read` and `pull-requests: read` are enough; the engine
writes nothing.

## Why the policy is a file, not inputs

Both modes evaluate the policy. The gate's whole value is re-deriving the
classification *independently, under the same rules* — it distrusts
`classify`'s output, not `classify`'s policy. Passing the rules at each call
site would put two copies in one workflow, and an edit to one copy would leave
the gate re-deriving under rules `classify` never used: a required check
reporting green on validation it did not perform.

A file is one copy by construction. It also self-protects — a config file is
not documentation under any sane policy, so a pull request that edits the
lane's own rules classifies as **code** and runs the full heavy lane before
anything can act on the new rules.

A config that cannot supply a policy is refused rather than defaulted: a
missing file, one defining no `is_docs`, or one with an empty
`LANE_PREFIXES` all fail loudly. Defaulting would look like the safe direction
— full lane forever — while hiding a broken config indefinitely.

## Writing your policy

Start with markdown, and keep it boring:

```bash
is_docs() {
  case "$1" in
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}
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
asserts that anything documentation-shaped among them is classified as code by
your own `is_docs`. Then the day someone embeds a new file, CI says so
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

Bash, coreutils and `gh` — all three already on the runner. No build step and
nothing generated, so what consumers run is what a reader reads. `./lanes.test.sh`
runs the real engine against a stubbed `gh`, asserting both directions of every
behavior, and CI lints it at full shellcheck severity.

## License

MIT.
