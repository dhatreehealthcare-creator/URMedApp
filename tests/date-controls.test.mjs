import test from "node:test";
import assert from "node:assert/strict";
import { isStrictIsoDate, requireIsoDate } from "../lib/date-controls.ts";
import { errorResponse } from "../lib/api-errors.ts";

test("strict dates reject calendar rollovers and malformed values", () => {
  assert.equal(isStrictIsoDate("2028-02-29"), true);
  assert.equal(isStrictIsoDate("2026-02-29"), false);
  assert.equal(isStrictIsoDate("2026-02-30"), false);
  assert.equal(isStrictIsoDate("2026-13-01"), false);
  assert.equal(isStrictIsoDate("26-08-11"), false);
  assert.equal(requireIsoDate("2026-08-11", "Date"), "2026-08-11");
  assert.equal(requireIsoDate("", "Date", true), null);
});

test("API authorization errors are returned as JSON", async () => {
  const response = await errorResponse(new Response("Authentication required", { status: 401 }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});

test("database internals are not exposed in API errors", async () => {
  const response = await errorResponse(new Error("D1_ERROR: SQLITE constraint failed at private_table"));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "The requested operation could not be completed safely" });
});
