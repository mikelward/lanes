// Two CI lanes: lets docs-only pull requests merge without the heavy jobs,
// while one required check -- the `gate` mode -- still reports on every pull
// request.
//
// Why this exists: a ruleset can only require named checks, and a required
// check that never reports blocks the pull request forever. A `paths:` filter
// on `pull_request` skips the whole workflow for docs-only diffs, which is
// exactly that trap. So the workflow runs on every pull request; `classify`
// decides whether the heavy jobs may skip, and `gate` -- the only mode a
// ruleset should require -- independently re-derives that decision before
// blessing a skip, so a classification bug is a red check rather than a
// silent merge.
//
// Two things this deliberately does NOT do, both learned the expensive way:
//
//   - It does not implement glob matching. `path.matchesGlob` is path-aware,
//     maintained, and dependency-free. A hand-rolled matcher cost three
//     review rounds -- `*` crossing `/`, `**/` failing to match zero
//     segments, and a mixed `a/**/b/**/c` combination -- every one of which
//     this gets right without being asked.
//   - It does not resolve the policy's path. The path is FIXED and symlinks
//     are refused, so there is nothing to resolve. Making it configurable
//     cost five review rounds of symlink and normalization handling, all of
//     it defending a knob nobody had asked for.

import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { createSign } from "node:crypto";

// Fixed, not configurable. Every route into the old configurable path -- a
// symlinked file, a symlinked directory component, a multi-hop chain, a `..`
// segment, an absolute spelling -- was a way to change which file the engine
// read while the guard watched a different name. None of them exist when
// there is one name.
export const POLICY_PATH = ".github/lanes.conf";

export class PolicyError extends Error {}

/**
 * Read the policy, refusing anything that is not a plain file reached by
 * plain directories.
 *
 * Refused rather than resolved: resolution is what generated five rounds of
 * findings, and no consumer needs a symlinked policy. Every component is
 * checked, since a link anywhere along the path changes which bytes are read.
 *
 * The spelling is checked against the directory listing for the same reason.
 * A case-insensitive runner (macOS, Windows) opens `.github/LANES.conf`
 * through this lowercase path perfectly happily, while the files API reports
 * the repository's own spelling -- so the engine would be reading a policy
 * under a name no guard recognizes, which is the exact shape the fixed path
 * exists to eliminate.
 */
export function readPolicy(root = ".", readFile = readFileSync, lstat = lstatSync, readdir = readdirSync) {
  const parts = POLICY_PATH.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i + 1).join("/");
    const parent = i === 0 ? root : `${root}/${parts.slice(0, i).join("/")}`;
    let stat;
    try {
      stat = lstat(`${root}/${prefix}`);
    } catch (err) {
      if (i === parts.length - 1) {
        throw new PolicyError(
          `No lanes policy at ${POLICY_PATH} — refusing to classify without one.`,
        );
      }
      throw new PolicyError(
        `Could not read '${prefix}' on the way to ${POLICY_PATH}: ${err.message}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new PolicyError(
        `'${prefix}' is a symlink. The policy must be a plain file at ${POLICY_PATH}, ` +
          `because a link is a second place to change which rules apply.`,
      );
    }
    // Opening it proved a file answers to this name, not that it IS this
    // name. The listing is what the repository actually spells, and it is
    // what the diff will report.
    if (!readdir(parent).includes(parts[i])) {
      throw new PolicyError(
        `'${prefix}' is not spelled that way on disk. The policy must be exactly ${POLICY_PATH}, ` +
          `because a case-insensitive filesystem would otherwise let it be read under one name ` +
          `and classified under another.`,
      );
    }
  }
  return readFile(`${root}/${POLICY_PATH}`, "utf8");
}

/**
 * Parse the policy. It is DATA -- never executed.
 *
 * That is the whole trust story. On a `pull_request` event the checkout is
 * the merge ref, so this file is the pull request's own copy; an earlier
 * version sourced it as shell, which handed the pull request the engine's
 * argv (a config holding `set -- classify` made `gate` run the classify arm
 * and exit 0 without reading its inputs), its environment, `PATH`, and even
 * the API client. Four review rounds went into containing that before the
 * answer turned out to be not running it.
 */
export function parsePolicy(text) {
  const rules = [];
  let prefixes = [];
  let dispatchWithoutPr = { mode: "refuse" };
  let lintTitle = "yes";

  text.split("\n").forEach((raw, index) => {
    const lineno = index + 1;
    // A trailing comment starts at whitespace-then-`#`, so a pattern cannot
    // contain " #". Full-line comments are dropped outright.
    const line = raw.replace(/\s#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) return;

    const [directive, ...rest] = line.split(/\s+/);
    const argument = rest.join(" ");

    switch (directive) {
      case "docs":
      case "code":
        if (!argument) {
          throw new PolicyError(`${POLICY_PATH}:${lineno}: '${directive}' needs a pattern.`);
        }
        rules.push({ verdict: directive, pattern: argument });
        break;
      case "prefixes":
        if (!argument) {
          throw new PolicyError(`${POLICY_PATH}:${lineno}: 'prefixes' needs at least one prefix.`);
        }
        prefixes = rest;
        break;
      case "lint-title":
        if (argument !== "yes" && argument !== "no") {
          throw new PolicyError(
            `${POLICY_PATH}:${lineno}: 'lint-title' takes yes or no, not '${argument}'.`,
          );
        }
        lintTitle = argument;
        break;
      case "dispatch-without-pr": {
        // `allow` is unscoped: any ref a dispatch can name satisfies it, which
        // is exactly the shape of Problem 1 this repository's own TODO.md
        // describes -- a dispatch against a PR's own branch, naming no PR,
        // runs that branch's own (possibly rewritten) copy of the workflow,
        // and the resulting ambient check-run lands on the PR's own head.
        //
        // `allow-on-default-branch` is the scoped alternative, and it takes
        // NO argument on purpose -- an EARLIER version of this let the policy
        // name the trusted branch (`allow-on <branch>`), and that is broken:
        // for a dispatch against a non-default branch, .github/lanes.conf is
        // read from THAT branch's own checkout, so an attacker's own policy
        // could simply name their own branch as the allowed one, satisfying
        // a check whose only job was to refuse exactly that. There is no
        // branch name a policy file can supply that isn't subject to this,
        // because the policy and the ref it would be compared against always
        // come from the same untrusted checkout. The only safe source is the
        // one thing that checkout cannot set: the repository's own default
        // branch, fetched fresh from the API at verification time (see
        // `defaultBranch`), never taken from anything local.
        const [mode, ...modeArgs] = rest;
        if (mode === "refuse") {
          if (modeArgs.length > 0) {
            throw new PolicyError(
              `${POLICY_PATH}:${lineno}: 'dispatch-without-pr refuse' takes no further argument.`,
            );
          }
          dispatchWithoutPr = { mode: "refuse" };
        } else if (mode === "allow") {
          if (modeArgs.length > 0) {
            throw new PolicyError(
              `${POLICY_PATH}:${lineno}: 'dispatch-without-pr allow' takes no further argument -- ` +
                `did you mean 'allow-on-default-branch'?`,
            );
          }
          dispatchWithoutPr = { mode: "allow" };
        } else if (mode === "allow-on-default-branch") {
          if (modeArgs.length > 0) {
            throw new PolicyError(
              `${POLICY_PATH}:${lineno}: 'dispatch-without-pr allow-on-default-branch' takes no ` +
                `argument -- the branch is the repository's own default, verified via the API, never ` +
                `a name the policy supplies.`,
            );
          }
          dispatchWithoutPr = { mode: "allow-on-default-branch" };
        } else {
          throw new PolicyError(
            `${POLICY_PATH}:${lineno}: 'dispatch-without-pr' takes refuse, allow, or ` +
              `allow-on-default-branch, not '${argument}'.`,
          );
        }
        break;
      }
      default:
        // Refused rather than skipped. A typo'd directive silently ignored is
        // a policy that quietly does less than it says -- and for a `code`
        // rule that means paths the author excluded riding the docs lane.
        throw new PolicyError(`${POLICY_PATH}:${lineno}: unknown directive '${directive}'.`);
    }
  });

  // A policy that parsed but declares nothing would leave no rules at all,
  // and "no rules" must never read as "nothing is docs" -- a silent full lane
  // forever, which looks like the safe direction while hiding a broken config.
  if (rules.length === 0) {
    throw new PolicyError(
      `${POLICY_PATH} declares no docs or code rules — refusing to classify without a path policy.`,
    );
  }
  if (prefixes.length === 0) {
    throw new PolicyError(
      `${POLICY_PATH} sets no prefixes — refusing to lint subjects against an empty prefix list.`,
    );
  }
  return { rules, prefixes, dispatchWithoutPr, lintTitle: lintTitle === "yes" };
}

