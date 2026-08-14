import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const checks = [
  { id: "A", name: "Hosted D1/R2 backup, retention, encryption, restore, disaster recovery", status: "EXTERNAL DEPENDENCY", evidence: ["docs/BACKUP_RESTORE_AND_RECOVERY.md", "scripts/backup-local.mjs", "scripts/restore-verify.mjs"] },
  { id: "B", name: "Cloudflare-scale performance and hosted observability", status: "EXTERNAL DEPENDENCY", evidence: ["scripts/benchmark-report-plans.mjs", "docs/ACCOUNTING_REPORT_PERFORMANCE_REVIEW.md", "docs/OPERATIONAL_MONITORING_AND_RELEASE_GATES.md"] },
  { id: "C", name: "Accountant approval of policy 2026-08-14.v1", status: "BLOCKED", evidence: ["docs/ACCOUNTING_RECOGNITION_AND_CLOSING_POLICY.md"] },
  { id: "D", name: "Real bank-feed ingestion and reconciliation", status: "EXTERNAL DEPENDENCY", evidence: ["app/api/vendor/inventory-reconciliation/route.ts", "docs/ACCOUNTING_RECOGNITION_AND_CLOSING_POLICY.md"] },
  { id: "E", name: "Supabase/Twilio/Resend/Razorpay/R2 provider UAT", status: "EXTERNAL DEPENDENCY", evidence: ["docs/PRODUCTION_PROVIDER_AND_RELEASE_CONFIGURATION.md"] },
  { id: "F", name: "Browser, accessibility, privacy, rollback, and production deployment testing", status: "NOT STARTED", evidence: ["docs/PRODUCTION_PROVIDER_AND_RELEASE_CONFIGURATION.md", "docs/ACCOUNTING_REPORT_PERFORMANCE_REVIEW.md"] },
];

const report = {
  generatedAt: new Date().toISOString(),
  hostedAccessUsed: false,
  productionSecretsRead: false,
  deploymentAttempted: false,
  gates: checks.map((check) => ({ ...check, evidencePresent: check.evidence.filter((file) => existsSync(join(root, file))), evidenceMissing: check.evidence.filter((file) => !existsSync(join(root, file))) })),
  localCommands: ["npm run backup:local", "npm run restore:verify", "npm run benchmark:reports", "npm run test:unit", "npm run test:integration:built", "npm run build", "npm run validate:artifact"],
};

if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log("URMED local release-gate evidence");
  console.log("Hosted access: not used | Production secrets: not read | Deployment: not attempted");
  for (const gate of report.gates) console.log(`${gate.id}. ${gate.status.padEnd(22)} ${gate.name} (evidence ${gate.evidencePresent.length}/${gate.evidence.length})`);
}

if (process.argv.includes("--strict") && report.gates.some((gate) => gate.status !== "VERIFIED LOCALLY" && gate.status !== "VERIFIED IN AUTHORIZED NON-PRODUCTION")) process.exitCode = 2;
