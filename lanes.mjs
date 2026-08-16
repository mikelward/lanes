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

import { readFileSync, lstatSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { matchesGlob } from "node:path";

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
 */
export function readPolicy(root = ".", readFile = readFileSync, lstat = lstatSync) {
  const parts = POLICY_PATH.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i + 1).join("/");
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
  let dispatchWithoutPr = "refuse";

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
      case "dispatch-without-pr":
        if (argument !== "refuse" && argument !== "allow") {
          throw new PolicyError(
            `${POLICY_PATH}:${lineno}: 'dispatch-without-pr' takes refuse or allow, not '${argument}'.`,
          );
        }
        dispatchWithoutPr = argument;
        break;
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
  return { rules, prefixes, dispatchWithoutPr };
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
  if (path === POLICY_PATH) return false;
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

// --- Binding ---------------------------------------------------------------

/**
 * The pull request number arrives as an input, so it is the caller's CLAIM
 * rather than the event's fact -- and every guard below reasons about the
 * pull request that claim names, none of them noticing it is the wrong one.
 * A miswired consumer would classify PR B and hang a green gate on code PR
 * A's commit.
 *
 * `GITHUB_REF` is the event's own statement of which pull request a run
 * belongs to. Unset or non-PR is refused rather than waved through.
 */
export function verifyPrBinding({ event, pr, ref }) {
  if (event !== "pull_request") return;
  if (!pr) return; // no claim to check; a PR-less run classifies as code
  if (ref && new RegExp(`^refs/pull/${pr}/`).test(ref)) return;
  throw new PolicyError(
    `The pr input names #${pr}, but this run belongs to '${ref || "<unset>"}' — ` +
      `a verdict computed for one pull request must not label another's commit.`,
  );
}

/**
 * A dispatched run must name the pull request it reports for, and that pull
 * request must BE the checked-out commit: `--ref` picks the branch and the
 * input supplies the number independently, so nothing else stops a dispatch
 * on code PR A's branch from landing docs PR B's verdict on A's head.
 */
export async function verifyDispatchBinding({ event, pr, sha, dispatchWithoutPr }, ctx) {
  if (event !== "workflow_dispatch") return;
  if (!pr) {
    if (dispatchWithoutPr === "allow") return;
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
}

// --- Modes -----------------------------------------------------------------

/** true when every changed path is documentation and the verdict is trustworthy. */
export async function classify(env, policy, ctx) {
  const { event, pr } = env;
  if (event === "pull_request") {
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

/** Every commit subject on the docs lane must carry one of the prefixes. */
export async function lintPrefixes(pr, policy, ctx) {
  const meta = await api(`pulls/${pr}`, ctx);
  const declared = requireCount(meta.commits, "commit");
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
    if (!policy.prefixes.some((p) => subject.startsWith(`${p}: `))) bad.push(subject);
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
    if (!result) {
      throw new PolicyError(
        `Job '${job}' reported no result — it was probably renamed or removed ` +
          `while the results input still names it.`,
      );
    }
    return { job, result };
  });
  if (parsed.length === 0) {
    throw new PolicyError(
      `The results input named no heavy jobs — nothing reported, so there is nothing to pass. ` +
        `Check that every job in it still exists.`,
    );
  }
  return parsed;
}

/** The verdict the ruleset requires. Throws to fail the check. */
export async function gate(env, policy, ctx) {
  if (env.classifyResult !== "success") {
    throw new PolicyError(
      `classify did not succeed (result: ${env.classifyResult}) — nothing vouches for this diff.`,
    );
  }
  const results = parseResults(env.results);
  const allSuccess = results.every((r) => r.result === "success");
  const allSkipped = results.every((r) => r.result === "skipped");
  if (allSuccess) return;
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
  await lintPrefixes(env.pr, policy, ctx);
}

// --- Entry point -----------------------------------------------------------

export async function main(env = process.env) {
  // A JavaScript action receives its inputs as INPUT_<NAME>, uppercased with
  // dashes turned to underscores. Read directly rather than through
  // @actions/core: this repository ships no dependencies, which is what lets
  // an unpinned `@main` reference be reviewed by reading the files it runs.
  const input = (name) => env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] || "";
  const mode = input("mode");
  const ctx = { token: input("token"), repo: env.GITHUB_REPOSITORY };
  const policy = parsePolicy(readPolicy());
  const shared = {
    event: env.GITHUB_EVENT_NAME,
    pr: input("pr"),
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    classifyResult: input("classify-result"),
    results: input("results"),
    dispatchWithoutPr: policy.dispatchWithoutPr,
  };

  verifyPrBinding(shared);
  await verifyDispatchBinding(shared, ctx);

  if (mode === "classify") {
    // Any failure to establish docs-only classifies as code: the heavy jobs
    // run, which is always the safe direction. The gate is where an
    // unjustified SKIP fails.
    const docsOnly = await classify(shared, policy, ctx);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
    else process.stdout.write(`docs_only=${docsOnly}\n`);
    return;
  }
  if (mode === "gate") {
    await gate(shared, policy, ctx);
    return;
  }
  throw new PolicyError(`Unknown mode '${mode}' — expected 'classify' or 'gate'.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stdout.write(`::error::${err.message}\n`);
    process.exit(1);
  });
}
