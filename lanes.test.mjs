// Tests for the lane engine.
//
// This suite is the only thing between a push here and every consumer's
// required check, so it exercises the real functions against a stubbed API
// rather than a reimplementation of them. Its own failure mode is a false
// pass, so every behavior is asserted in BOTH directions: the case that must
// succeed and the case that must be refused.
//
// Nearly every case here was ported from the shell engine this replaced, and
// several were written in response to a specific review finding. The
// behaviors are the asset; the language underneath them is not.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  POLICY_PATH,
  PolicyError,
  changedPaths,
  classify,
  gate,
  isDocs,
  lintPrefixes,
  parsePolicy,
  parseResults,
  readPolicy,
  verifyDispatchBinding,
  verifyPrBinding,
} from "./lanes.mjs";

/** A stubbed API: canned bodies keyed by a substring of the request path. */
// `changed` and `nCommits` distinguish "not specified" (undefined -> derive
// from the fixture) from "specified as this exact value" -- including null.
// Defaulting them with `??` meant a deliberately unreadable count fell
// through to the real one, so the guard under test never saw a bad value and
// the case passed while asserting nothing.
function stub({ files = [], changed, commits = [], nCommits, headSha = "headsha", pulls = null } = {}) {
  const routes = [
    [/\/pulls\/\d+\/files/, () => files],
    [/\/pulls\/\d+\/commits/, () => commits],
    [/\/commits\/[^/]+\/pulls/, () => pulls ?? [{ state: "open", head: { sha: headSha }, number: 1 }]],
    [
      /\/pulls\/\d+$/,
      () => ({
        changed_files: changed === undefined ? files.length : changed,
        commits: nCommits === undefined ? commits.length : nCommits,
        head: { sha: headSha },
      }),
    ],
  ];
  return async (url) => {
    const path = new URL(url).pathname;
    for (const [re, body] of routes) {
      if (re.test(path)) {
        return { ok: true, status: 200, json: async () => body(), headers: { get: () => "" } };
      }
    }
    throw new Error(`unstubbed route: ${path}`);
  };
}

const ctx = (opts) => ({ token: "t", repo: "example/repo", fetchImpl: stub(opts) });
const named = (...paths) => paths.map((filename) => ({ filename }));
const PR_ENV = { event: "pull_request", pr: "1", ref: "refs/pull/1/merge", sha: "headsha" };

const POLICY = parsePolicy(`
code docs/REFERENCE.md
docs *.md
docs docs/*.md
prefixes design docs todo test build refactor
`);

