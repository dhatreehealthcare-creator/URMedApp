import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("reminder and e-invoice settings use typed Worker runtime bindings", async () => {
  const [runtime, worker, reminders, operations] = await Promise.all([
    readFile(new URL("../lib/runtime-env.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/reminders/process/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/operations/route.ts", import.meta.url), "utf8"),
  ]);
  for (const key of ["REMINDER_JOB_SECRET", "EINVOICE_API_URL", "EINVOICE_API_KEY"]) {
    assert.match(runtime, new RegExp(`${key}\\?: string`));
    assert.match(worker, new RegExp(`${key}: env\\.${key}`));
  }
  assert.match(reminders, /getRuntimeEnv\(\)\.REMINDER_JOB_SECRET/);
  assert.doesNotMatch(reminders, /process\.env/);
  assert.match(operations, /const runtime=getRuntimeEnv\(\)/);
  assert.doesNotMatch(operations, /process\.env/);
});
