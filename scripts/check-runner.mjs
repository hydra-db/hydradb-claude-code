// Run the full source-tree check when its development fixtures are available.
// Published packages omit conformance fixtures and dev dependencies, so verify
// the shipped runtime and query contract without requiring those files.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { normalizeRetrievalResponse } from "./lib/hydra-client.mjs";
import assert from "node:assert/strict";

if (existsSync("scripts/check.mjs") &&
    (!existsSync("scripts/build-vendor.mjs") || existsSync("conformance/runner.mjs") || existsSync("index.js") && existsSync("cordis.patch.yml"))) {
  execFileSync(process.execPath, ["scripts/check.mjs"], { stdio: "inherit" });
} else {
  const result = normalizeRetrievalResponse({ chunks: [{ chunk_content: "runtime check" }] });
  assert.equal(result.chunks[0].text, "runtime check");
  console.log("ok - shipped runtime check (development fixtures unavailable)");
}
