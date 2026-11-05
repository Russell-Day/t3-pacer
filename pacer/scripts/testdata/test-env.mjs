// Imported first by the unit tests, before pacer.mjs reads its settings: a throwaway state dir
// (the real ~/.local/state/pacer is never read or written) and a fixed zone. The pacer's default
// zone is the system zone, so the tests pin the process zone to America/Toronto.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TZ = "America/Toronto";
process.env.PACER_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pacer-test-"));
process.env.PACER_T3_RUNTIME_DIR ??= path.join(process.env.PACER_STATE_DIR, "no-t3-runtime");
