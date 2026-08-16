# AGENTS.md

Conventions for AI agents working in this repository.

`CLAUDE.md` is a symlink to this file, so every agent reads the same
conventions. Edit `AGENTS.md`.

This repository is one GitHub Action: a shell engine that sorts a pull request
into a CI lane -- code or docs -- and a gate that re-derives that
decision before a skip is allowed to count. Consumers track `@main`, so **a
merge here reaches every consumer's required check on their next pull
request, with no release step in between.** Everything below follows from that.

Keep this file as short as it can be and still work. Every session loads it
whole, so each rule costs context on every turn: add one the first time
something bites, say it once in the fewest words that carry the *why*, rewrite
or trim an existing rule rather than appending beside it, and delete one that
has stopped biting.

## What this repository is for

- **The engine is shared; the policy is not.** A consumer supplies its own
  config — which paths are docs, which commit-subject prefixes the lane
  accepts, whether a dispatched run without a pull request is legitimate — and
  nothing else. Everything a consumer would have to think about twice belongs
  here; everything that differs between repositories belongs there.
- **This exists because copies drift.** The engine lived as a duplicated
  `scripts/docs-lane.sh` in several repositories with a comment asking whoever
  edited it to edit the others too. That is a manual invariant with no
  enforcement, which is the kind that decays quietly. If a change here would
  need a matching hand-edit in a consumer, it is the wrong change.

## What this repository must not grow

- **No dependencies beyond bash, coreutils and `gh`.** The runner supplies all
  three. The engine is read by people deciding whether to trust it with a
  required check, and an unpinned reference is only reviewable if reading the
  files *is* reading what runs.
- **The gate must fail closed.** Every path that cannot prove a skip is
  justified — a truncated API response, a missing pull request, an
  unclassifiable file — refuses the skip rather than allowing it. A gate that
  errs toward green is worse than no gate, because the ruleset reports it as
  verification that did not happen.
- **The required check's name is a consumer's branch-protection contract.**
  Renaming it orphans every rule naming it silently: the rule waits for a check
  nothing reports, and merges stop. A change there is a migration note in every
  consumer, not a tidy-up.

## Testing

- `./lanes.test.sh`. No install step; it stubs `gh` and runs the real
  engine against fixtures.
- **Add or update tests with any change**, and assert **both directions** of
  every behavior — that a docs diff skips *and* that a code diff does
  not. This suite is the only thing between a push and every consumer's merge
  gate, so a change that ships untested ships unreviewed.
- The suite's failure mode is a *false pass*: a fixture that stops reaching the
  branch it names still goes green. Where a case depends on the stub returning
  something specific, assert that it did.
- **Fix any preexisting test failure as the *first* commit of the series.**
  Don't stack new work on a red baseline.
- **Don't disable a failing check** to make it pass, and don't paper over a
  flaky one with sleeps or retries — fix the underlying issue.

## Error handling

- **Don't silently swallow errors.** A bare `2>/dev/null`, an unchecked exit
  status, or a `|| true` hides real failures. Report what failed with enough
  context to identify it, clean up what the failed step created, and decide
  explicitly what the caller sees. To ignore a specific failure, say why in a
  one-line comment.

## Git and pull requests

- **Branch naming.** `<agent>/<short-topic>` — `claude/...` for Claude Code,
  `codex/...` for Codex. One topic per branch; never commit to `main`.
- **One commit per logical change.** Rewrite unmerged commits freely — amend,
  `--fixup` + autosquash, squash, reorder, split — so each commit that lands is
  coherent, with review responses folded into the commit they belong to.
  `--force-with-lease` after a rebase, never a bare `--force`.
- **Open the pull request without being asked**, ready for review, not a draft.
- **Refresh the title and body on every push** so they describe the branch's
  latest state, not the scope it had when opened.
- **Codex is the automated reviewer**, and its reviews are triggered
  automatically. Address its comments without being asked, folding each fix
  into the commit it belongs to. Judge every comment on merit: verify the claim
  before acting, and if it doesn't hold up, reply saying why and decline.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.

## Language and spelling

- Use **US English** everywhere people read English: prose, commit subjects and
  bodies, pull request titles and descriptions, comments, and identifiers —
  `behavior` not `behaviour`, `canceled` not `cancelled`.

## Commit messages

- A clear, plain-English subject in sentence case, short (≤ ~70 chars) and free
  of internal jargon. Mechanism and file:line detail go in the body, after a
  blank line.
- **Prefix a subject that does not change what a consumer runs**: `docs:` for
  prose, `test:` for tests alone, `build:` for this repository's own CI, and
  `refactor:` for deliberately behavior-preserving code. A bare subject means a
  consumer could notice the difference. There is no `feat:` or `fix:`, on
  purpose — they would prefix nearly everything and leave the log as flat as it
  started.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, pull request text, review replies, branch names,
  comments, or fixtures. That covers absolute paths containing a real name,
  hostnames, private remote URLs and tokens. Use generic placeholders
  (`/home/user/project`, `git@example.com:org/repo.git`) in examples and
  fixtures.