/**
 * Is this path documentation?
 *
 * First match wins; anything matching no rule is code. The policy file itself
 * is always code, decided here rather than by the policy -- asking the policy
 * whether edits to the policy need review lets a pull request answer the one
 * question its answer must not decide, and the gate would agree, being
 * independent of classify's output but not of the rules they share.
 */
export function isDocs(path, rules) {
  // Case-insensitively, and the asymmetry is deliberate: `readPolicy` demands
  // the exact spelling before reading anything, while this errs the other way
  // and calls every spelling code. On a case-insensitive filesystem the two
  // names are one file, so a diff naming `.github/LANES.conf` can be an edit
  // to the policy in force; on a case-sensitive one it is an unrelated file
  // that merely runs the heavy jobs. Wrongly code costs a full lane, wrongly
  // docs skips the review of the rules themselves.
  if (path.toLowerCase() === POLICY_PATH) return false;
  for (const { verdict, pattern } of rules) {
    if (matchesGlob(path, pattern)) return verdict === "docs";
  }
  return false;
}

// --- GitHub ----------------------------------------------------------------

/**
 * A paginated GET, following `Link: rel="next"` to the end.
 *
 * Every listing this makes is reconciled against a count the API reports
 * separately, because the two endpoints used here cap silently -- files at
 * 3,000 and commits at 250, both exiting cleanly with a clean-looking prefix
 * of the truth.
 */
export async function api(path, { token, repo, fetchImpl = fetch } = {}) {
  const out = [];
  let url = `https://api.github.com/repos/${repo}/${path}`;
  while (url) {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new PolicyError(`GitHub API ${res.status} for ${path}`);
    }
    const body = await res.json();
    if (Array.isArray(body)) out.push(...body);
    else return body;
    const link = res.headers.get("link") || "";
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : null;
  }
  return out;
}

/** A count the API reported, or a refusal. */
function requireCount(value, what) {
  // A non-numeric total cannot be compared, and "cannot be compared" must
  // never take the same branch as "compared equal" -- in the shell version
  // that comparison exited 2 and an `if` read it as false, silently SKIPPING
  // the reconciliation this exists to perform.
  if (!Number.isInteger(value) || value < 0) {
    throw new PolicyError(
      `The pull request reported an unreadable ${what} count (${JSON.stringify(value)}) — ` +
        `refusing to classify against a total that cannot be compared.`,
    );
  }
  return value;
}

