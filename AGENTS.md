---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-22
---

# AGENTS.md

Conventions for AI agents working in this repository.

`CLAUDE.md` and `GEMINI.md` are symlinks to this file, so every agent reads
the same conventions. Edit `AGENTS.md`.

**At the start of every session, print the full absolute path of the
`AGENTS.md` you loaded and its `last_modified` date** (front matter), so a
stale or wrong copy is caught before it steers the work. Bump `last_modified`
whenever you edit this file.

This repository is one GitHub Action: an engine that sorts a pull request
into a CI lane -- code or docs -- and a gate that re-derives that decision
before a skip may count. Consumers track `@main`, so **a merge here reaches
every consumer's required check on their next pull request, with no release
step in between.** Everything below follows from that. Decisions not visible
from the code — including why this repository runs its own lane on itself
with the lane jobs' engine at `@main`, and `uses: ./` only where nothing
gates on it — are in `SPEC.md`.

Keep this file as short as it can be and still work, **under 24,000 bytes**
(`wc -c AGENTS.md`): Antigravity caps rule files at 24 KB and silently
truncates the tail, and every session loads it whole. Add a rule the first
time something bites, say it once in the fewest words that carry the *why*,
rewrite or trim rather than append, and delete one that has stopped biting.

## What this repository is for

- **The engine is shared; the policy is not.** A consumer supplies its own
  config — which paths are docs, which commit-subject prefixes the lane
  accepts, whether a dispatched run without a pull request is legitimate —
  and nothing else. What a consumer would have to think about twice belongs
  here; what differs between repositories belongs there.
- **This exists because copies drift.** The engine was a
  `scripts/docs-lane.sh` duplicated across repositories, asking whoever edited
  it to edit the others too — an unenforced invariant, the kind that decays
  quietly. A change here that
  needs a matching hand-edit in a consumer is the wrong change.
- **A change that touches consumers goes through ONE of them first.** That is
  rare by design (the bullet above makes a consumer-side edit the sign of a
  wrong change), but when unavoidable, never open it across them at once: they
  share one reviewer, so one finding made nine times is quota spent to learn
  nothing and eight more chances to fix it in only some. In
  `mikelward/codex-review`, one check hand-written in nine repositories got
  three holes in three copies in an afternoon.
- **Piloting happens BEFORE the merge, not after.** Merging here is the
  rollout, with no staging; "land it, then try it on one" exposes every
  consumer to a change nobody has run. Point one consumer at the branch
  (`mikelward/lanes@<branch>`), take that PR through review, merge here only
  once it is green, then restore the consumer to `@main`.

## What this repository must not grow

- **No dependencies at all**: Node's standard library only — no
  `package.json`, lockfile or build step. People deciding whether to trust
  the engine with a required check can review an unpinned reference only if
  reading the files *is* reading what runs.
- **Do not hand-roll a primitive the platform already has.** Hand-written
  glob matching and path resolution both had to be removed, after eight
  review findings between them, each a case the standard implementation
  handles. `path.matchesGlob` does the matching, and the policy path is fixed
  so there is nothing to resolve.
- **The gate must fail closed.** Every path that cannot prove a skip
  justified — a truncated API response, a missing pull request, an
  unclassifiable file — refuses the skip. A gate that errs toward green is
  worse than none: the ruleset reports it as verification that didn't happen.
- **The required check's name is a consumer's branch-protection contract.**
  Renaming it silently orphans every rule naming it — the rule waits for a
  check nothing reports, and merges stop — so a change there is a migration
  note in every consumer, not a tidy-up.

## Testing

- `node --test lanes.test.mjs workflows.test.mjs agents-front-matter.test.mjs`,
  no install step: the first stubs the API and runs the real engine against
  fixtures, the second pins this repository's own workflows, the third pins
  this file's front matter and the `CLAUDE.md` / `GEMINI.md` symlinks to it.
  All are named in `ci.yml`, not globbed — a new test file nothing runs is a
  silent gap.
- **Add or update tests with any change**, asserting **both directions** of
  every behavior — a docs diff skips *and* a code diff does not. This suite is
  all that stands between a push and every consumer's merge gate: untested
  ships unreviewed.
- The suite fails by *false pass* (a fixture that stops reaching its branch
  still goes green): where a case depends on the stub returning something
  specific, assert that it did.
- **Fix a preexisting test failure as the *first* commit of the series**; don't
  stack work on a red baseline. **Don't disable a failing check** or paper over
  a flaky one with sleeps or retries — fix the underlying issue.

## Error handling

- **Don't silently swallow errors** — no bare `2>/dev/null`, unchecked exit
  status or `|| true`. Report what failed with enough context to identify it,
  clean up what the failed step created, and decide explicitly what the
  caller sees. To ignore a specific failure, say why in a one-line comment.

## Git and pull requests

