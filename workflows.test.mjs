// Tests for this repository's own workflows.
//
// The sweep's logic and its tests live in mikelward/codex-review; the lane
// engine's live in lanes.test.mjs. What is pinned here is the part that stays
// in a repository: which events may run a status-writing job, and what token
// it holds. Every one of these guards a value whose wrong setting produces no
// error at all — just a gate that quietly stops doing its job.
//
// Read as regexes over YAML, which is an approximation of YAML and known to
// be. It is worth it because the alternative is a dependency, and this
// repository has none by design; the risk is bounded by these being pins on
// exact strings that a human wrote and a human will edit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./.github/workflows/", import.meta.url));
const read = (name) => readFileSync(`${dir}${name}`, "utf8");

describe("the codex-review workflow", () => {
  const workflow = read("codex-review.yml");
  const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));

  test("runs the shared action unpinned, and checks nothing out", () => {
    // `@main` is deliberate: the action has no build step and no
    // dependencies, so the file that runs is the file you can read, and a pin
    // would only delay gate fixes reaching consumers. No checkout, also
    // deliberate: the sweep needs nothing from this tree, and a checkout puts
    // a token-bearing .git/config within reach of a status-writing job.
    assert.match(workflow, /uses: mikelward\/codex-review@main/);
    assert.doesNotMatch(workflow, /actions\/checkout/);
  });

  test("starts on every event that can change the verdict", () => {
    assert.match(on, /pull_request_target:/);
    // `edited` is load-bearing here: a retarget changes the reviewed diff
    // without moving the head SHA, and GitHub emits `edited` rather than
    // `synchronize` for it, so the existing `codex: success` would stand over
    // a diff nothing had read.
    assert.match(on, /types: \[opened, reopened, ready_for_review, synchronize, edited, closed\]/);
    assert.equal(on.match(/types: \[created, edited\]/g)?.length, 2, "both comment events");
    // Both halves of the relay, by name: renaming one without the other
    // severs it silently, and the review-only verdict goes unheard.
    assert.match(on, /workflow_run:\n\s+workflows: \[codex-review-listener\]\n\s+types: \[completed\]/);
    const listener = read("codex-review-listener.yml");
    assert.match(listener, /^name: codex-review-listener$/m);
    assert.match(listener, /pull_request_review:\n\s+types: \[submitted, edited, dismissed\]/);
    assert.match(listener, /^permissions: \{\}$/m);
  });

  test("starts on no event that lets a branch supply its own sweep", () => {
    // `workflow_dispatch` takes a ref and runs the file FROM that ref; a bare
    // `pull_request` has the same hole via the merge ref; and
    // `pull_request_review` is merge-ref too, which is why it lives on the
    // unprivileged listener instead.
    assert.doesNotMatch(on, /workflow_dispatch/);
    assert.doesNotMatch(on, /\bpull_request:/);
    assert.doesNotMatch(on, /\bpull_request_review:/);
  });

  test("keeps the backstop schedule hourly, off the hour", () => {
    assert.match(workflow, /cron:\s*'23 \* \* \* \*'/);
  });

  test("holds the loop envelope: one queued successor, bounded runner", () => {
    // A canceled loop is a gate that stopped sweeping mid-review; 65 minutes
    // caps a hung API call ten past the action's own 55-minute loop.
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /timeout-minutes: 65/);
  });

  test("keeps the job name, which is not a required check", () => {
    // Pinned so the header's reasoning keeps naming a job that exists --
    // NOT because a ruleset requires it. Requiring `sweep` is unsafe: a
    // concurrency group holds one pending run, so a head-associated run
    // queued behind a 55-minute sweep is canceled by the next trigger, and
    // the replacement reports against the default branch. The head is then
    // left with a canceled or absent required check and no way to clear it.
    assert.match(workflow, /^jobs:\n  sweep:$/m);
    assert.match(workflow, /DO NOT REQUIRE `sweep`/);
  });

  test("is the only workflow here that can write commit statuses", () => {
    // A commit status belongs to the SHA, so a second writer is an unordered
    // write: one delayed past this run's exit overwrites a fresh verdict with
    // a stale one, and nothing reports that it happened. This scan goes red
    // the moment any other workflow acquires the scope.
    const files = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
    assert.ok(files.length > 1, "the scan must have something to scan");
    for (const name of files) {
      const text = read(name);
      if (name === "codex-review.yml") assert.match(text, /statuses: write/);
      else assert.doesNotMatch(text, /statuses:\s*write/, `${name} must not hold statuses: write`);
    }
  });
});

describe("the README's consumer template", () => {
  // Guards the branch-protection contract's own name, which nothing else
  // here pins: a documentation edit that quietly restored the old "gate"
  // example would be a false pass without this, since lanes.test.mjs only
  // exercises the engine and workflows.test.mjs only this repository's own
  // workflows -- neither reads what a consumer is told to name their check.
  const readme = readFileSync(fileURLToPath(new URL("./README.md", import.meta.url)), "utf8");
  const usage = readme.slice(
    readme.indexOf("### 2. The jobs"),
    readme.indexOf("### Renaming an existing consumer's check"),
  );

  test("the required-check job in the template is named lanes, not gate", () => {
    assert.notEqual(usage.indexOf("### 2. The jobs"), -1, "Usage section not found");
    assert.match(usage, /\n {2}lanes:\n {4}name: lanes\n/);
    assert.doesNotMatch(usage, /\n {2}gate:\n {4}name: gate\n/);
  });

  test("instructs requiring lanes, not gate, in the ruleset", () => {
    assert.match(usage, /Then require \*\*`lanes`\*\* — and only `lanes` —/);
    assert.doesNotMatch(usage, /Then require \*\*`gate`\*\*/);
  });
});