/** Every changed path, both sides of a rename, or a hard failure. */
export async function changedPaths(pr, ctx) {
  const meta = await api(`pulls/${pr}`, ctx);
  const declared = requireCount(meta.changed_files, "changed_files");
  const files = await api(`pulls/${pr}/files?per_page=100`, ctx);
  if (files.length !== declared) {
    throw new PolicyError(
      `File list incomplete: listed ${files.length} of ${declared} changed files ` +
        `(the API caps at 3,000) — refusing to classify.`,
    );
  }
  // Both sides of every entry: a rename carries its new path in `filename`
  // and its old one in `previous_filename`, and judging only the new side
  // would let a source file renamed into docs/ ride the lane while deleting
  // code.
  return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

/** The open pull requests a commit currently heads. */
export async function openPrsHeading(sha, ctx) {
  const prs = await api(`commits/${sha}/pulls?per_page=100`, ctx);
  return prs.filter((p) => p.state === "open" && p.head.sha === sha).map((p) => p.number);
}

/**
 * A PR-less dispatch's commit must head no open pull request, checked both
 * before the run is allowed to proceed and again immediately before it
 * publishes -- a status is per-commit, so a verdict meant to say "no pull
 * request here" would otherwise satisfy the required check of a pull
 * request opened (or caught up to this commit) in between, without that
 * PR's diff ever being classified or bound.
 */
export async function stillUnclaimed(sha, ctx) {
  const heads = await openPrsHeading(sha, ctx);
  if (heads.length > 0) {
    throw new PolicyError(
      `Commit ${sha} heads open pull request(s) [${heads.join(", ")}] — a PR-less dispatch cannot ` +
        `report for a commit that heads a pull request, since the status would satisfy that pull ` +
        `request's required check without ever validating its diff.`,
    );
  }
}

/**
 * The live tip of a branch, read from the ref itself rather than from the
 * pull request's cached `base.sha`, so the answer does not depend on how
 * fresh that cache happens to be.
 *
 * Each segment is encoded separately: a ref name's slashes are real path
 * separators, while a `#` or a space in a branch name would otherwise
 * truncate the request to a different ref entirely.
 */
export async function baseTip(ref, ctx) {
  const encoded = ref.split("/").map(encodeURIComponent).join("/");
  const body = await api(`git/ref/heads/${encoded}`, ctx);
  return body.object.sha;
}

/**
 * Did this base branch only move FORWARD since the run was triggered?
 *
 * Replaces an earlier exemption that skipped the check whenever the base was
 * the default branch, on the reasoning that a default branch is never
 * force-pushed. That is a convention, not a property: a consumer whose
 * ruleset permits it can rewrite `main`, moving the merge base while head and
 * base ref both stand still -- the exact substitution the pin exists to catch,
 * waved through by name. Ancestry asks the question directly instead, so an
 * ordinary advance stays valid and a rewrite is refused, with no assumption
 * about anyone's branch protection.
 */
export async function baseAdvancedOnly(pinnedSha, ref, ctx) {
  return (await baseMovement(pinnedSha, ref, ctx)).advancedOnly;
}

/**
 * The same question, returning the tip it read.
 *
 * The caller needs both answers -- was this a rewrite, and what is the base
 * NOW -- and asking twice would let the branch move between them, which is
 * the substitution this whole file exists to catch.
 */
export async function baseMovement(pinnedSha, ref, ctx) {
  const tip = await baseTip(ref, ctx);
  if (tip === pinnedSha) return { tip, advancedOnly: true };
  // `per_page=1` because only the status is wanted: a busy branch would
  // otherwise return up to 250 commits to answer a yes/no question.
  const cmp = await api(`compare/${pinnedSha}...${tip}?per_page=1`, ctx);
  return { tip, advancedOnly: cmp.status === "ahead" || cmp.status === "identical" };
}

/**
 * The repository's own default branch, fetched fresh via the API.
 *
 * Never taken from the policy, or from anything else in a local checkout: a
 * `workflow_dispatch` against a non-default branch checks out that branch's
 * own tree, so a value read from there is exactly as untrusted as the ref
 * `dispatch-without-pr allow-on-default-branch` exists to restrict. The
 * repository object itself is the one answer a dispatched branch's own
 * content cannot supply.
 */
export async function defaultBranch(ctx) {
  const fetchImpl = ctx.fetchImpl || fetch;
  const res = await fetchImpl(`https://api.github.com/repos/${ctx.repo}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${ctx.token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new PolicyError(`Could not read this repository's default branch (GitHub API ${res.status}).`);
  }
  return (await res.json()).default_branch;
}

/**
 * The snapshot the run was TRIGGERED for, read from the event payload.
 *
 * Deliberately not action inputs. The consumer would have to wire three of
 * them correctly in two jobs, and a workflow that forgot one would lose the
 * guard silently while still looking configured -- whereas the payload is
 * the event's own account of itself and cannot be miswired. It is also the
 * only place the base COMMIT appears at all: the API answers with the pull
 * request's current base, which is the thing being checked against.
 */
export function eventSnapshot(env, readFile = readFileSync) {
  if (!env.GITHUB_EVENT_PATH) return null;
  let payload;
  try {
    payload = JSON.parse(readFile(env.GITHUB_EVENT_PATH, "utf8"));
  } catch (err) {
    throw new PolicyError(
      `Could not read the event payload (${err.message}) — refusing to report for a run whose ` +
        `own trigger cannot be established.`,
    );
  }
  const pr = payload.pull_request || {};
  return {
    // Only `pull_request_target` binding reads this -- see `verifyPrBinding` --
    // but it comes from the same payload every other field here does, so it is
    // captured alongside them rather than read out separately.
    number: pr.number ?? null,
    head: pr.head ? pr.head.sha : null,
    baseRef: pr.base ? pr.base.ref : null,
    baseSha: pr.base ? pr.base.sha : null,
  };
}

/** Does a subject carry one of the lane's prefixes? */
export function hasPrefix(subject, prefixes) {
  return prefixes.some((p) => subject.startsWith(`${p}: `));
}

// --- Binding ---------------------------------------------------------------

/**
 * The pull request number arrives as an input, so it is the caller's CLAIM
 * rather than the event's fact -- and every guard below reasons about the
 * pull request that claim names, none of them noticing it is the wrong one.
 * A miswired consumer would classify PR B and hang a green gate on code PR
 * A's commit.
 *
 * `GITHUB_REF` is `pull_request`'s own statement of which pull request a run
 * belongs to (`refs/pull/<pr>/merge`). Unset or non-PR is refused rather than
 * waved through.
 *
 * `pull_request_target` carries no such ref -- its `GITHUB_REF` is the BASE
 * branch, since that trigger's whole point is running the base's own copy of
 * the workflow regardless of what the pull request contains. The one fact it
 * does carry about which pull request fired it is the event payload's own
 * `pull_request.number`, so that is what this checks instead.
 */
export function verifyPrBinding({ event, pr, ref, snapshot }) {
  if (event === "pull_request") {
    if (!pr) return; // no claim to check; a PR-less run classifies as code
    if (ref && new RegExp(`^refs/pull/${pr}/`).test(ref)) return;
    throw new PolicyError(
      `The pr input names #${pr}, but this run belongs to '${ref || "<unset>"}' — ` +
        `a verdict computed for one pull request must not label another's commit.`,
    );
  }
  if (event === "pull_request_target") {
    if (!pr) return;
    const number = snapshot && snapshot.number;
    if (number != null && Number(number) === Number(pr)) return;
    throw new PolicyError(
      `The pr input names #${pr}, but this run's event names ` +
        `${number == null ? "<unset>" : `#${number}`} — a verdict computed for one pull ` +
        `request must not label another's commit.`,
    );
  }
}

/**
 * A run must still describe the pull request it was triggered for, BEFORE any
 * verdict -- the all-green path included.
 *
 * The check run lands on the head commit and is read by whatever the pull
 * request looks like now, so a run outlived by a force-push, a retarget, a
 * moved stacked base, or a twin pull request must not report even when its
 * heavy jobs passed: they validated a merge snapshot the pull request no
 * longer shows, and the newer event's own run owns the verdict.
 *
 * Returns the snapshot it proved, so the caller can settle against it after
 * the later reads. `verifyPrBinding` answers a different question -- whether
 * this run belongs to the pull request the input names -- and neither
 * subsumes the other.
 *
 * `pull_request_target` takes the same path as `pull_request` here: once a
 * snapshot exists, this reasons entirely from the payload and live API reads,
 * neither of which differs by trigger. What DOES differ (`GITHUB_REF`,
 * `GITHUB_SHA`) belongs to `verifyPrBinding` and the consumer's own workflow,
 * not to this function.
 */
export async function verifyEventBinding({ event, pr, snapshot }, ctx) {
  if (event !== "pull_request" && event !== "pull_request_target") return null;
  if (!pr) {
    throw new PolicyError(
      `A ${event} run cannot verify its event without the pull request number.`,
    );
  }
  // All three, not just the head. Treating the base fields as optional made
  // every guard below them conditional on data that a `pull_request` payload
  // always carries -- so a truncated or malformed one did not refuse, it
  // silently DEGRADED: no retarget check, no rewrite check, and `pin.baseSha`
  // left null so settlement skipped the base entirely and published a green
  // for a snapshot nothing had verified. A guard that turns itself off when
  // its input is missing is the failure this file exists to prevent.
  const missing = ["head", "baseRef", "baseSha"].filter((k) => !snapshot || !snapshot[k]);
  if (missing.length) {
    throw new PolicyError(
      `The event payload is missing ${missing.join(", ")} — refusing to report for a run whose ` +
        `own trigger cannot be established.`,
    );
  }
  const meta = await api(`pulls/${pr}`, ctx);
  if (meta.head.sha !== snapshot.head) {
    throw new PolicyError(
      `The pull request's head moved after this run's event (${snapshot.head} -> ${meta.head.sha}) — ` +
        `the replacement head's own run owns the verdict.`,
    );
  }
  if (meta.base.ref !== snapshot.baseRef) {
    throw new PolicyError(
      `The pull request was retargeted after this run's event ` +
        `('${snapshot.baseRef}' -> '${meta.base.ref}') — the new diff's own run owns the verdict.`,
    );
  }
  const pin = { head: meta.head.sha, baseRef: meta.base.ref, baseSha: null, title: null };
  // Every base, by ancestry rather than by name. An ordinary advance leaves
  // the event's base commit an ancestor of the tip and does not move this
  // pull request's own commits; a rewrite does not, and it moves the diff
  // while head and ref both stand still.
  const moved = await baseMovement(snapshot.baseSha, meta.base.ref, ctx);
  if (!moved.advancedOnly) {
    throw new PolicyError(
      `The pull request's base branch was rewritten after this run's event ` +
        `(${snapshot.baseSha} is no longer an ancestor of '${meta.base.ref}') — ` +
        `the new diff's own run owns the verdict.`,
    );
  }
  // The EVENT's commit, and settlement demands it exactly. Two different
  // readers want two different bases -- the heavy jobs built against the
  // base as it stood near the event, while `changedPaths()` classifies
  // against whatever the API resolves when the gate runs -- and pinning
  // either one alone leaves the other unguarded. Demanding the event's
  // commit still be the tip at settlement is what makes them the same
  // commit: any movement at all, before this run or during it, refuses
  // instead of publishing a verdict one of the two readers never saw.
  pin.baseSha = snapshot.baseSha;
  // A green build proves this pull request's merge snapshot, but the check
  // run lands on the commit -- which a twin sharing the head reads too, its
  // own base never validated.
  const heads = await openPrsHeading(meta.head.sha, ctx);
  if (heads.length !== 1 || heads[0] !== Number(pr)) {
    throw new PolicyError(
      `Commit ${meta.head.sha} heads open pull requests [${heads.join(", ")}] — ` +
        `a per-commit gate cannot vouch for exactly one, so this run refuses to report.`,
    );
  }
  return pin;
}

/**
 * Re-read everything the verdict rests on, after the reads that produced it.
 *
 * Every listing above answers with the pull request's CURRENT state, so a
 * force-push or a retarget landing between the binding and those calls puts
 * the REPLACEMENT's diff, or its subjects, under this run's verdict. The
 * `edited` and `synchronize` events start a fresh run but cancel nothing, so
 * both verdicts land on the same commit with no ordering between them.
 *
 * The title is RE-VALIDATED rather than compared: a benign retitle leaves the
 * squash subject just as honest, and failing a correct run for it would be an
 * alarm with nothing behind it. Everything else is compared, because any
 * movement there changes what was actually built.
 *
 * The base is compared EXACTLY to the EVENT's commit, on both verdicts, and
 * both halves of that took a review round each to arrive at.
 *
 * Exact, because ancestry is not enough on either path. Green is the obvious
 * one: the heavy jobs built merge(head, base), so once the base moves that is
 * no longer the snapshot the pull request lands. A skip looks laxer and is
 * not -- `base...head` is measured from the merge base, so advancing the base
 * INTO the head's own history DROPS commits from the diff rather than adding
 * paths to it, and a head that changes code in one commit and reverts it in
 * the next classifies as documentation from the old base and as code from the
 * new one.
 *
 * The event's commit rather than the tip this run read, because the two
 * verdicts rest on bases read at different moments: the heavy jobs built
 * against the base as it stood near the event, and `changedPaths()`
 * classifies against whatever the API resolves when the gate runs. Pinning
 * the live tip guards the second and lets the first go stale. Requiring the
 * event's commit to still BE the tip collapses the difference -- when it
 * holds, both readers saw the same commit -- and when it doesn't, this
 * refuses rather than guessing which reader was right. The window is only as
 * long as the run, and the standard remedy -- GitHub's own "require branches
 * to be up to date", or one push -- already exists.
 */
export async function stillPinned(pr, pin, policy, ctx) {
  if (!pin) return;
  // ORDER MATTERS, and it is the only thing here that can matter.
  //
  // No finite sequence of reads closes a time-of-check/time-of-use gap against
  // a remote anyone can change: whatever is read last, something can move after
  // it. What ordering buys is the SIZE of the window between confirming this
  // run still describes the pull request and acting on that. So the reads that
  // do not establish identity go first, and the one that does goes last, with
  // nothing but the return after it.
  //
  // Read the other way round -- identity first -- a retarget landing during the
  // later calls left them inspecting the OLD base's tip and a head association
  // a retarget does not disturb, so nothing saw it and the run reported for a
  // diff the pull request had stopped having.
  //
  // The window that outlives the run is the larger one and is not this
  // function's to close: a published check is overwritten by the fresh run a
  // retarget starts, or the merge is blocked. See the README.
  if (pin.baseSha) {
    const tip = await baseTip(pin.baseRef, ctx);
    if (tip !== pin.baseSha) {
      throw new PolicyError(
        `The base branch moved from ${pin.baseSha} to ${tip} while this run was reading the pull ` +
          `request — the verdict was computed against a snapshot it no longer lands. Update the ` +
          `branch, or push, and the fresh run will report for the new one.`,
      );
    }
  }
  const heads = await openPrsHeading(pin.head, ctx);
  if (heads.length !== 1 || heads[0] !== Number(pr)) {
    throw new PolicyError(
      `Commit ${pin.head} gained a second open pull request while the gate was reading it — ` +
        `a per-commit gate cannot vouch for exactly one.`,
    );
  }
  const meta = await api(`pulls/${pr}`, ctx);
  if (meta.head.sha !== pin.head || meta.base.ref !== pin.baseRef) {
    throw new PolicyError(
      `The pull request moved while the gate was reading it — refusing to report a verdict ` +
        `for a snapshot it no longer shows.`,
    );
  }
  if (pin.title !== null && !hasPrefix(meta.title || "", policy.prefixes)) {
    throw new PolicyError(
      `The pull request's title lost its prefix while the gate was reading it — refusing to ` +
        `bless a skip for a title a squash merge would land as a behavior change.`,
    );
  }
}

/**
 * A dispatched run must name the pull request it reports for, and that pull
 * request must BE the checked-out commit: `--ref` picks the branch and the
 * input supplies the number independently, so nothing else stops a dispatch
 * on code PR A's branch from landing docs PR B's verdict on A's head.
 */
export async function verifyDispatchBinding({ event, pr, sha, ref, dispatchWithoutPr, baseSha }, ctx) {
  if (event !== "workflow_dispatch") return null;
  if (!pr) {
    if (dispatchWithoutPr.mode === "allow") return null;
    if (dispatchWithoutPr.mode === "allow-on-default-branch") {
      // Fetched fresh, not read from the checkout: see `defaultBranch`.
      const expected = `refs/heads/${await defaultBranch(ctx)}`;
      if (ref !== expected) {
        throw new PolicyError(
          `A dispatched run with no pull request is only allowed on '${expected}', but this run's ref is ` +
            `'${ref || "<unset>"}' — a dispatch against any other ref could be running that branch's own, ` +
            `possibly-tampered copy of this workflow.`,
        );
      }
      // The default branch's tip can ALSO be an open pull request's head --
      // a promote-to-release PR opened straight from it, or one simply
      // caught up to it -- and a status is per-commit, so a verdict this run
      // publishes for "no pull request" would just as well satisfy that
      // PR's required check, without its diff ever being classified or
      // bound. Refused here, and re-checked again in `gate` immediately
      // before publishing, for the same reason `stillPinned` repeats every
      // other binding check there rather than trusting this one read.
      await stillUnclaimed(sha, ctx);
      return null;
    }
    throw new PolicyError(
      `A dispatched run must name the pull request it reports for — refusing without one.`,
    );
  }
  const meta = await api(`pulls/${pr}`, ctx);
  if (meta.head.sha !== sha) {
    throw new PolicyError(
      `Dispatched commit ${sha} is not PR #${pr}'s head (${meta.head.sha}) — ` +
        `a verdict computed for one pull request must not label another's commit.`,
    );
  }
  // SHA equality is not a complete association: a commit can head more than
  // one open pull request, and a check run is per-commit, so a gate minted
  // for the docs one would satisfy the code one too.
  const heads = await openPrsHeading(sha, ctx);
  if (heads.length !== 1 || heads[0] !== Number(pr)) {
    throw new PolicyError(
      `Commit ${sha} heads open pull requests [${heads.join(", ")}] — ` +
        `a per-commit gate cannot vouch for exactly one, so a dispatched run refuses to report.`,
    );
  }
  // A pin, for the same reason `verifyEventBinding` returns one: a dispatched
  // run reaches the all-green path too -- a weekly dependency job's own CI run
  // is exactly that.
  //
  // The base comes from the CALLER, carried forward from classify's `base_sha`
  // output, and reading it here instead would prove nothing: the gate runs
  // AFTER the heavy jobs, so a base sampled here settles against itself and
  // agrees by construction, no matter what the jobs actually built against. A
  // `pull_request` run gets this for free from its event payload; a dispatch
  // has no such record, so the caller supplies one or the gate refuses to
  // certify the green (see `gate`).
  return { head: sha, baseRef: meta.base.ref, baseSha: baseSha || null, title: null };
}

// --- Publishing --------------------------------------------------------
//
// Every mode above answers whether a diff may skip; none of it writes
// anything. A consumer that trusts the ambient Actions check-run to report
// `gate`'s own pass/fail is trusting a mechanism the job DEFINITION
// controls -- and under `pull_request`, that definition is the pull
// request's own copy. What follows is the alternative: authenticate as a
// dedicated GitHub App -- never the ambient `GITHUB_TOKEN`, which any
// workflow in the repository can mint -- and post the commit status
// directly, by API call, onto the exact commit the event named. A same-repo
// pull request adding its own `push`-triggered workflow can call the same
// API with the ambient token, but cannot produce the App's identity without
// its private key, which is why the CREDENTIAL closes the hole, not the
// mechanism.
//
// Used only when a consumer supplies `app-id`/`app-private-key` (`init`
// mode always requires them; `gate` mode treats them as opt-in). Every
// existing consumer that supplies neither is completely unaffected -- `gate`
// still just throws or returns, exactly as it always has.
//
// The JWT-then-installation-token exchange below (sign a short-lived App JWT,
// look up this repo's installation, mint a token from it) is GitHub's own
// long-stable App-authentication flow, not something this repository is
// inventing -- unlike the `pull_request_target` field semantics elsewhere in
// this design, which TODO.md flags as unverified against live docs, this
// mechanism is not in question. What IS still open, and is a consumer
// workflow's concern rather than this file's, is whether an environment's
// deployment-branch policy actually restricts a `pull_request_target` run's
// access to the credential the way the design assumes -- see TODO.md.

function base64url(bufferOrString) {
  const buf = Buffer.isBuffer(bufferOrString) ? bufferOrString : Buffer.from(bufferOrString);
  return buf.toString("base64url");
}

function defaultSign(signingInput, privateKeyPem) {
  return createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
}

/**
 * A short-lived JWT identifying the App itself, not an installation.
 *
 * `iat` is backdated 60s for clock drift between this runner and GitHub's --
 * a `iat` GitHub reads as still in the future is rejected outright, and a
 * runner's clock running fast is not this file's to fix. `exp` is 10
 * minutes, GitHub's own maximum for an App JWT.
 */
export function signAppJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000), sign = defaultSign) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: String(appId) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  return `${signingInput}.${base64url(sign(signingInput, privateKeyPem))}`;
}

