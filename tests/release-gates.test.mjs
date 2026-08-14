import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("local release-gate checker is provider-independent and conservative", () => {
  const output = execFileSync(process.execPath, ["scripts/release-gates-local.mjs", "--json"], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.hostedAccessUsed, false);
  assert.equal(report.productionSecretsRead, false);
  assert.equal(report.deploymentAttempted, false);
  assert.equal(report.gates.length, 6);
  assert.ok(report.gates.some((gate) => gate.status === "BLOCKED"));
  assert.ok(report.gates.some((gate) => gate.status === "EXTERNAL DEPENDENCY"));
});