/** A temp repo whose policy path can be staged as file, link, or missing. */
function withRepo(fn, { link = null, dirLink = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lanes-"));
  try {
    mkdirSync(join(root, ".github"), { recursive: true });
    if (dirLink) {
      rmSync(join(root, ".github"), { recursive: true });
      mkdirSync(join(root, "real"), { recursive: true });
      writeFileSync(join(root, "real", "lanes.conf"), "docs *.md\nprefixes docs\n");
      symlinkSync("real", join(root, ".github"));
    } else if (link) {
      writeFileSync(join(root, link), "docs *.md\nprefixes docs\n");
      symlinkSync(link.replace(".github/", ""), join(root, POLICY_PATH));
    } else {
      writeFileSync(join(root, POLICY_PATH), "docs *.md\nprefixes docs\n");
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("patterns", () => {
  // Every case below cost a review round in the hand-rolled shell matcher.
  // `path.matchesGlob` gets all of them right, which is the entire argument
  // for not implementing this.
  const rules = parsePolicy("docs *.md\ndocs docs/*.md\ndocs deep/**/*.md\nprefixes docs\n").rules;

  test("* does not cross a slash", () => {
    assert.equal(isDocs("README.md", rules), true);
    assert.equal(isDocs("other/DESIGN.md", rules), false);
  });

  test("one level needs its own rule, and stops at one level", () => {
    assert.equal(isDocs("docs/DESIGN.md", rules), true);
    assert.equal(isDocs("docs/a/B.md", rules), false);
  });

  test("** spans any depth, including zero segments", () => {
    const r = parsePolicy("docs **/*.md\nprefixes docs\n").rules;
    assert.equal(isDocs("README.md", r), true, "zero segments");
    assert.equal(isDocs("a/B.md", r), true);
    assert.equal(isDocs("a/b/c/D.md", r), true);
    assert.equal(isDocs("a/b/c.rs", r), false);
  });

  test("every ** varies independently", () => {
    // The shell version matched all-zero and all-nonzero but not the mixed
    // combination, which is exactly where a test written from the docs would
    // not look.
    const r = parsePolicy("docs a/**/b/**/c.md\nprefixes docs\n").rules;
    assert.equal(isDocs("a/b/c.md", r), true, "both zero");
    assert.equal(isDocs("a/x/b/y/c.md", r), true, "both non-zero");
    assert.equal(isDocs("a/x/b/c.md", r), true, "first kept, second dropped");
    assert.equal(isDocs("a/b/y/c.md", r), true, "first dropped, second kept");
    assert.equal(isDocs("a/x/z/c.md", r), false, "genuine non-match");
  });

  test("first match wins, and unmatched is code", () => {
    assert.equal(isDocs("docs/REFERENCE.md", POLICY.rules), false, "excluded ahead of *.md");
    assert.equal(isDocs("README.md", POLICY.rules), true);
    assert.equal(isDocs(".editorconfig", POLICY.rules), false);
  });

  test("the policy file is code whatever the policy says", () => {
    // Asking the policy whether edits to the policy need review lets a pull
    // request answer the one question its answer must not decide -- and the
    // gate agrees, being independent of classify's output but not of the
    // rules they share.
    const hostile = parsePolicy("docs **\nprefixes docs\n").rules;
    assert.equal(isDocs("anything.rs", hostile), true, "the fixture really is permissive");
    assert.equal(isDocs(POLICY_PATH, hostile), false);
  });
});

describe("policy parsing", () => {
  test("comments and blank lines are ignored", () => {
    const p = parsePolicy("# lead\n\ndocs *.md  # trailing\nprefixes docs\n");
    assert.deepEqual(p.rules, [{ verdict: "docs", pattern: "*.md" }]);
  });

  test("an unknown directive is refused, not skipped", () => {
    // A typo silently ignored is a policy that quietly does less than it
    // says -- and for a `code` rule that means excluded paths riding the lane.
    assert.throws(() => parsePolicy("docs *.md\nprefixes docs\nset -- classify\n"), /unknown directive 'set'/);
  });

  test("shell in a policy is data, not code", () => {
    assert.throws(() => parsePolicy("docs *.md\nprefixes docs\n$(touch /tmp/x)\n"), PolicyError);
  });

  test("a directive with no argument is refused", () => {
    assert.throws(() => parsePolicy("docs\nprefixes docs\n"), /needs a pattern/);
    assert.throws(() => parsePolicy("docs *.md\nprefixes\n"), /needs at least one prefix/);
  });

  test("no rules and no prefixes are both refused, never defaulted", () => {
    // "No rules" must never read as "nothing is docs": a silent full lane
    // forever looks like the safe direction while hiding a broken config.
    assert.throws(() => parsePolicy("prefixes docs\n"), /declares no docs or code rules/);
    assert.throws(() => parsePolicy("docs *.md\n"), /sets no prefixes/);
  });

  test("dispatch-without-pr takes only refuse or allow", () => {
    assert.equal(parsePolicy("docs *.md\nprefixes docs\n").dispatchWithoutPr, "refuse");
    assert.equal(parsePolicy("docs *.md\nprefixes docs\ndispatch-without-pr allow\n").dispatchWithoutPr, "allow");
    assert.throws(() => parsePolicy("docs *.md\nprefixes docs\ndispatch-without-pr maybe\n"), /takes refuse or allow/);
  });
});

describe("reading the policy", () => {
  test("a plain file at the fixed path is read", () => {
    withRepo((root) => assert.match(readPolicy(root), /docs \*\.md/));
  });

  test("a symlinked policy file is refused", () => {
    // Refused rather than resolved. Resolution is what generated five rounds
    // of findings, and no consumer needs a symlinked policy.
    withRepo((root) => assert.throws(() => readPolicy(root), /is a symlink/), { link: ".github/real.conf" });
  });

  test("a symlinked directory component is refused too", () => {
    // The link that mattered was not always the last component.
    withRepo((root) => assert.throws(() => readPolicy(root), /is a symlink/), { dirLink: true });
  });

  test("a missing policy is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "lanes-"));
    mkdirSync(join(root, ".github"));
    assert.throws(() => readPolicy(root), /No lanes policy/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("classify", () => {
  test("a markdown-only diff is docs", async () => {
    assert.equal(await classify(PR_ENV, POLICY, ctx({ files: named("README.md", "docs/DESIGN.md") })), true);
  });

  test("one code file makes it code", async () => {
    assert.equal(await classify(PR_ENV, POLICY, ctx({ files: named("README.md", "src/main.rs") })), false);
  });

  test("a rename is judged on both sides", async () => {
    const renamed = [{ filename: "docs/A.md", previous_filename: "src/a.rs" }];
    assert.equal(await classify(PR_ENV, POLICY, ctx({ files: renamed })), false);
    const within = [{ filename: "docs/NEW.md", previous_filename: "docs/OLD.md" }];
    assert.equal(await classify(PR_ENV, POLICY, ctx({ files: within })), true);
  });

  test("an empty diff is not a docs diff", async () => {
    assert.equal(await classify(PR_ENV, POLICY, ctx({ files: [], changed: 0 })), false);
  });

  test("a truncated file list is refused, not classified", async () => {
    await assert.rejects(
      classify(PR_ENV, POLICY, ctx({ files: named("README.md"), changed: 3000 })),
      /File list incomplete/,
    );
  });

  test("an unreadable changed_files count is refused", async () => {
    // A total that cannot be compared must not take the same branch as one
    // that compared equal.
    await assert.rejects(
      classify(PR_ENV, POLICY, ctx({ files: named("README.md"), changed: null })),
      /unreadable changed_files count/,
    );
  });

  test("a shared head never rides the docs lane", async () => {
    // A check run is per-commit, so a gate minted for this pull request's
    // justified skip would satisfy a stacked one whose diff is code.
    const shared = [
      { state: "open", head: { sha: "headsha" }, number: 1 },
      { state: "open", head: { sha: "headsha" }, number: 2 },
    ];
    assert.equal(await classify(PR_ENV, POLICY, ctx({ files: named("README.md"), pulls: shared })), false);
  });

  test("a lone FOREIGN head pull request does not vouch either", async () => {
    const other = [{ state: "open", head: { sha: "headsha" }, number: 2 }];
    assert.equal(await classify(PR_ENV, POLICY, ctx({ files: named("README.md"), pulls: other })), false);
  });

  test("a non-pull-request event is code", async () => {
    assert.equal(await classify({ ...PR_ENV, event: "push" }, POLICY, ctx({ files: named("README.md") })), false);
  });
});

describe("binding a run to its own pull request", () => {
  test("the triggering pull request passes", () => {
    assert.doesNotThrow(() => verifyPrBinding(PR_ENV));
  });

  test("a pr naming a different pull request is refused", () => {
    assert.throws(() => verifyPrBinding({ ...PR_ENV, pr: "2" }), /must not label another/);
  });

  test("an unset or non-PR ref is refused, not waved through", () => {
    assert.throws(() => verifyPrBinding({ ...PR_ENV, ref: "" }), /must not label another/);
    assert.throws(() => verifyPrBinding({ ...PR_ENV, ref: "refs/heads/main" }), /must not label another/);
  });

  test("a prefix collision is not a match", () => {
    assert.throws(() => verifyPrBinding({ ...PR_ENV, ref: "refs/pull/11/merge" }), /must not label another/);
  });

  test("a dispatch must name a pull request unless the policy allows none", async () => {
    const env = { event: "workflow_dispatch", pr: "", dispatchWithoutPr: "refuse" };
    await assert.rejects(verifyDispatchBinding(env, ctx({})), /must name the pull request/);
    await assert.doesNotReject(verifyDispatchBinding({ ...env, dispatchWithoutPr: "allow" }, ctx({})));
  });

  test("a dispatch for another pull request's commit is refused", async () => {
    const env = { event: "workflow_dispatch", pr: "1", sha: "otherhead" };
    await assert.rejects(verifyDispatchBinding(env, ctx({})), /must not label another/);
  });

  test("a dispatch on a shared head is refused", async () => {
    const shared = [
      { state: "open", head: { sha: "headsha" }, number: 1 },
      { state: "open", head: { sha: "headsha" }, number: 2 },
    ];
    const env = { event: "workflow_dispatch", pr: "1", sha: "headsha" };
    await assert.rejects(verifyDispatchBinding(env, ctx({ pulls: shared })), /cannot vouch for exactly one/);
  });
});

describe("the results input", () => {
  test("a real all-green input parses", () => {
    assert.equal(parseResults("check=success msrv=success").length, 2);
  });

  test("whitespace names no jobs and is refused", () => {
    // ${RESULTS:?} rejected unset and empty but not whitespace, and spaces
    // split to nothing: zero iterations and a green gate that was told
    // nothing. Reachable by ordinary misconfiguration.
    assert.throws(() => parseResults(" "), /named no heavy jobs/);
    assert.throws(() => parseResults("\t"), /named no heavy jobs/);
    assert.throws(() => parseResults(""), /named no heavy jobs/);
  });

  test("a vanished job is named in the error", () => {
    assert.throws(() => parseResults("check=success msrv="), /Job 'msrv' reported no result/);
  });

  test("a token with no = is refused", () => {
    assert.throws(() => parseResults("check=success garbage"), /Malformed entry 'garbage'/);
  });

  test("a result attributed to no job is refused", () => {
    // The other half of the vanished-job case: an empty NAME still counts
    // toward all-success, so the gate would report green having named no
    // heavy job -- the whitespace failure one layer in.
    assert.throws(() => parseResults("=success"), /names no job/);
    assert.throws(() => parseResults("check=success =skipped"), /names no job/);
  });
});

describe("gate", () => {
  const green = { ...PR_ENV, classifyResult: "success", results: "check=success msrv=success" };
  const skipped = { ...PR_ENV, classifyResult: "success", results: "check=skipped msrv=skipped" };
  const docsCtx = () => ctx({ files: named("README.md"), commits: [{ parents: [{}], commit: { message: "docs: x" } }] });

  test("all heavy jobs green passes", async () => {
    await assert.doesNotReject(gate(green, POLICY, ctx({ files: named("src/a.rs") })));
  });

  test("a justified skip with prefixed commits passes", async () => {
    await assert.doesNotReject(gate(skipped, POLICY, docsCtx()));
  });

  test("a failed classify fails the gate", async () => {
    await assert.rejects(gate({ ...skipped, classifyResult: "failure" }, POLICY, docsCtx()), /nothing vouches/);
  });

  test("a red or half-skipped set fails", async () => {
    const red = { ...green, results: "check=failure msrv=success" };
    await assert.rejects(gate(red, POLICY, ctx({ files: named("src/a.rs") })), /not all green/);
    const half = { ...green, results: "check=skipped msrv=success" };
    await assert.rejects(gate(half, POLICY, ctx({ files: named("src/a.rs") })), /not all green/);
  });

  test("a skip on a code diff is refused", async () => {
    const code = ctx({ files: named("src/a.rs"), commits: [{ parents: [{}], commit: { message: "docs: x" } }] });
    await assert.rejects(gate(skipped, POLICY, code), /refusing the skip/);
  });

  test("a skip on a policy edit is refused", async () => {
    const policyEdit = ctx({ files: named(POLICY_PATH), commits: [{ parents: [{}], commit: { message: "docs: x" } }] });
    await assert.rejects(gate(skipped, POLICY, policyEdit), /refusing the skip/);
  });
});

describe("the prefix lint", () => {
  const commits = (...msgs) => msgs.map((m) => ({ parents: [{}], commit: { message: m } }));

  test("a prefixed subject passes and a bare one does not", async () => {
    await assert.doesNotReject(lintPrefixes("1", POLICY, ctx({ commits: commits("docs: Fix a typo") })));
    await assert.rejects(lintPrefixes("1", POLICY, ctx({ commits: commits("Fix a typo") })), /lacks a prefix/);
  });

  test("a prefix outside the table fails", async () => {
    await assert.rejects(lintPrefixes("1", POLICY, ctx({ commits: commits("chore: tidy") })), /lacks a prefix/);
  });

  test("merge commits are exempt by parent count, not by wording", async () => {
    const merge = [{ parents: [{}, {}], commit: { message: "Merge branch 'main'" } }];
    await assert.doesNotReject(lintPrefixes("1", POLICY, ctx({ commits: merge })));
    await assert.rejects(
      lintPrefixes("1", POLICY, ctx({ commits: commits("Merge installation sections") })),
      /lacks a prefix/,
    );
  });

  test("a truncated or unreadable commit list fails the lint", async () => {
    await assert.rejects(
      lintPrefixes("1", POLICY, ctx({ commits: commits("docs: x"), nCommits: 300 })),
      /Commit list incomplete/,
    );
    await assert.rejects(
      lintPrefixes("1", POLICY, ctx({ commits: commits("docs: x"), nCommits: null })),
      /unreadable commit count/,
    );
  });
});

describe("changedPaths", () => {
  test("returns both sides of a rename", async () => {
    const files = [{ filename: "b.md", previous_filename: "a.md" }, { filename: "c.md" }];
    assert.deepEqual(await changedPaths("1", ctx({ files, changed: 2 })), ["b.md", "a.md", "c.md"]);
  });
});

describe("the entry point", () => {
  // The bug this covers is a silent success: while `lanes.mjs` ended in
  // `if (import.meta.url === `file://${process.argv[1]}`)`, a checkout under
  // a path containing a space or a `#` percent-encoded on the URL side only,
  // the comparison went false, `main()` was never called, and the process
  // exited 0 -- the gate reporting green on a diff it had not read. So this
  // runs the real file the manifest names, from exactly such a directory,
  // and asserts both directions: a run that must fail exits non-zero, and a
  // run that must succeed produces its output rather than merely exiting 0.
  const entry = () => {
    // The manifest is two flat keys under `runs:`; matching `main:` there is
    // an approximation of YAML, so it also asserts there is exactly one.
    const yml = readFileSync(new URL("./action.yml", import.meta.url), "utf8");
    const hits = [...yml.matchAll(/^\s+main:\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(hits.length, 1, "action.yml should name exactly one entry point");
    return hits[0];
  };

  /** Copy the engine into a hostile directory name and run the manifest's entry point. */
  const runEntry = ({ policy, ...env }) => {
    const root = mkdtempSync(join(tmpdir(), "lanes-"));
    try {
      // A space and a `#`: two characters a URL encodes and a path does not.
      const checkout = join(root, "a b#c");
      mkdirSync(join(checkout, ".github"), { recursive: true });
      for (const f of ["lanes.mjs", entry()]) {
        copyFileSync(new URL(`./${f}`, import.meta.url), join(checkout, f));
      }
      if (policy !== undefined) writeFileSync(join(checkout, POLICY_PATH), policy);
      const out = join(root, "out");
      writeFileSync(out, "");
      const r = spawnSync(process.execPath, [join(checkout, entry())], {
        cwd: checkout,
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
      });
      return { ...r, output: readFileSync(out, "utf8") };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("a run that must fail exits non-zero from a path with a space and a '#'", () => {
    // No policy file, so the engine must refuse. Exit 0 here would be the
    // silent-success shape: green having inspected nothing.
    const r = runEntry({ INPUT_MODE: "gate", GITHUB_EVENT_NAME: "push" });
    assert.notEqual(r.status, 0, `expected a refusal, got: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /::error::.*No lanes policy/);
  });

  test("a run that must succeed writes its output from the same path", () => {
    const r = runEntry({
      INPUT_MODE: "classify",
      GITHUB_EVENT_NAME: "push",
      policy: "docs *.md\nprefixes docs\n",
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    // Exiting 0 proves nothing on its own -- an entry point that never ran
    // exits 0 too. The output is what proves it ran.
    assert.equal(r.output, "docs_only=false\n");
  });
});