/** This App's installation on the repo, or a refusal naming why there is none. */
export async function installationId(repo, appJwt, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/installation`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new PolicyError(
      `Could not find this App's installation on ${repo} (${res.status}) -- is it installed there?`,
    );
  }
  return (await res.json()).id;
}

/**
 * A fresh installation access token. Minted per run, never stored: an
 * installation token expires in an hour, so storing one directly would leave
 * every later run unable to publish once it expired. The App ID and private
 * key are the credential a consumer holds; this is what they are exchanged
 * for, each time.
 */
export async function installationToken(id, appJwt, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new PolicyError(
      `Could not mint an installation token (${res.status}) -- the App credential may be wrong or revoked.`,
    );
  }
  return (await res.json()).token;
}

/** Authenticate as the App and return a token scoped to this repo's installation. */
export async function appToken({ appId, privateKey, repo }, fetchImpl = fetch, sign = defaultSign) {
  if (!appId || !privateKey) {
    throw new PolicyError(
      `Publishing a status needs both app-id and app-private-key -- refusing to post unauthenticated.`,
    );
  }
  const jwt = signAppJwt(appId, privateKey, undefined, sign);
  const id = await installationId(repo, jwt, fetchImpl);
  return installationToken(id, jwt, fetchImpl);
}

// The Statuses API's own cap; a longer description is rejected outright
// rather than truncated server-side.
const DESCRIPTION_LIMIT = 140;

