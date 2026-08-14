import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runBenchmark(sizes) {
  const directory = mkdtempSync(join(tmpdir(), "urmed-report-benchmark-"));
  const output = join(directory, "report-performance.json");
  try {
    execFileSync(process.execPath, ["scripts/benchmark-report-plans.mjs", "--sizes", sizes], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, URMED_REPORT_BENCHMARK_OUTPUT: output },
      stdio: "ignore",
      maxBuffer: 2_000_000,
    });
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("report benchmark captures tenant-scoped plans, totals, pagination, and export bounds", () => {
  const result = runBenchmark("10000");
  assert.equal(result.methodology.tenantId, 2);
  assert.equal(result.methodology.exportCap, 5000);
  assert.equal(result.methodology.deliveryCandidateCap, 100001);
  for (const report of Object.values(result.scales["10000"].reports)) {
    assert.equal(report.tenantId, 2);
    assert.ok(report.page1.rows <= 100);
    assert.ok(report.total.rows >= report.page1.rows);
    assert.ok(report.plan.some((detail) => /USING (?:COVERING )?INDEX/i.test(detail)), report.plan.join(" | "));
    assert.equal(report.risks.fullScan, false, report.plan.join(" | "));
  }
  const delivery = result.scales["10000"].reports.homeDelivery;
  assert.equal(delivery.candidateBound.privacySafeColumns, true);
  assert.equal(delivery.candidateBound.overflow, false);
});

test("home-delivery benchmark proves rows beyond the former 5,000 candidate boundary are retained", () => {
  const result = runBenchmark("100000");
  const delivery = result.scales["100000"].reports.homeDelivery;
  assert.equal(delivery.candidateBound.candidateRows, 12500);
  assert.ok(delivery.candidateBound.postFilterRows > 5000);
  assert.ok(delivery.candidateBound.postFilterRows < delivery.candidateBound.candidateRows);
  assert.equal(delivery.candidateBound.overflow, false);
  assert.equal(delivery.page100.rows, 100);
  assert.equal(delivery.risks.fullScan, false);
  assert.match(delivery.plan.join(" | "), /orders_vendor_delivery_date_idx/);
});

test("report source preserves the documented synchronous export contract", () => {
  const source = readFileSync(new URL("../lib/admin-reporting.ts", import.meta.url), "utf8");
  assert.match(source, /REPORT_EXPORT_MAX_ROWS\s*=\s*5[,_]?000/);
  assert.match(source, /exportMode && total > REPORT_EXPORT_MAX_ROWS/);
  assert.match(source, /const REPORT_QUERY_MAX_ROWS\s*=\s*100[,_]?000/);
  assert.match(source, /activityAt >= \? AND activityAt < \?/);
  assert.doesNotMatch(source, /date\(o\.created_at\) BETWEEN/);
});
