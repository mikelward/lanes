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

import { readPolicy, parsePolicy, isDocs, hasPrefix, POLICY_PATH } from "./lanes.mjs";

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

describe("this repository's own lane", () => {
  // ci.yml rides the engine on itself -- SPEC.md records why, and these pins
  // hold the two properties the reasoning stands on: the engine judging a
  // branch is the MERGED one, and the skippable job can only be skipped on
  // the classify verdict the gate independently re-derives.
  const workflow = read("ci.yml");

  // A job's content sits at 4+ spaces of indent; capture stops at the next
  // line shallower than that, so a following job key or a 2-space comment
  // between jobs ends the block.
  const jobBlock = (name) => {
    const m = workflow.match(new RegExp(`\\n {2}${name}:\\n((?: {4,}.*\\n| *\\n)*)`));
    return m ? m[1] : "";
  };

  test("classify and the gate run the merged engine; only test runs the branch's copy", () => {
    // In the lane jobs, `uses: ./` would let a pull request rewrite the
    // engine and be judged by its own rewrite -- the self-blessing hole
    // SPEC.md names. `@main` is deliberate for the same reason it is in
    // every consumer: there is no release step, so main IS the release.
    // Inside the test job the branch's own copy is the point -- the
    // integration step loads the branch's manifest, and nothing gates on
    // its output; its exit status feeds the test job's result, which the
    // @main gate assesses.
    const jobs = { classify: jobBlock("classify"), test: jobBlock("test"), lanes: jobBlock("lanes") };
    for (const [name, block] of Object.entries(jobs)) {
      assert.ok(block.length > 0, `the ${name} job block was found`);
    }
    for (const name of ["classify", "lanes"]) {
      assert.match(jobs[name], /uses: mikelward\/lanes@main/, `${name} runs the merged engine`);
      assert.doesNotMatch(jobs[name], /uses: \.\//, `${name} must not run the branch's own copy`);
    }
    assert.match(jobs.test, /uses: \.\//, "the test job exercises the branch's own manifest");
    assert.doesNotMatch(jobs.test, /uses: mikelward\/lanes@main/);
  });

  test("the required check is the always-reporting gate, named lanes", () => {
    // `if: always()` is what makes `lanes` safe to require: without it the
    // gate is skipped whenever classify or test is, and GitHub counts a
    // skipped required check as satisfied.
    assert.match(workflow, /\n {2}lanes:\n {4}name: lanes\n/);
    assert.match(workflow, /\n {4}needs: \[classify, test\]\n {4}if: always\(\)\n/);
    assert.match(workflow, /mode: gate/);
    assert.match(workflow, /results: >-\n {12}test=\$\{\{ needs\.test\.result \}\}/);
  });

  test("the suite runs unconditionally until the ruleset requires lanes", () => {
    // Deliberately staged: while the ruleset still requires `test`, a
    // skipped `test` counts as satisfied with nothing re-verifying the
    // skip -- so the docs-only skip lands only after the flip to requiring
    // `lanes`. TODO.md holds the sequence; this pin flips with it, to
    // `if: needs.classify.outputs.docs_only != 'true'` on the test job.
    assert.match(workflow, /mode: classify/);
    assert.doesNotMatch(workflow, /needs\.classify\.outputs\.docs_only/);
  });

  test("the actual policy classifies both directions under the real engine", () => {
    // lanes.test.mjs exercises the engine against inline fixture policies;
    // this is the one place the repository's own .github/lanes.conf meets
    // the real parser and matcher, so a mistaken glob or prefix there
    // cannot ride a green suite. Parse first, and prove it found
    // something -- an empty rule list would classify everything as code
    // and leave the docs-direction assertions below vacuously wrong.
    const policy = parsePolicy(readPolicy(fileURLToPath(new URL("./", import.meta.url))));
    assert.ok(policy.rules.length > 0, "the policy parse found rules");
    assert.ok(policy.prefixes.length > 0, "the policy parse found prefixes");
    for (const path of ["README.md", "SPEC.md", "AGENTS.md", "TODO.md", "docs/notes.md"]) {
      assert.equal(isDocs(path, policy.rules), true, `${path} rides the docs lane`);
    }
    // The code direction includes the engine, the manifest, the workflows,
    // a non-markdown prose file, and the policy file itself, which the
    // engine hard-codes as code whatever the policy says.
    for (const path of ["lanes.mjs", "action.yml", ".github/workflows/ci.yml", "LICENSE", POLICY_PATH]) {
      assert.equal(isDocs(path, policy.rules), false, `${path} rides the code lane`);
    }
    assert.equal(hasPrefix("docs: clarify the README", policy.prefixes), true);
    for (const subject of ["test: add a case", "build: bump node", "Docs cleanup"]) {
      assert.equal(hasPrefix(subject, policy.prefixes), false, `'${subject}' is not a docs subject`);
    }
    assert.equal(policy.dispatchWithoutPr.mode, "refuse");
  });

  test("re-runs on retarget, and holds read-only permissions", () => {
    // `edited` is load-bearing: a retarget changes the measured diff while
    // the head -- and any `lanes` check already minted on it -- stays put.
    assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/);
    assert.match(workflow, /\npermissions:\n {2}contents: read\n {2}pull-requests: read\n/);
    assert.doesNotMatch(workflow, /: write/);
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

  // Both publisher jobs in this snippet were caught missing `runs-on` and
  // `environment:` on the first pass -- a workflow GitHub rejects outright,
  // and a secret invisible to the job that reads it, respectively, neither
  // of them an error a copy-paster would see coming. Pinned so a future edit
  // to this example cannot lose either one silently.
  const trustedPublishing = readme.slice(
    readme.indexOf("### Trusted publishing"),
    readme.indexOf("### Renaming an existing consumer's check"),
  );

  test("the trusted-publishing example exists and both jobs can actually run", () => {
    assert.notEqual(trustedPublishing.indexOf("### Trusted publishing"), -1, "Trusted publishing section not found");
    assert.match(trustedPublishing, /\n {2}init:\n {4}runs-on: ubuntu-latest\n/);
    assert.match(trustedPublishing, /\n {2}finalize:\n {4}runs-on: ubuntu-latest\n/);
  });

  test("the finalizer is named finalize, never lanes -- that name belongs to the App's status", () => {
    // A job's own check-run and a commit status can share a display name
    // without this repository having verified how a ruleset disambiguates
    // them by source; the finalizer is named apart from `lanes` so nothing
    // here depends on that being resolved correctly.
    assert.doesNotMatch(trustedPublishing, /\n {2}lanes:\n/);
  });

  test("never instructs requiring init or finalize's own check-run", () => {
    // A tempting-looking fix, and wrong: under pull_request_target GitHub
    // attributes a job's ambient check-run to GITHUB_SHA, which is the BASE
    // branch's tip -- so requiring either job by name would leave the pull
    // request's own head waiting forever for a check that only ever reports
    // on main, blocking every merge through this pattern rather than
    // protecting it. This was tried and reverted; pinned so it is not
    // tried again the same way.
    assert.doesNotMatch(trustedPublishing, /[Rr]equire `init`/);
    assert.doesNotMatch(trustedPublishing, /[Rr]equire `finalize`/);
  });

  test("names the stale-status gap as open rather than claiming a fix that doesn't exist", () => {
    assert.match(trustedPublishing, /genuinely open, not solved/);
  });

  test("the trusted-publishing example attaches BOTH jobs to the restricted environment", () => {
    // Not "a" job -- an environment-scoped secret is invisible to any job
    // that doesn't itself declare `environment:`, so a consumer's App
    // credential silently resolves empty on whichever job the example
    // forgot, exactly the shape of the finding this test pins.
    const jobBlocks = trustedPublishing.split(/\n {2}(?=init:|finalize:)/).slice(1);
    assert.equal(jobBlocks.length, 2, "expected exactly the init and finalize job blocks");
    for (const block of jobBlocks) {
      assert.match(block, /\n {4}environment: lanes\n/, `job block missing environment::\n${block}`);
    }
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

  test("runs on every pull request and push to main, with no paths filter", () => {
    // `zizmor` is in the ruleset's required set (piloting the fleet
    // decision), and a required check must report on every pull request's
    // head: a workflow filtered out by `paths:` creates NO check run at
    // all -- unlike a skipped job, which reports "skipped" and satisfies
    // the ruleset -- so a filter here would leave any PR not touching the
    // filtered paths unmergeable behind a check nothing reports. Matched
    // as one contiguous block so a `paths:` line can't survive attached
    // to either trigger.
    // The block must run straight from `on:` into `permissions:`, so
    // `pull_request:` provably carries NO nested configuration -- not just
    // no `paths:`: a `types:` filter under it would equally stop the check
    // reporting on opened or synchronized heads.
    assert.match(workflowRun, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\npermissions:\n/m);
    assert.doesNotMatch(workflowRun, /paths:/);
  });

  test("holds the pin-policy table exact", () => {
    // `@main` is the release for mikelward/codex-review, this repository's
    // one sibling action, and for this repository's own action, which ci.yml
    // runs on itself at `@main` deliberately (see SPEC.md); official actions
    // may pin tags; the blanket hash-pin rule has to be restated because
    // supplying policies replaces zizmor's defaults. Compared whole: an
    // entry added, dropped, or widened (say, mikelward/*) fails here,
    // whichever shape it takes.
    assert.deepStrictEqual(policyEntries(policyRules), [
      "mikelward/codex-review: ref-pin",
      "mikelward/codex-review/.github/workflows/check-consumer.yml: ref-pin",
      "mikelward/lanes: ref-pin",
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