/**
 * The commit a status belongs on.
 *
 * Never `GITHUB_SHA` for `pull_request`/`pull_request_target` -- under the
 * latter that env var is the BASE branch's tip, not the pull request's, and
 * publishing there would report success on a commit nobody proposed while
 * the pull request's own head sits forever waiting for a status nothing ever
 * posts against it. The event payload's `pull_request.head.sha` is the one
 * fact either trigger carries about which commit it actually concerns.
 */
export function statusSha({ event, snapshot, sha }) {
  if (event === "pull_request" || event === "pull_request_target") {
    if (!snapshot || !snapshot.head) {
      throw new PolicyError(
        `No pull request head in the event payload -- refusing to post a status for an unresolved commit.`,
      );
    }
    return snapshot.head;
  }
  // workflow_dispatch: GITHUB_SHA is the dispatched ref's own tip, which
  // verifyDispatchBinding already ties to the named pull request's head
  // before any verdict is trusted.
  return sha;
}

function runUrl(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return undefined;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/** Post the `lanes` commit status directly, authenticated as the App. */
export async function publishStatus({ repo, sha, state, description, targetUrl }, token, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      state,
      context: "lanes",
      description: description ? description.slice(0, DESCRIPTION_LIMIT) : undefined,
      target_url: targetUrl,
    }),
  });
  if (!res.ok) {
    throw new PolicyError(`Could not post the lanes status (${res.status}) onto ${sha}.`);
  }
}

