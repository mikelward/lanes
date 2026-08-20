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
import { generateKeyPairSync, createVerify } from "node:crypto";

import {
  POLICY_PATH,
  PolicyError,
  changedPaths,
  classify,
  classifyOrCode,
  gate,
  isDocs,
  lintPrefixes,
  parsePolicy,
  parseResults,
  readPolicy,
  verifyDispatchBinding,
  verifyEventBinding,
  verifyPrBinding,
  eventSnapshot,
  stillPinned,
  baseTip,
  signAppJwt,
  installationId,
  installationToken,
  appToken,
  statusSha,
  publishStatus,
  publishPending,
  publishResult,
} from "./lanes.mjs";

/** A stubbed API: canned bodies keyed by a substring of the request path. */
// `changed` and `nCommits` distinguish "not specified" (undefined -> derive
// from the fixture) from "specified as this exact value" -- including null.
// Defaulting them with `??` meant a deliberately unreadable count fell
// through to the real one, so the guard under test never saw a bad value and
// the case passed while asserting nothing.
function stub({
  files = [],
  changed,
  commits = [],
  nCommits,
  headSha = "headsha",
  pulls = null,
  title = "docs: A pull request",
  baseRef = "main",
  tip = "basetip",
  compare = "ahead",
} = {}) {
  const routes = [
    [/\/pulls\/\d+\/files/, () => files],
    [/\/pulls\/\d+\/commits/, () => commits],
    [/\/commits\/[^/]+\/pulls/, () => pulls ?? [{ state: "open", head: { sha: headSha }, number: 1 }]],
    [/\/git\/ref\/heads\//, () => ({ object: { sha: tip } })],
    [/\/compare\//, () => ({ status: compare })],
    [
      /\/pulls\/\d+$/,
      () => ({
        changed_files: changed === undefined ? files.length : changed,
        commits: nCommits === undefined ? commits.length : nCommits,
        head: { sha: headSha },
        base: { ref: baseRef },
        title,
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
// pull_request_target's GITHUB_REF is the base branch, not refs/pull/<pr>/... --
// so binding for it reads the event payload's own pull_request.number instead.
const PR_TARGET_ENV = {
  event: "pull_request_target",
  pr: "1",
  ref: "refs/heads/main",
  sha: "basetip",
  snapshot: { number: 1 },
};

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

  test("lint-title takes yes or no, and defaults to no", () => {
    assert.equal(parsePolicy("docs *.md\nprefixes docs\n").lintTitle, true, "on by default");
    assert.equal(parsePolicy("docs *.md\nprefixes docs\nlint-title yes\n").lintTitle, true);
    assert.equal(parsePolicy("docs *.md\nprefixes docs\nlint-title no\n").lintTitle, false);
    assert.throws(
      () => parsePolicy("docs *.md\nprefixes docs\nlint-title maybe\n"),
      /takes yes or no/,
    );
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

// The light lane is a privilege, and an unverifiable retarget story is enough
// to withhold it. Refusing at the gate instead would red a required check over
// YAML this cannot parse; running the heavy jobs is never a lockout.
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

  test("pull_request_target classifies the same way pull_request does", async () => {
    assert.equal(
      await classify(PR_TARGET_ENV, POLICY, ctx({ files: named("README.md", "docs/DESIGN.md") })),
      true,
    );
    assert.equal(await classify(PR_TARGET_ENV, POLICY, ctx({ files: named("src/main.rs") })), false);
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

  test("pull_request_target binds on the payload's number, not GITHUB_REF", () => {
    // GITHUB_REF under this trigger is the base branch, so a ref matching
    // refs/pull/<pr>/... would never be there to check -- this must not fall
    // through to the pull_request path and refuse a genuine match, or accept
    // one it never verified.
    assert.doesNotThrow(() => verifyPrBinding(PR_TARGET_ENV));
  });

  test("pull_request_target refuses a pr claim the event does not name", () => {
    assert.throws(() => verifyPrBinding({ ...PR_TARGET_ENV, pr: "2" }), /must not label another/);
  });

  test("pull_request_target refuses a missing or unreadable snapshot number", () => {
    assert.throws(() => verifyPrBinding({ ...PR_TARGET_ENV, snapshot: {} }), /must not label another/);
    assert.throws(() => verifyPrBinding({ ...PR_TARGET_ENV, snapshot: null }), /must not label another/);
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

  test("a dispatch pins the base the CALLER carried forward, not a live read", async () => {
    // The gate runs after the heavy jobs, so a base sampled here would settle
    // against itself and agree whatever those jobs built against. Only the
    // caller has a value from before them.
    const env = { event: "workflow_dispatch", pr: "1", sha: "headsha", baseSha: "before-the-jobs" };
    const pin = await verifyDispatchBinding(env, ctx({ tip: "moved-since" }));
    assert.equal(pin.baseSha, "before-the-jobs");
    const unbound = await verifyDispatchBinding({ ...env, baseSha: "" }, ctx({ tip: "moved-since" }));
    assert.equal(unbound.baseSha, null, "absent must stay absent, not become a live read");
  });
});

describe("a dispatched run needs a base recorded before it is measured", () => {
  const green = {
    event: "workflow_dispatch",
    pr: "1",
    sha: "headsha",
    classifyResult: "success",
    results: "check=success",
  };
  const pin = { head: "headsha", baseRef: "main", baseSha: null, title: null };

  test("without one, the green is refused rather than certified", async () => {
    await assert.rejects(gate(green, POLICY, ctx(), pin), /nothing records the base/);
  });

  test("with one, it settles like any other", async () => {
    await gate(green, POLICY, ctx({ tip: "basetip" }), { ...pin, baseSha: "basetip" });
  });

  test("and a base that moved while the jobs ran is caught", async () => {
    // The whole point of carrying it forward: this is invisible to a gate
    // that reads the base itself.
    await assert.rejects(
      gate(green, POLICY, ctx({ tip: "moved-since" }), { ...pin, baseSha: "before-the-jobs" }),
      /moved from before-the-jobs to moved-since/,
    );
  });

  test("a dispatched SKIP needs one too", async () => {
    // Missed at first on the reasoning that re-deriving the classification
    // against the current base made a pin redundant. It does not: `classify`
    // and `stillPinned` are separate reads, and a base advancing between them
    // moves neither the head nor the base's NAME — the only two things
    // settlement can otherwise compare — so the skip publishes for a diff
    // measured against a base that has already gone.
    const skipped = { ...green, results: "check=skipped" };
    await assert.rejects(
      gate(skipped, POLICY, ctx({ files: named("README.md") }), pin),
      /nothing records the base/,
    );
  });

  test("a push-event green with no pull request is untouched", async () => {
    // The refusal is about a PR-bound dispatch, not about every pin-less run.
    await gate({ ...green, event: "push", pr: "" }, POLICY, ctx(), null);
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

  test("a repeated job name is refused", () => {
    // Job IDs are unique, so a repeat is a copy-pasted line whose name was
    // never changed -- and the job it should have named is the one now
    // missing, whose failure the gate would never see.
    assert.throws(() => parseResults("check=success check=success"), /appears twice/);
    assert.throws(() => parseResults("check=success msrv=failure check=skipped"), /appears twice/);
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

describe("the policy path's spelling", () => {
  // A case-insensitive filesystem (macOS, Windows) opens `.github/LANES.conf`
  // through the lowercase path without complaint, while the files API reports
  // the repository's own spelling -- so the engine would read a policy under a
  // name no guard recognizes. Linux CI cannot produce that filesystem, so the
  // seams simulate it: lstat answers to the lowercase name, readdir reports
  // what the repository actually spells.
  const insensitive = (spelling) => ({
    lstat: () => ({ isSymbolicLink: () => false }),
    readdir: (dir) => (dir.endsWith(".github") ? [spelling] : [".github"]),
    readFile: () => "docs **\nprefixes docs\n",
  });

  test("the exact spelling is read", () => {
    const { lstat, readdir, readFile } = insensitive("lanes.conf");
    assert.match(readPolicy(".", readFile, lstat, readdir), /docs \*\*/);
  });

  test("a case alias is refused, not read", () => {
    const { lstat, readdir, readFile } = insensitive("LANES.conf");
    assert.throws(() => readPolicy(".", readFile, lstat, readdir), /is not spelled that way on disk/);
  });

  test("a case alias in the diff is code whatever the policy says", () => {
    // The other half, and the asymmetry is deliberate: the two names are one
    // file on a case-insensitive filesystem, so a diff naming this can be an
    // edit to the rules in force. Wrongly code costs a full lane; wrongly
    // docs skips review of the rules themselves.
    // Both spellings have to be reachable BY THE RULES, or the assertion
    // passes on glob matching being case-sensitive and says nothing about the
    // guard: `**` does not match a leading dot and no lowercase pattern
    // matches `.GITHUB/`, so the fixture spells out each one.
    const hostile = parsePolicy("docs .github/*.conf\ndocs .GITHUB/*.CONF\nprefixes docs\n").rules;
    assert.equal(isDocs(".github/other.conf", hostile), true, "the lowercase rule really is permissive");
    assert.equal(isDocs(".GITHUB/OTHER.CONF", hostile), true, "the uppercase rule really is permissive");
    assert.equal(isDocs(".github/lanes.conf", hostile), false);
    assert.equal(isDocs(".GITHUB/LANES.CONF", hostile), false);
  });
});

describe("a classification that cannot be established", () => {
  // One rule: classify never fails. It answers "may the heavy jobs skip?",
  // and every failure to establish "yes" is "no", which runs them -- what the
  // action documents `docs_only` to be. Wrapping only the `classify` call and
  // leaving the binding lookups in front of it fatal was the same
  // enumerate-the-routes mistake the policy path and the glob matcher each
  // cost rounds of, so the wrapper takes the whole path.
  const broken = { token: "t", repo: "example/repo", fetchImpl: async () => { throw new Error("network down"); } };

  test("a failure anywhere in the path reports the code lane, and says why", async () => {
    const said = [];
    const failed = await classifyOrCode(() => classify(PR_ENV, POLICY, broken), (m) => said.push(m));
    assert.equal(failed, false);
    // Reported, not swallowed -- a silent false is indistinguishable from a
    // diff that genuinely contains code.
    assert.match(said.join(""), /::warning::.*network down.*code lane/);
  });

  test("the dispatch binding is inside the fallback, not in front of it", async () => {
    // Its lookups are two more API calls that a blip can fail, and they run
    // before the classification. Outside the wrapper they failed the classify
    // job, which fails the gate, for a run that should have taken full lane.
    const dispatch = { event: "workflow_dispatch", pr: "1", sha: "headsha", dispatchWithoutPr: "refuse" };
    await assert.rejects(verifyDispatchBinding(dispatch, broken), /network down/, "the check really does throw");
    assert.equal(await classifyOrCode(() => verifyDispatchBinding(dispatch, broken), () => {}), false);
  });

  test("a working classification is untouched", async () => {
    const said = [];
    const ok = ctx({ files: named("README.md") });
    assert.equal(await classifyOrCode(() => classify(PR_ENV, POLICY, ok), (m) => said.push(m)), true);
    assert.deepEqual(said, []);
  });

  test("the gate still fails closed on the same failure", async () => {
    // Deliberately NOT wrapped there: a skip that cannot be refuted is the
    // one the gate exists to refuse. The gate repeats every check classify
    // shrugs off, which is what makes shrugging safe.
    await assert.rejects(
      gate({ ...PR_ENV, classifyResult: "success", results: "check=skipped" }, POLICY, broken),
      /network down/,
    );
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
    assert.equal(r.output, "docs_only=false\nbase_sha=\n");
  });

  test("the whole classify path falls back to code, policy read included", () => {
    // The same missing policy the gate refuses above. End to end because the
    // rule is about the path rather than any call on it: whatever classify
    // mode fails to establish, it reports code and exits 0 so the heavy jobs
    // run, and the gate is where that failure turns the check red.
    const r = runEntry({ INPUT_MODE: "classify", GITHUB_EVENT_NAME: "push" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(r.output, "docs_only=false\nbase_sha=\n");
    assert.match(r.stdout, /::warning::.*No lanes policy.*code lane/);
  });

  test("a binding failure is inside classify's fallback and outside the gate's", () => {
    // `verifyPrBinding` needs no API, so this pins where `main` puts the
    // binding checks rather than what the wrapper does when handed one.
    // Naming a pull request with no `refs/pull/1/` to back it: classify takes
    // the code lane, the gate refuses.
    const env = { INPUT_PR: "1", GITHUB_EVENT_NAME: "pull_request", policy: "docs *.md\nprefixes docs\n" };
    const classified = runEntry({ ...env, INPUT_MODE: "classify" });
    assert.equal(classified.status, 0, `${classified.stdout}${classified.stderr}`);
    assert.equal(classified.output, "docs_only=false\nbase_sha=\n");
    const gated = runEntry({ ...env, INPUT_MODE: "gate", "INPUT_CLASSIFY-RESULT": "success", INPUT_RESULTS: "check=skipped" });
    assert.notEqual(gated.status, 0, `expected a refusal, got: ${gated.stdout}${gated.stderr}`);
    assert.match(gated.stdout, /::error::.*must not label another's commit/);
  });

  test("reads hyphenated inputs under the names the runner actually sets", () => {
    // The runner uppercases input names and converts SPACES to underscores --
    // nothing else -- so `classify-result` arrives as INPUT_CLASSIFY-RESULT.
    // The first version of the entry point read INPUT_CLASSIFY_RESULT, and
    // this suite agreed with it, setting the same misspelled name: every
    // hyphenated input read as empty on a real runner while the tests stayed
    // green, and the gate refused the first consumer's all-green run. Both
    // directions: the runner's spelling reaches the engine, and the
    // misspelling no longer does.
    const env = {
      GITHUB_EVENT_NAME: "push",
      policy: "docs *.md\nprefixes docs\n",
      INPUT_MODE: "gate",
      INPUT_RESULTS: "check=success",
    };
    const real = runEntry({ ...env, "INPUT_CLASSIFY-RESULT": "success" });
    assert.equal(real.status, 0, `${real.stdout}${real.stderr}`);
    const misspelled = runEntry({ ...env, INPUT_CLASSIFY_RESULT: "success" });
    assert.notEqual(misspelled.status, 0, "the underscore spelling is not what the runner sets");
    assert.match(misspelled.stdout, /::error::.*classify did not succeed/);
  });

  test("an unknown mode is an error, not a code-lane fallback", () => {
    // Otherwise a typo'd mode takes the classify path's shrug and exits 0
    // having done nothing -- a job that looks like it classified.
    const r = runEntry({ INPUT_MODE: "clasify", GITHUB_EVENT_NAME: "push", policy: "docs *.md\nprefixes docs\n" });
    assert.notEqual(r.status, 0, `expected a refusal, got: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /::error::.*Unknown mode 'clasify'/);
  });
});

// The time-of-check/time-of-use family. Every listing the engine makes
// answers with the pull request's CURRENT state, while the check run it
// produces lands on the commit the run STARTED from -- so each of these
// covers a way those two can drift apart mid-run. `synchronize` and `edited`
// start a fresh run but cancel nothing, so the stale run's verdict and the
// replacement's land on the same commit with no ordering between them.
describe("the event snapshot", () => {
  const write = (payload) => {
    const dir = mkdtempSync(join(tmpdir(), "lanes-event-"));
    const file = join(dir, "event.json");
    writeFileSync(file, JSON.stringify(payload));
    return file;
  };

  test("comes from the payload, not from inputs a consumer could forget to wire", () => {
    const path = write({
      pull_request: { number: 7, head: { sha: "abc" }, base: { ref: "topic", sha: "def" } },
      repository: { default_branch: "main" },
    });
    assert.deepEqual(eventSnapshot({ GITHUB_EVENT_PATH: path }), {
      number: 7,
      head: "abc",
      baseRef: "topic",
      baseSha: "def",
    });
  });

  test("is absent rather than invented when there is no payload", () => {
    assert.equal(eventSnapshot({}), null);
  });

  test("an unreadable payload is refused, not treated as absent", () => {
    // Absent and unreadable must not take the same branch: absent is a push
    // or a dispatch, where there is no head/base pair to move, while
    // unreadable is a pull_request run whose own trigger is unknown.
    assert.throws(
      () => eventSnapshot({ GITHUB_EVENT_PATH: "/nope/event.json" }),
      /trigger cannot be established/,
    );
  });
});

describe("binding a run to the snapshot it was triggered for", () => {
  const snap = (over = {}) => ({ head: "headsha", baseRef: "main", baseSha: "basesha", ...over });
  const env = (over = {}) => ({ event: "pull_request", pr: "1", snapshot: snap(), ...over });

  test("an unmoved pull request yields the pin the settlement will use", async () => {
    assert.deepEqual(
      await verifyEventBinding(env(), ctx({ files: named("README.md"), tip: "basesha" })),
      { head: "headsha", baseRef: "main", baseSha: "basesha", title: null },
    );
  });

  test("pull_request_target takes the same path once a snapshot exists", async () => {
    // Everything below this point reasons from the payload and live reads,
    // neither of which differs by trigger -- only GITHUB_REF/GITHUB_SHA do,
    // and neither is read here.
    assert.deepEqual(
      await verifyEventBinding(env({ event: "pull_request_target" }), ctx({ tip: "basesha" })),
      { head: "headsha", baseRef: "main", baseSha: "basesha", title: null },
    );
  });

  test("the pin records the EVENT's base commit, not the live tip", async () => {
    // Two readers, two moments: the heavy jobs built against the base as it
    // stood near the event, `changedPaths()` classifies against the tip when
    // the gate runs. Pinning the tip guards the second and lets the first go
    // stale; pinning the event's commit and demanding it still BE the tip at
    // settlement is what makes them the same commit.
    const pin = await verifyEventBinding(env(), ctx({ tip: "moved-on", compare: "ahead" }));
    assert.equal(pin.baseSha, "basesha");
  });

  test("a head that moved after the event is refused", async () => {
    // The heavy jobs validated the OLD merge snapshot; the replacement head's
    // own run owns the verdict.
    await assert.rejects(
      verifyEventBinding(env(), ctx({ headSha: "newhead" })),
      /head moved after this run's event/,
    );
  });

  test("a retarget after the event is refused", async () => {
    await assert.rejects(
      verifyEventBinding(env(), ctx({ baseRef: "other" })),
      /retargeted after this run's event/,
    );
  });

  test("a base branch that was rewritten is refused", async () => {
    // A force-push to the base moves this pull request's diff while head and
    // base ref both stand still.
    await assert.rejects(
      verifyEventBinding(env(), ctx({ tip: "rewritten", compare: "diverged" })),
      /base branch was rewritten after this run's event/,
    );
  });

  test("a base branch that only advanced is not a rewrite", async () => {
    // Asked by ancestry rather than by name: refusing every moved tip would
    // fail every run straddling an unrelated merge, and exempting a branch
    // for being the default one assumes a branch protection nobody promised.
    const pin = await verifyEventBinding(env(), ctx({ tip: "moved-on", compare: "ahead" }));
    assert.equal(pin.baseSha, "basesha");
  });

  test("a head shared with a twin pull request is refused", async () => {
    await assert.rejects(
      verifyEventBinding(
        env(),
        ctx({ pulls: [
          { state: "open", head: { sha: "headsha" }, number: 1 },
          { state: "open", head: { sha: "headsha" }, number: 2 },
        ] }),
      ),
      /cannot vouch for exactly one/,
    );
  });

  test("a payload missing ANY of the three fields is refused, not degraded", async () => {
    // The base fields were optional, which made every guard below them
    // conditional on data a `pull_request` payload always carries: a truncated
    // one skipped the retarget check, skipped the rewrite check, and left
    // `pin.baseSha` null so settlement never looked at the base at all — a
    // green published for a snapshot nothing verified. A guard that switches
    // itself off when its input is absent is not a guard.
    for (const field of ["head", "baseRef", "baseSha"]) {
      await assert.rejects(
        verifyEventBinding(env({ snapshot: snap({ [field]: null }) }), ctx()),
        new RegExp(`missing ${field}`),
        field,
      );
    }
  });

  test("a non-pull_request event has no pin to take", async () => {
    assert.equal(await verifyEventBinding({ event: "push", pr: "", snapshot: null }, ctx()), null);
  });
});

describe("settling the pin after the reads the verdict rests on", () => {
  const pin = (over = {}) => ({ head: "headsha", baseRef: "main", baseSha: null, title: null, ...over });

  test("an unmoved pull request settles", async () => {
    await stillPinned("1", pin(), POLICY, ctx());
  });

  test("a force-push landing mid-run is refused", async () => {
    // `pulls` pinned to the OLD head so the twin check passes and the identity
    // read — which now runs last, see stillPinned — is what refuses.
    const moved = { headSha: "newhead", pulls: [{ state: "open", head: { sha: "headsha" }, number: 1 }] };
    await assert.rejects(stillPinned("1", pin(), POLICY, ctx(moved)), /moved while the gate/);
  });

  test("a retarget landing mid-run is refused", async () => {
    await assert.rejects(stillPinned("1", pin(), POLICY, ctx({ baseRef: "other" })), /moved while the gate/);
  });

  test("a base rewritten mid-run is refused", async () => {
    await assert.rejects(
      stillPinned("1", pin({ baseSha: "old" }), POLICY, ctx({ tip: "new", compare: "diverged" })),
      /base branch moved from old to new/,
    );
  });

  test("a base that merely ADVANCED mid-run is refused too", async () => {
    // Ancestry is not enough here, on either verdict. `base...head` is
    // measured from the merge base, so advancing the base into the head's own
    // history drops commits from the diff rather than adding paths to it.
    await assert.rejects(
      stillPinned("1", pin({ baseSha: "old" }), POLICY, ctx({ tip: "new", compare: "ahead" })),
      /moved from old to new/,
    );
  });

  test("a base that stood still settles", async () => {
    await stillPinned("1", pin({ baseSha: "basetip" }), POLICY, ctx());
  });

  test("a twin pull request appearing mid-run is refused", async () => {
    await assert.rejects(
      stillPinned("1", pin(), POLICY, ctx({ pulls: [
        { state: "open", head: { sha: "headsha" }, number: 1 },
        { state: "open", head: { sha: "headsha" }, number: 2 },
      ] })),
      /gained a second open pull request/,
    );
  });

  test("a title that lost its prefix mid-run is refused", async () => {
    await assert.rejects(
      stillPinned("1", pin({ title: "docs: original" }), POLICY, ctx({ title: "Rewrite the guide" })),
      /title lost its prefix/,
    );
  });

  test("a benign retitle is not a move", async () => {
    // Re-VALIDATED, not compared: the squash subject is just as honest after
    // `docs: A` becomes `docs: B`, so failing the run would be a false alarm.
    await stillPinned("1", pin({ title: "docs: original" }), POLICY, ctx({ title: "docs: a better name" }));
  });

  test("no pin means nothing to settle", async () => {
    // A push-event gate reports on a branch, where there is no head/base pair
    // to move -- so the absence of a pin must not be an error.
    await stillPinned("1", null, POLICY, ctx({ headSha: "whatever" }));
  });
});

describe("the all-green path settles too", () => {
  const green = { ...PR_ENV, classifyResult: "success", results: "check=success" };
  const pin = { head: "headsha", baseRef: "main", baseSha: null, title: null };

  test("green results on an unmoved pull request report", async () => {
    await gate(green, POLICY, ctx({ files: named("src/a.js") }), pin);
  });

  test("green results on a pull request that moved are refused", async () => {
    // The heavy jobs really did pass -- for a snapshot the pull request no
    // longer shows. Same failure as an unjustified skip, from the other side.
    const moved = { headSha: "newhead", pulls: [{ state: "open", head: { sha: "headsha" }, number: 1 }] };
    await assert.rejects(gate(green, POLICY, ctx(moved), pin), /moved while the gate/);
  });

  test("a base that fast-forwarded under a green build is refused", async () => {
    // The heavy jobs built merge(head, base-at-the-event). Once the base
    // moves, that is not the snapshot the pull request would land, so their
    // success cannot vouch for it -- ancestry is not enough on this path.
    await assert.rejects(
      gate(green, POLICY, ctx({ tip: "advanced", compare: "ahead" }), { ...pin, baseSha: "basesha" }),
      /moved from basesha to advanced/,
    );
  });

  test("the same movement is refused under a SKIP too", async () => {
    // A skip looks like the safe side of this -- a classification rather than
    // evidence, with no path added by a fast-forward. It isn't: advancing the
    // base INTO the head's history drops commits from the diff, so a head
    // that changes code and then reverts it reads as documentation from the
    // old base and as code from the new one.
    const skip = { ...PR_ENV, classifyResult: "success", results: "check=skipped" };
    await assert.rejects(
      gate(
        skip,
        POLICY,
        ctx({ files: named("README.md"), commits: [{ parents: [{}], commit: { message: "docs: x" } }], tip: "advanced", compare: "ahead" }),
        { ...pin, baseSha: "basesha" },
      ),
      /moved from basesha to advanced/,
    );
  });

  test("green results with no pin still report", async () => {
    await gate(green, POLICY, ctx({ headSha: "whatever" }), null);
  });
});

// Whether the title is a SUBJECT depends on how the consumer merges, so the
// lint is opt-in. Under a squash it lands on the default branch; under a rebase
// or a merge commit it never lands at all, and requiring a prefix on it fails a
// pull request whose commits are all correctly prefixed.
describe("the title is a subject too", () => {
  const docs = { files: named("README.md"), commits: [{ parents: [{}], commit: { message: "docs: x" } }] };
  const LINTED = parsePolicy("docs *.md\nprefixes docs test\n");
  const OFF = parsePolicy("docs *.md\nprefixes docs test\nlint-title no\n");

  test("a prefixed title passes the lint", async () => {
    await lintPrefixes("1", LINTED, ctx({ ...docs, title: "docs: something" }));
  });

  test("a bare title fails it, because a squash merge lands that line", async () => {
    await assert.rejects(
      lintPrefixes("1", LINTED, ctx({ ...docs, title: "Rewrite the setup guide" })),
      /title lacks a prefix/,
    );
  });

  test("an empty title is refused rather than skipped", async () => {
    await assert.rejects(lintPrefixes("1", LINTED, ctx({ ...docs, title: "" })), /no title to check/);
  });

  test("the judged title is recorded on the pin for settlement", async () => {
    const pin = { head: "h", baseRef: "main", baseSha: null, title: null };
    await lintPrefixes("1", LINTED, ctx({ ...docs, title: "docs: something" }), pin);
    assert.equal(pin.title, "docs: something");
  });

  test("turned off, a bare title is nobody's business", async () => {
    // The COMMITS still have to be prefixed — that is what guards what lands.
    await lintPrefixes("1", OFF, ctx({ ...docs, title: "Rewrite the setup guide" }));
    await assert.rejects(
      lintPrefixes(
        "1",
        OFF,
        ctx({ ...docs, commits: [{ parents: [{}], commit: { message: "Rewrite it" } }], title: "x" }),
      ),
      /commit subject lacks a prefix/,
    );
  });

  test("and then the pin stays empty, so settlement re-validates nothing", async () => {
    const pin = { head: "h", baseRef: "main", baseSha: null, title: null };
    await lintPrefixes("1", OFF, ctx({ ...docs, title: "Rewrite the setup guide" }), pin);
    assert.equal(pin.title, null);
  });
});

describe("reading a base branch's tip", () => {
  test("encodes each segment but keeps the separators", async () => {
    const seen = [];
    const spy = {
      token: "t",
      repo: "example/repo",
      fetchImpl: async (url) => {
        seen.push(new URL(url).pathname);
        return { ok: true, status: 200, json: async () => ({ object: { sha: "s" } }), headers: { get: () => "" } };
      },
    };
    // A `#` in a branch name would otherwise truncate the request to a
    // different ref entirely, while the slashes are real separators.
    await baseTip("feature/a#b", spy);
    assert.match(seen[0], /\/git\/ref\/heads\/feature\/a%23b$/);
  });
});

// --- Publishing --------------------------------------------------------
//
// The App-authentication flow (JWT -> installation lookup -> installation
// token -> status POST) is GitHub's own long-stable mechanism, so these
// cover the shape of the calls this file makes, not the platform's own
// contract. `sign` and `fetchImpl` are stubbed throughout except for one
// real RSA round trip, which is what actually proves the JWT this file
// produces is one GitHub would accept.

describe("signing an App JWT", () => {
  test("a real key produces a JWT whose signature actually verifies", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const now = 1_700_000_000;
    const jwt = signAppJwt(123, privateKey, now);
    const [encHeader, encPayload, encSig] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(encHeader, "base64url").toString()), {
      alg: "RS256",
      typ: "JWT",
    });
    // Backdated 60s for clock drift, capped at GitHub's own 10-minute max --
    // both load-bearing: a iat GitHub reads as still in the future is
    // rejected outright, and an exp past 10 minutes is refused too.
    assert.deepEqual(JSON.parse(Buffer.from(encPayload, "base64url").toString()), {
      iat: now - 60,
      exp: now + 600,
      iss: "123", // a number in, a string out -- iss is a claim, not an id
    });
    const verifier = createVerify("RSA-SHA256").update(`${encHeader}.${encPayload}`);
    assert.equal(verifier.verify(publicKey, Buffer.from(encSig, "base64url")), true);
  });

  test("a stubbed signer is what every other test in this section uses", () => {
    const jwt = signAppJwt(1, "unused-key", 1000, () => Buffer.from("sig"));
    assert.equal(jwt.split(".")[2], Buffer.from("sig").toString("base64url"));
  });
});

const stubSign = () => Buffer.from("sig");

/** Records every request made through it, keyed by a substring of the path. */
function appFetchStub({ installation = { id: 42 }, token = "inst-token", statusOk = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: opts.method || "GET", headers: opts.headers, body: opts.body });
    if (/\/installation$/.test(path)) {
      return installation === null
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => installation };
    }
    if (/\/access_tokens$/.test(path)) {
      return token === null
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 201, json: async () => ({ token }) };
    }
    if (/\/statuses\//.test(path)) {
      return statusOk
        ? { ok: true, status: 201, json: async () => ({}) }
        : { ok: false, status: 422, json: async () => ({}) };
    }
    throw new Error(`unstubbed route: ${path}`);
  };
  return { fetchImpl, calls };
}

describe("exchanging the App credential for a token", () => {
  test("installationId reads this repo's installation, authenticated as the App", async () => {
    const { fetchImpl, calls } = appFetchStub();
    assert.equal(await installationId("example/repo", "jwt", fetchImpl), 42);
    assert.equal(calls[0].headers.authorization, "Bearer jwt");
  });

  test("no installation on this repo is refused, not treated as id undefined", async () => {
    const { fetchImpl } = appFetchStub({ installation: null });
    await assert.rejects(installationId("example/repo", "jwt", fetchImpl), /is it installed there/);
  });

  test("installationToken mints a fresh token from the App JWT, never the installation id alone", async () => {
    const { fetchImpl, calls } = appFetchStub();
    assert.equal(await installationToken(42, "jwt", fetchImpl), "inst-token");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.authorization, "Bearer jwt");
  });

  test("a revoked or wrong credential is refused, not returned as an empty token", async () => {
    const { fetchImpl } = appFetchStub({ token: null });
    await assert.rejects(installationToken(42, "jwt", fetchImpl), /App credential may be wrong or revoked/);
  });

  test("appToken chains all three calls end to end", async () => {
    const { fetchImpl } = appFetchStub();
    const token = await appToken({ appId: "1", privateKey: "k", repo: "example/repo" }, fetchImpl, stubSign);
    assert.equal(token, "inst-token");
  });

  test("missing either half of the credential is refused before any request is made", async () => {
    const { fetchImpl, calls } = appFetchStub();
    await assert.rejects(
      appToken({ appId: "", privateKey: "k", repo: "example/repo" }, fetchImpl, stubSign),
      /needs both app-id and app-private-key/,
    );
    await assert.rejects(
      appToken({ appId: "1", privateKey: "", repo: "example/repo" }, fetchImpl, stubSign),
      /needs both app-id and app-private-key/,
    );
    assert.deepEqual(calls, []);
  });
});

describe("the commit a status belongs on", () => {
  test("pull_request and pull_request_target both read the event snapshot's head", () => {
    for (const event of ["pull_request", "pull_request_target"]) {
      assert.equal(statusSha({ event, snapshot: { head: "abc" }, sha: "wrong" }), "abc");
    }
  });

  test("never GITHUB_SHA for either -- under pull_request_target that is the BASE tip", () => {
    assert.throws(
      () => statusSha({ event: "pull_request_target", snapshot: null, sha: "basetip" }),
      /refusing to post a status for an unresolved commit/,
    );
  });

  test("workflow_dispatch (and anything else) uses GITHUB_SHA directly", () => {
    assert.equal(statusSha({ event: "workflow_dispatch", snapshot: null, sha: "dispatched-sha" }), "dispatched-sha");
  });
});

describe("posting the lanes status", () => {
  test("posts the expected state, context, and truncated description", async () => {
    const { fetchImpl, calls } = appFetchStub();
    await publishStatus(
      {
        repo: "example/repo",
        sha: "abc123",
        state: "success",
        description: "x".repeat(200),
        targetUrl: "https://example.com/run/1",
      },
      "inst-token",
      fetchImpl,
    );
    assert.equal(calls[0].path, "/repos/example/repo/statuses/abc123");
    assert.equal(calls[0].headers.authorization, "Bearer inst-token");
    const body = JSON.parse(calls[0].body);
    assert.equal(body.state, "success");
    assert.equal(body.context, "lanes");
    // The Statuses API's own cap; a longer description is rejected outright.
    assert.equal(body.description.length, 140);
    assert.equal(body.target_url, "https://example.com/run/1");
  });

  test("a rejected post is refused, not silently dropped", async () => {
    const { fetchImpl } = appFetchStub({ statusOk: false });
    await assert.rejects(
      publishStatus({ repo: "example/repo", sha: "s", state: "success" }, "t", fetchImpl),
      /Could not post the lanes status/,
    );
  });
});

describe("init mode: publishing pending", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-publish-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 1, head: { sha: "headsha" }, base: { ref: "main", sha: "basesha" } } }));
  const env = {
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "example/repo",
    GITHUB_SHA: "basetip-not-the-pr", // must NOT end up in the posted status
  };

  test("posts pending on the event's own head, not GITHUB_SHA", async () => {
    const { fetchImpl, calls } = appFetchStub();
    await publishPending(env, { appId: "1", privateKey: "k" }, fetchImpl, stubSign);
    const statusCall = calls.find((c) => c.path.includes("/statuses/"));
    assert.equal(statusCall.path, "/repos/example/repo/statuses/headsha");
    assert.equal(JSON.parse(statusCall.body).state, "pending");
  });

  test("an App that cannot authenticate refuses rather than posting nothing silently", async () => {
    const { fetchImpl } = appFetchStub({ installation: null });
    await assert.rejects(publishPending(env, { appId: "1", privateKey: "k" }, fetchImpl, stubSign));
  });
});

describe("gate mode: publishing the terminal result", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-publish-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 1, head: { sha: "headsha" }, base: { ref: "main", sha: "basesha" } } }));
  const env = {
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "example/repo",
  };

  test("no gate error posts success and returns without throwing", async () => {
    const { fetchImpl, calls } = appFetchStub();
    await publishResult(env, null, { appId: "1", privateKey: "k" }, fetchImpl, stubSign);
    const statusCall = calls.find((c) => c.path.includes("/statuses/"));
    const body = JSON.parse(statusCall.body);
    assert.equal(body.state, "success");
  });

  test("a gate error posts failure and is still re-thrown -- the status is additional, not instead", async () => {
    const { fetchImpl, calls } = appFetchStub();
    const err = new PolicyError("heavy jobs did not all succeed");
    await assert.rejects(
      publishResult(env, err, { appId: "1", privateKey: "k" }, fetchImpl, stubSign),
      /heavy jobs did not all succeed/,
    );
    const statusCall = calls.find((c) => c.path.includes("/statuses/"));
    const body = JSON.parse(statusCall.body);
    assert.equal(body.state, "failure");
    assert.equal(body.description, "heavy jobs did not all succeed");
  });

  test("a publish failure is surfaced, never swallowed behind a real gate failure", async () => {
    const { fetchImpl } = appFetchStub({ installation: null });
    const err = new PolicyError("heavy jobs did not all succeed");
    await assert.rejects(
      publishResult(env, err, { appId: "1", privateKey: "k" }, fetchImpl, stubSign),
      /heavy jobs did not all succeed.*additionally, could not publish/s,
    );
  });

  test("a publish failure alone (gate itself passed) is not swallowed either", async () => {
    const { fetchImpl } = appFetchStub({ installation: null });
    await assert.rejects(
      publishResult(env, null, { appId: "1", privateKey: "k" }, fetchImpl, stubSign),
      /is it installed there/,
    );
  });
});