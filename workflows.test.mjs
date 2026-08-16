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