/**
 * `init` mode's entire job: resolve the commit and post `pending`.
 *
 * No binding verification, no checkout, no policy read -- `pending` is never
 * a passing state, so posting it on the wrong commit costs nothing a
 * `gate`-mode failure or a fresh run does not already fix, and the whole
 * point of this job is to run before anything else has had a chance to.
 */
export async function publishPending(env, appCreds, fetchImpl = fetch, sign = defaultSign) {
  const repo = env.GITHUB_REPOSITORY;
  const sha = statusSha({ event: env.GITHUB_EVENT_NAME, snapshot: eventSnapshot(env), sha: env.GITHUB_SHA });
  const token = await appToken({ ...appCreds, repo }, fetchImpl, sign);
  await publishStatus(
    { repo, sha, state: "pending", description: "Waiting on the required jobs.", targetUrl: runUrl(env) },
    token,
    fetchImpl,
  );
}

/**
 * `gate` mode's optional second half: publish the terminal status once
 * `gate()` has already thrown or returned.
 *
 * Takes the error `gate()` threw, or null, and re-throws afterward so the
 * job itself still reports red -- the explicit status is IN ADDITION to
 * that, never instead of it, so a consumer can watch the job's own log
 * exactly as before. A failure publishing the status is never swallowed
 * either: it is at least as urgent as `gate`'s own verdict, since it means
 * the required check may not have received a terminal value at all.
 */
export async function publishResult(env, gateErr, appCreds, fetchImpl = fetch, sign = defaultSign) {
  const repo = env.GITHUB_REPOSITORY;
  const sha = statusSha({ event: env.GITHUB_EVENT_NAME, snapshot: eventSnapshot(env), sha: env.GITHUB_SHA });
  let publishErr = null;
  try {
    const token = await appToken({ ...appCreds, repo }, fetchImpl, sign);
    await publishStatus(
      {
        repo,
        sha,
        state: gateErr ? "failure" : "success",
        description: gateErr ? gateErr.message : "Every required job passed.",
        targetUrl: runUrl(env),
      },
      token,
      fetchImpl,
    );
  } catch (e) {
    publishErr = e;
  }
  if (gateErr && publishErr) {
    throw new PolicyError(
      `${gateErr.message} (additionally, could not publish the status: ${publishErr.message})`,
    );
  }
  if (publishErr) throw publishErr;
  if (gateErr) throw gateErr;
}

// --- Modes -----------------------------------------------------------------

/** true when every changed path is documentation and the verdict is trustworthy. */
export async function classify(env, policy, ctx) {
  const { event, pr } = env;
  if (event === "pull_request" || event === "pull_request_target") {
    if (!pr) return false;
    // A commit can head more than one open pull request (stacked branches),
    // and a check run is per-commit -- so a gate minted for this one's
    // justified skip would satisfy the other's required check even where that
    // diff is code. A shared head never rides the docs lane.
    const meta = await api(`pulls/${pr}`, ctx);
    const heads = await openPrsHeading(meta.head.sha, ctx);
    if (heads.length !== 1 || heads[0] !== Number(pr)) return false;
  } else if (event === "workflow_dispatch") {
    if (!pr) return false;
  } else {
    return false;
  }

  const paths = await changedPaths(pr, ctx);
  // An empty diff is not a docs diff; refuse to vouch for it.
  if (paths.length === 0) return false;
  return paths.every((p) => isDocs(p, policy.rules));
}

