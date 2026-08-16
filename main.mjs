// What `action.yml` runs. It exists to hold the one line that must not be
// conditional.
//
// This used to be an `import.meta.url === \`file://${process.argv[1]}\``
// guard at the foot of `lanes.mjs` — a URL compared against a path. A
// checkout under a directory containing a space or a `#` percent-encodes on
// the URL side only, so the comparison goes false, `main()` is never called,
// and the process exits 0 with the gate reporting green on a diff it never
// read. A guard whose failure mode is silent success is worse than no guard,
// and this file is what makes there be no guard: `lanes.mjs` defines and
// exports, this invokes.

import { main } from "./lanes.mjs";

main().catch((err) => {
  // `::error::` renders on the job's summary; a non-zero exit is what the
  // required check reads.
  process.stdout.write(`::error::${err.message}\n`);
  process.exit(1);
});
