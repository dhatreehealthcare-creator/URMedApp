# Local backup, restore, and recovery contract

This contract is deliberately provider-independent. It verifies a local D1 SQLite
snapshot and a local R2 persistence directory without contacting Cloudflare or any
hosted service. It is recovery evidence for development and release rehearsal, not
a claim that hosted D1/R2 backup policy has been configured.

## Commands

```sh
npm run backup:local -- \
  --d1 /explicit/path/to/local.sqlite \
  --r2 /explicit/path/to/local-r2-state \
  --out /explicit/path/to/new-backup \
  --timestamp 2026-08-14T12:00:00.000Z

npm run restore:verify -- \
  --backup /explicit/path/to/new-backup \
  --out /explicit/path/to/new-restore
```

All paths are explicit. The backup command refuses a non-empty output directory,
symlinks, missing inputs, and an output nested inside an input. The restore command
uses a staging directory and only publishes `restored/` after checksum, SQLite
integrity, foreign-key, schema, migration-catalog, and tenant-integrity checks pass.

## Format and integrity

Each backup contains:

- `d1.sqlite`: a consistent `VACUUM INTO` snapshot of the supplied local D1 file;
- `r2/`: copied local R2 persistence files, including internal metadata and binary
  object payloads;
- `manifest.json`: format/version, timestamp, migration catalog hash, sorted file
  records, byte sizes, SHA-256 hashes, object count, table counts, and evidence
  counts;
- `backup-report.json`: non-sensitive creation and validation evidence.

The manifest's `contentSha256` is calculated from the sorted artifact records, so a
fixed source state and fixed timestamp produce a reproducible content/checksum
result. Runtime secrets and environment variables are never read or serialized.
Binary objects and string identifiers are copied without numeric coercion, so
leading zeros are preserved.

Restore writes `recovery-report.json` with migration, checksum, schema, tenant,
invoice, payment, inventory, prescription, quarantine, audit, and email-outbox
evidence. A failed restore publishes only a sanitized failure report and never a
partially trusted restored dataset. Repeating a verified restore with the same
content checksum is idempotent.

## Retention and hosted limitations

Retention is caller-managed; the local tool does not delete backups or upload them.
Before production, Cloudflare D1 backup/restore, R2 versioning/lifecycle,
encryption/key rotation, access controls, backup retention, restore authorization,
and disaster-recovery objectives require an approved hosted-provider run. No hosted
resources, production secrets, or deployment configuration are used by these tools.