/**
 * Run the whole classify path, reporting ANY failure to establish docs-only
 * as code.
 *
 * Deliberately a wrapper around all of it rather than around the one call
 * that threw. The first version wrapped `classify` alone and left the
 * dispatch-binding lookups in front of it still fatal -- which is the same
 * enumerate-the-routes mistake the policy path and the glob matcher both
 * cost rounds of, one call site at a time. There is one rule instead:
 * **classify never fails.** It answers a single question -- may the heavy
 * jobs skip? -- and every failure to establish "yes" is "no", which runs
 * them. That is what the action documents `docs_only` to be.
 *
 * Safe because the gate repeats every one of these checks and keeps them all
 * fatal: it re-reads the policy, re-verifies the binding, and re-derives the
 * classification before blessing a skip. So nothing is waved through here --
 * a broken policy or a mis-bound dispatch still turns the required check red,
 * one job later, having run the full lane in the meantime.
 *
 * The reason is reported rather than swallowed: a silent `false` is
 * indistinguishable from a diff that genuinely contains code.
 */
export async function classifyOrCode(work, warn = (m) => process.stdout.write(m)) {
  try {
    return await work();
  } catch (err) {
    warn(`::warning::Could not establish a docs-only diff (${err.message}) — taking the code lane.\n`);
    return false;
  }
}

/** Every commit subject on the docs lane must carry one of the prefixes. */
export async function lintPrefixes(pr, policy, ctx, pin = null) {
  const meta = await api(`pulls/${pr}`, ctx);
  const declared = requireCount(meta.commits, "commit");
  // Configurable, and ON by default. NOT because of squash merges -- that was
  // the first reasoning here and it is wrong for any consumer that rebases,
  // where the title never lands on the default branch at all. Two independent
  // reasons, and the second is the one that holds either way:
  //
  //   - under a squash the title IS the subject that lands, so linting only
  //     the commits leaves the one line the merge ships unchecked;
  //   - whatever the merge strategy, the title is what a pull request LIST
  //     shows, so a prefix says at a glance whether a pull request changes
  //     what the app does.
  //
  // Default on because the two ways to get it wrong are not symmetric. Off
  // when it was wanted is SILENT -- a check the repository used to have simply
  // stops running, with nothing red to notice it by. On when it was not wanted
  // is a red check naming the fix, cleared by one line of config. A consumer
  // that wants neither reason sets `lint-title no`; the commit lint below runs
  // regardless, and it is the one that guards what actually lands.
  if (policy.lintTitle) {
    const title = meta.title || "";
    if (!title) {
      throw new PolicyError(
        `The pull request has no title to check — the prefix rule cannot be verified.`,
      );
    }
    if (!hasPrefix(title, policy.prefixes)) {
      throw new PolicyError(
        `Docs-lane pull request title lacks a prefix: '${title}' — prefix it ` +
          `(${policy.prefixes.map((p) => `${p}:`).join("/")}) so a squash merge cannot land it ` +
          `as a behavior-change subject.`,
      );
    }
    if (pin) pin.title = title;
  }
  const commits = await api(`pulls/${pr}/commits?per_page=100`, ctx);
  if (commits.length !== declared) {
    throw new PolicyError(
      `Commit list incomplete: listed ${commits.length} of ${declared} commits ` +
        `(the API caps at 250) — the prefix rule cannot be verified.`,
    );
  }
  const bad = [];
  for (const c of commits) {
    // Merge commits are exempt structurally, by parent count -- a commit whose
    // subject merely starts with "Merge" is not one.
    if ((c.parents || []).length > 1) continue;
    const subject = (c.commit.message || "").split("\n")[0];
    if (!hasPrefix(subject, policy.prefixes)) bad.push(subject);
  }
  if (bad.length) {
    throw new PolicyError(
      bad
        .map(
          (s) =>
            `Docs-lane commit subject lacks a prefix: '${s}' — prefix it ` +
            `(${policy.prefixes.map((p) => `${p}:`).join("/")}) so it never reads like a behavior change.`,
        )
        .join("\n"),
    );
  }
}

/**
 * `job=result` pairs for every heavy job.
 *
 * Refuses an input that names none. `${RESULTS:?}` in the shell version
 * rejected unset and empty but not whitespace, and a string of spaces split
 * to nothing -- zero iterations, the all-success flag standing at its initial
 * true, and the required check green having been told nothing. That needed no
 * attacker: consumers build this from `needs.<job>.result`, so deleting a job
 * would silently disarm the gate.
 */
export function parseResults(raw) {
  const pairs = (raw || "").split(/\s+/).filter(Boolean);
  const parsed = pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at < 0) {
      throw new PolicyError(`Malformed entry '${pair}' in the results input — expected job=result pairs.`);
    }
    const job = pair.slice(0, at);
    const result = pair.slice(at + 1);
    // BOTH sides. An empty result is a job that vanished; an empty NAME is a
    // result attributed to nothing, which counts toward all-success and turns
    // the required check green having named no heavy job at all -- the same
    // shape as an input of pure whitespace, one layer in.
    if (!job) {
      throw new PolicyError(
        `Entry '${pair}' in the results input names no job — a result has to say what reported it.`,
      );
    }
    if (!result) {
      throw new PolicyError(
        `Job '${job}' reported no result — it was probably renamed or removed ` +
          `while the results input still names it.`,
      );
    }
    return { job, result };
  });
  // A workflow's job IDs are unique, so a repeated name is never two heavy
  // jobs -- it is a copy-pasted line whose name was never changed, and the
  // job it was meant to name is the one now missing. Same family as the two
  // above: the input silently describes fewer jobs than the workflow has, and
  // the gate goes green having never seen the failing one's result.
  const seen = new Set();
  for (const { job } of parsed) {
    if (seen.has(job)) {
      throw new PolicyError(
        `Job '${job}' appears twice in the results input — job IDs are unique, so a repeat is ` +
          `a mistyped entry, and whichever job it should have named reported nothing.`,
      );
    }
    seen.add(job);
  }
  if (parsed.length === 0) {
    throw new PolicyError(
      `The results input named no heavy jobs — nothing reported, so there is nothing to pass. ` +
        `Check that every job in it still exists.`,
    );
  }
  return parsed;
}

