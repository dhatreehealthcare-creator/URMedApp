import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the bounded build runner works without GNU timeout", () => {
  const build = read("../scripts/build-verified.sh");
  assert.doesNotMatch(build, /command -v timeout|GNU timeout|\ntimeout \\/);
  assert.match(build, /run-with-timeout\.mjs/);

  const runner = new URL("../scripts/run-with-timeout.mjs", import.meta.url);
  const success = spawnSync(process.execPath, [runner.pathname, "--timeout", "2s", "--", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);

  const timeout = spawnSync(process.execPath, [runner.pathname, "--timeout", "50ms", "--kill-after", "50ms", "--", process.execPath, "-e", "setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 2_000 });
  assert.equal(timeout.status, 124, timeout.stderr);
  assert.match(timeout.stderr, /exceeded 50ms/);
});

test("production preview uses the packaged Worker with local D1 and R2 bindings", () => {
  const preview = read("../scripts/preview-production.sh");
  const packageJson = JSON.parse(read("../package.json"));
  const vite = read("../vite.config.ts");
  const validator = read("../scripts/validate-artifact.sh");

  assert.equal(packageJson.scripts.start, "bash scripts/preview-production.sh");
  assert.match(preview, /wrangler\.json/);
  assert.match(preview, /d1 migrations apply/);
  assert.match(preview, /--local/);
  assert.match(preview, /--persist-to/);
  assert.doesNotMatch(preview, /vinext start/);
  assert.match(vite, /migrations_dir: "\.\.\/\.openai\/drizzle"/);
  assert.match(validator, /Generated Worker configuration is missing D1 binding/);
  assert.match(validator, /Generated Worker configuration is missing R2 binding/);
});