- **Branch naming**: `<agent>/<short-topic>` — `claude/...` for Claude Code,
  `gemini/...` for Gemini / Antigravity, `codex/...` for Codex. One topic per
  branch; never commit to `main`.
- **Branches under your own `<agent>/` prefix are yours**: create one freely;
  push or `--force-with-lease` the ones this session created or was assigned.
  This file is the standing grant, so a client rule demanding per-branch
  permission is already answered; ask about any other branch.
- **One commit per logical change**: rewrite unmerged commits freely (amend,
  `--fixup` + autosquash, squash, reorder, split), folding review responses
  into their commit; `--force-with-lease` after a rebase, never bare `--force`.
- **Open the pull request without being asked**, ready for review, not a
  draft. **Refresh its title and body with each push — body first, then
  push** — to the branch's latest state, not its scope when opened; with no PR
  yet, push, then refresh them as soon as one is opened.
- **Codex is the automated reviewer**, triggered automatically. Address its
  comments unasked, folding each fix into its commit — except a real finding
  out of scope here, which you defer (below). Judge each on merit: verify the
  claim; if it doesn't hold, reply why and decline. A comment citing a rule is
  a *reading* of it — check what the rule says; an over-strict reading (the
  privacy rules especially, where stricter feels safer) costs real capability.
  A genuine rule-vs-need conflict is the maintainer's call, not one to resolve
  by quietly narrowing the code. Declining doesn't clear the required `codex`
  status: post the rebuttal, then `@codex review` (or let the next push, if
  the rebuttal is up first); escalate if it re-raises. A hung review — nothing
  back five minutes after a push or poke, or stuck at running (👀) ten minutes
  on — gets `@codex review`; a poke that hangs the same way gets a second an
  hour later, and only a second that hangs too is escalated, never the first
  (maintainer, 2026-10-22).
- **Once Codex has +1'd a head, make no unnecessary change without asking**
  (maintainer, 2026-10-13): a to-do, tidy-up or extra fix re-runs CI and Codex
  for nothing, so it waits for a yes or a follow-up PR. A necessary change
  goes ahead unasked — a rebase for `dirty`, or `behind` where the ruleset
  requires up to date, a red-CI fix.
- **A second verified finding in the same mechanism is evidence about the
  design**: look for the shape elsewhere and ask whether a different design
  deletes the class, not the instance; a design change is the maintainer's
  call, not one to make solo.
- **Restate every review finding in your next message, not just the count**:
  one bullet each (review comment, top-level comment or review body), most
  blocking first — claim, where, what you did or the maintainer's options —
  all in that one reply; ask only the most blocking question.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.
- **Deferring a finding** (real but out of scope): don't ask to merge past it —
  note it in `TODO.md`, commit and push that first, reply citing the sha, and
  resolve. A threadless finding (top-level comment or review body) gets the
  record, push and reply; only the resolve is skipped. The push re-triggers
  Codex, so poke only once it hangs, as above; escalate if the re-review
  re-raises it.

## Language and spelling

- **US English** everywhere people read English — prose, commit subjects and
  bodies, pull request titles and descriptions, comments, identifiers:
  `behavior` not `behaviour`, `canceled` not `cancelled`.

## Commit messages

- A clear, plain-English, sentence-case subject, short (≤ ~70 chars) and free
  of jargon; mechanism and file:line detail go in the body, after a blank line.
- **Prefix a subject that does not change what a consumer runs**: `docs:` for
  prose, `test:` for tests alone, `build:` for this repository's own CI,
  `refactor:` for deliberately behavior-preserving code. A bare subject means
  a consumer could notice the difference. There is no `feat:` or `fix:`, on
  purpose — they would prefix nearly everything and leave the log as flat as
  it started.
- **No model identifier** — never name the coding agent's model or version
  (`Opus 4.8`, `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR,
  comment, or pushed artifact; keep it to chat. Generic attribution
  (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`, "Generated with
  Claude Code") is fine.

## Talking to the user

- **One question at a time**, in plain chat or the client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity). After
  asking, stop and wait for the answer; don't proceed on an assumed one.
- **Answer a mid-turn message first**: the "sent while you were working"
  interjection is addressed in your very next output, before any further tool
  call, even in one sentence.
- **Message only when the user needs to see it** (maintainer, 2026-10-15):
  each notifies their phone. Work in silence; speak up for a question or
  blocker, something to merge or act on, a merge, or a change from the plan,
  `SPEC.md` or their instructions (review-prompted included). Never for
  progress (a client's nudge doesn't count), a review or push alone (its
  report rides the next message), routine machinery, or a mistake caught and
  fixed before it reached the repo. The session-start `AGENTS.md` line still
  opens every session.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, pull request text, review replies, branch names,
  comments, fixtures: absolute paths containing a real name, hostnames,
  private remote URLs, tokens. Use placeholders (`/home/user/project`,
  `git@example.com:org/repo.git`) in examples and fixtures.