/** The verdict the ruleset requires. Throws to fail the check. */
export async function gate(env, policy, ctx, pin = null) {
  if (env.classifyResult !== "success") {
    throw new PolicyError(
      `classify did not succeed (result: ${env.classifyResult}) — nothing vouches for this diff.`,
    );
  }
  const results = parseResults(env.results);
  const allSuccess = results.every((r) => r.result === "success");
  const allSkipped = results.every((r) => r.result === "skipped");
  // A dispatched run has no event payload, so the only base it can bind to is
  // the one the CALLER carried forward from classify. Without it there is
  // nothing to settle against, on EITHER path:
  //
  //   - green: the gate would read the base AFTER the heavy jobs and compare
  //     it with itself, agreeing by construction whatever they built against.
  //   - skip: `classify` re-derives the diff here, but "here" is several reads
  //     long. A base advancing between the reclassification and settlement
  //     leaves `stillPinned` comparing only the head and the base's NAME --
  //     neither of which an advance changes -- and the skip publishes for a
  //     diff measured against a base that has already moved.
  //
  // The skip case was missed on the reasoning that re-deriving against the
  // current base made a pin redundant. It does not: it makes the pin the only
  // thing that says WHICH current base, across reads a push can straddle.
  if (env.event === "workflow_dispatch" && env.pr && !(pin && pin.baseSha)) {
    throw new PolicyError(
      `This dispatched run reports for #${env.pr}, but nothing records the base it was ` +
        `measured against — so a base that moved while it ran cannot be detected. Pass ` +
        `classify's 'base_sha' output to the gate's 'base-sha' input.`,
    );
  }
  // A PR-less dispatch has no pin to settle -- `pin` is null by construction
  // for that path -- but it still rests on one claim that can go stale
  // exactly like a pin can: that its commit heads no open pull request.
  // Re-verified here, immediately before publishing, for the same reason as
  // every other settle-before-report check in this file.
  const prLessDispatch = env.event === "workflow_dispatch" && !env.pr && !pin;
  if (allSuccess) {
    // The heavy jobs vouch for this run's merge snapshot, and the binding
    // proved that snapshot was still the pull request's -- but across several
    // separate reads. Settle before reporting, exactly as the skip path does:
    // a green verdict for a snapshot the pull request no longer shows is the
    // same failure as an unjustified skip, arrived at from the other side.
    if (prLessDispatch) await stillUnclaimed(env.sha, ctx);
    else await stillPinned(env.pr, pin, policy, ctx);
    return;
  }
  if (!allSkipped) {
    throw new PolicyError(
      `Heavy job results '${env.results}' — not all green, and not a justified skip.`,
    );
  }
  // The skip is only as good as the reason for it: re-derive the
  // classification here, independently of the output that caused it.
  if (!(await classify(env, policy, ctx))) {
    throw new PolicyError(
      `Heavy jobs were skipped but the diff could not be verified as docs-only — refusing the skip.`,
    );
  }
  await lintPrefixes(env.pr, policy, ctx, pin);
  // After every read the verdict rests on, not before them.
  if (prLessDispatch) await stillUnclaimed(env.sha, ctx);
  else await stillPinned(env.pr, pin, policy, ctx);
}

// --- The run --------------------------------------------------------------
//
// This file defines and exports; it never invokes. `main.mjs` is what the
// action manifest runs, and it invokes unconditionally. The two were one file
// guarded by `import.meta.url === \`file://${process.argv[1]}\``, which is a
// string comparison between a URL and a path: a checkout under a directory
// with a space or a `#` in it encodes as `%20` / `%23` on one side and not
// the other, the comparison goes false, `main()` never runs, and the process
// exits 0 — the gate reporting green having inspected nothing. Nothing here
// needs to know whether it was imported.

export async function main(env = process.env) {
  // A JavaScript action receives its inputs as INPUT_<NAME>, uppercased with
  // SPACES turned to underscores -- and nothing else converted: a dash stays
  // a dash, so `classify-result` arrives as `INPUT_CLASSIFY-RESULT`. The
  // first version of this line turned dashes to underscores too, and the
  // suite agreed with it, setting the same misspelled names -- so every
  // hyphenated input read as empty on a real runner and the gate refused the
  // first consumer's all-green run. Read directly rather than through
  // @actions/core: this repository ships no dependencies, which is what lets
  // an unpinned `@main` reference be reviewed by reading the files it runs.
  const input = (name) => env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "";
  const mode = input("mode");
  // Before anything else, so an unknown mode is an error rather than a
  // classify-shaped fallback that reports code and exits 0.
  if (mode !== "classify" && mode !== "gate" && mode !== "init") {
    throw new PolicyError(`Unknown mode '${mode}' — expected 'classify', 'gate', or 'init'.`);
  }
  const ctx = { token: input("token"), repo: env.GITHUB_REPOSITORY };
  const appCreds = { appId: input("app-id"), privateKey: input("app-private-key") };

  // The initializer: no policy, no checkout, no binding -- just post
  // `pending` before anything else in the graph has a chance to run.
  if (mode === "init") {
    await publishPending(env, appCreds);
    return;
  }

  let baseSha = "";
  // One body for both modes, so neither can grow a check the other lacks.
  const work = async () => {
    const policy = parsePolicy(readPolicy());
    const snapshot = eventSnapshot(env);
    const shared = {
      event: env.GITHUB_EVENT_NAME,
      pr: input("pr"),
      ref: env.GITHUB_REF,
      sha: env.GITHUB_SHA,
      classifyResult: input("classify-result"),
      results: input("results"),
      dispatchWithoutPr: policy.dispatchWithoutPr,
      baseSha: input("base-sha"),
      snapshot,
    };
    verifyPrBinding(shared);
    // Exactly one of these returns a pin; the other is a no-op for this event.
    const pin =
      (await verifyEventBinding(shared, ctx)) || (await verifyDispatchBinding(shared, ctx));
    if (mode === "classify") {
      // Recorded HERE, before the heavy jobs run, which is the only moment at
      // which it is worth anything. A pull_request run has the same commit in
      // its event payload and ignores this; a dispatch has no other source.
      baseSha =
        (snapshot && snapshot.baseSha) ||
        (pin && pin.baseRef ? await baseTip(pin.baseRef, ctx) : "");
      return classify(shared, policy, ctx);
    }
    await gate(shared, policy, ctx, pin);
    return false;
  };

  // The gate fails on all of it; classify fails on none of it.
  if (mode === "gate") {
    let err = null;
    try {
      await work();
    } catch (e) {
      err = e;
    }
    // Opt-in: a consumer that supplies neither credential gets exactly the
    // behavior this had before either existed -- throw or return, and let
    // the ambient Actions check-run report it, same as today.
    if (appCreds.appId || appCreds.privateKey) {
      await publishResult(env, err, appCreds);
      return;
    }
    if (err) throw err;
    return;
  }
  const docsOnly = await classifyOrCode(work);
  // Emitted even when the classification failed to establish: the gate's own
  // binding is a separate question from what the diff turned out to be, and a
  // blank here would refuse a green the caller could have proved.
  const out = `docs_only=${docsOnly}\nbase_sha=${baseSha}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, out);
  else process.stdout.write(out);
}