describe("the zizmor workflow", () => {
  // Ported from mikelward/codex-review's own zizmor.test.js. The scan's
  // failure modes are all silent: a dropped version pin floats the audit
  // set, a dropped --offline puts the GitHub API inside the scan, a widened
  // policy exempts a ref nobody decided to exempt, a narrowed path filter
  // stops re-running the scan on the files it audits. Read with regexes over
  // YAML like the rest of this suite -- this repository ships no YAML parser
  // on purpose.
  const workflow = read("zizmor.yml");
  const policy = readFileSync(fileURLToPath(new URL("./.github/zizmor.yml", import.meta.url)), "utf8");

  const stripComments = (text) =>
    text
      .split("\n")
      // Full-comment lines are dropped BEFORE the inline-comment strip below
      // -- stripping first would leave them as blank lines (the
      // leading-whitespace branch of the inline regex still matches a bare
      // "# ..." line), which then survive this filter since an empty string
      // never starts with "#". A blank line breaks any check that expects
      // two keys to sit on immediately adjacent lines.
      .filter((line) => !line.trimStart().startsWith("#"))
      .map((line) => line.replace(/\s+#.*$/, ""))
      .join("\n");

  // Comments stripped first, so a `# run: pipx run …` note or a step
  // disabled by commenting out its `run:` line can't satisfy these checks —
  // they anchor to the executable `run:` field and the live `paths:` line,
  // not to matching text appearing anywhere in the file.
  const workflowRun = stripComments(workflow);
  const policyRules = stripComments(policy);

  // Anchored through the full mapping chain including the top-level
  // `rules:` key, not just the leaf `policies:` — renaming or moving
  // anything from `rules` down to `policies` must fall through to zero
  // entries, not silently match whatever happens to sit at the right
  // indentation elsewhere in the file. Bounded to consecutive
  // 8-space-indented lines so a dedent out of `policies` also stops the
  // capture -- nothing past the mapping's own indentation can be swept in.
  // This is as deep as the anchor chases: further structural mutations
  // would need a real YAML parser, which this file's header already
  // accepts as a deliberate tradeoff.
  const policiesBlock = (text) => {
    const m = text.match(/^rules:\n {2}unpinned-uses:\n {4}config:\n {6}policies:\n((?: {8}.*\n?)*)/);
    return m ? m[1] : "";
  };

  const policyEntries = (text) =>
    [...policiesBlock(text).matchAll(/^ {8}"?([^":\n]+?)"?: *(\S+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);

  test("pins the zizmor version exactly and scans offline", () => {
    assert.match(workflowRun, /^\s*run: pipx run --spec zizmor==\d+\.\d+\.\d+ zizmor /m);
    const runs = [...workflowRun.matchAll(/^\s*run: (pipx run [^\n]+)$/gm)];
    assert.strictEqual(runs.length, 1);
    assert.match(runs[0][1], / --offline /);
  });

  test("holds read-only permissions, once", () => {
    assert.match(workflow, /\npermissions:\n {2}contents: read\njobs:/);
    assert.strictEqual([...workflow.matchAll(/^ *permissions:/gm)].length, 1);
  });

  test("re-runs when anything it scans changes", () => {
    // Unlike a consumer repo's copy of this workflow, this repository IS an
    // action -- zizmor discovers action metadata recursively from the
    // repository root, so the filter has to cover a nested action.yml (or
    // .yaml) too, not just the one at the root, or a PR touching only a
    // nested one never re-runs the scan. Matched as one contiguous block by
    // construction, not by scanning for any `paths:` occurrence -- renaming
    // `pull_request:` to another trigger (or reordering the block) breaks
    // this exact-structure match, so a `paths:` line can't survive attached
    // to the wrong trigger.
    assert.match(
      workflowRun,
      /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths: \['\.github\/\*\*', '\*\*\/action\.yml', '\*\*\/action\.yaml'\]\n {2}pull_request:\n {4}paths: \['\.github\/\*\*', '\*\*\/action\.yml', '\*\*\/action\.yaml'\]\n/m,
    );
  });

  test("holds the pin-policy table exact", () => {
    // `@main` is the release for mikelward/codex-review, this repository's
    // one sibling action; official actions may pin tags; the blanket
    // hash-pin rule has to be restated because supplying policies replaces
    // zizmor's defaults. Compared whole: an entry added, dropped, or
    // widened (say, mikelward/*) fails here, whichever shape it takes.
    assert.deepStrictEqual(policyEntries(policyRules), [
      "mikelward/codex-review: ref-pin",
      "mikelward/codex-review/.github/workflows/check-consumer.yml: ref-pin",
      "actions/*: ref-pin",
      "*: hash-pin",
    ]);
  });

  test("excuses this repository's own privileged triggers, nothing else", () => {
    // codex-review.yml and codex-review-check.yml both carry
    // pull_request_target deliberately and check nothing out. Compared
    // whole, so a new workflow reaching for pull_request_target is still
    // flagged. Anchored through the full mapping chain, not just the leaf
    // `ignore:` key — a rename or move of `dangerous-triggers` or `ignore`
    // must fall through to zero, not match a list-item anywhere in the file.
    // Bounded to consecutive 6-space-indented lines, for the same reason
    // the policies extraction above stops at a dedent.
    const m = policyRules.match(/^rules:\n[\s\S]*? {2}dangerous-triggers:\n {4}ignore:\n((?: {6}.*\n?)*)/);
    const ignored = m ? [...m[1].matchAll(/^ +- (\S+)$/gm)].map((mm) => mm[1]) : [];
    assert.deepStrictEqual(ignored, ["codex-review.yml", "codex-review-check.yml"]);
  });
});
