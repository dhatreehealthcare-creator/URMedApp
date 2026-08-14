import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enforceRateLimit } from "../lib/abuse-controls.ts";

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
  async first() { const row = this.database.prepare(this.sql).get(...this.values); return row ? { ...row } : null; }
}
class D1 { constructor(database) { this.database = database; } prepare(sql) { return new Statement(this.database, sql); } }

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE abuse_rate_limit_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, route_key TEXT NOT NULL, subject_hash TEXT NOT NULL,
    window_start_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, request_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(route_key,subject_hash,window_start_ms)
  )`);
  return { sqlite, d1: new D1(sqlite) };
}

test("durable limiter enforces endpoint policy and returns retry metadata", async (t) => {
  const { sqlite, d1 } = fixture(); t.after(() => sqlite.close());
  const request = new Request("https://urmed.test/api/search", { headers: { "cf-connecting-ip": "198.51.100.10" } });
  for (let index = 0; index < 12; index += 1) assert.equal(await enforceRateLimit(request, "auth", { profileId: 7, nowMs: 1_000, database: d1 }), null);
  const limited = await enforceRateLimit(request, "auth", { profileId: 7, nowMs: 1_000, database: d1 });
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("cache-control"), "no-store");
  assert.equal(limited?.headers.get("retry-after"), "59");
  assert.equal((await limited?.json()).code, "rate_limited");
  assert.equal(await enforceRateLimit(request, "auth", { profileId: 7, nowMs: 61_000, database: d1 }), null);
});

test("limiter keys isolate profiles and does not persist raw IP addresses", async (t) => {
  const { sqlite, d1 } = fixture(); t.after(() => sqlite.close());
  const request = new Request("https://urmed.test/api/search", { headers: { "cf-connecting-ip": "203.0.113.44" } });
  await enforceRateLimit(request, "upload", { profileId: 1, nowMs: 1_000, database: d1 });
  await enforceRateLimit(request, "upload", { profileId: 2, nowMs: 1_000, database: d1 });
  const row = sqlite.prepare("SELECT subject_hash FROM abuse_rate_limit_buckets LIMIT 1").get();
  assert.equal(String(row.subject_hash).length, 64);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM abuse_rate_limit_buckets WHERE subject_hash LIKE '%203.0.113.44%'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM abuse_rate_limit_buckets").get().count, 2);
});

test("high-cost routes apply abuse controls before body/provider work", () => {
  const checks = [
    ["app/api/documents/route.ts", "enforceRateLimit(request, \"upload\""],
    ["app/api/payments/razorpay/order/route.ts", "enforceRateLimit(request, \"payment\""],
    ["app/api/payments/razorpay/verify/route.ts", "enforceRateLimit(request, \"payment\""],
    ["app/api/payments/razorpay/refund/route.ts", "enforceRateLimit(request, \"payment\""],
    ["app/api/webhooks/razorpay/route.ts", "enforceRateLimit(request, \"webhook\""],
    ["app/api/delivery/route.ts", "enforceRateLimit(request, \"gps\""],
    ["app/api/catalog/route.ts", "enforceRateLimit(request, \"public_search\""],
    ["app/api/inventory/route.ts", "enforceRateLimit(request, \"public_search\""],
  ];
  for (const [file, expression] of checks) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), new RegExp(expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const webhook = readFileSync(new URL("../app/api/webhooks/razorpay/route.ts", import.meta.url), "utf8");
  assert.ok(webhook.indexOf('const raw = await readBoundedRequestText') < webhook.indexOf('const limited = await enforceRateLimit(request, "webhook"'));
});
