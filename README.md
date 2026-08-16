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

The path is fixed, and symlinks anywhere along it are refused. It is not an
input: making it configurable meant working out which file was *actually*
being read, and every route into that — a symlinked file, a symlinked
directory, a link chain, a `..` segment, an absolute spelling — was a way to
change the rules while the guard watched a different name.

```
# Ordered: the FIRST matching rule wins, and anything matching no rule is code.
code docs/REFERENCE.md    # compiled in by a test; see the trap below
docs *.md
docs docs/*.md

# Commit-subject prefixes the docs lane accepts. On that lane every commit
# must carry one, so nothing riding it reads like a behavior change.
prefixes design docs todo test build refactor

# Optional; defaults to refuse.
dispatch-without-pr refuse
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
build step. What consumers run is the file in this repository, which is what
lets an unpinned `@main` reference be reviewed by reading it.
`node --test lanes.test.mjs` runs the real engine against a stubbed API,
asserting both directions of every behavior.

## License

MIT.
