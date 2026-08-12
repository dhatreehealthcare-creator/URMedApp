# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- macOS or Linux with Bash for the build and local production preview
- Linux with `flock`, `curl`, `sha256sum`, and GNU `timeout` only when using the Sites-specific `npm run install:ci` helper

## Sites Lifecycle

The Sites lifecycle CLI runs the locked dependency install before returning this checkout. Edit the source under `app/`, then checkpoint when a coherent milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit. Do not repeat install or build as a normal pre-checkpoint step.

This starter does not use `wrangler.jsonc`.

`install:ci` is intentionally a single, non-retrying `npm ci`. It refuses a concurrent install for the same project, consumes a matching image-seeded npm cache with `--prefer-offline` while retaining registry fallback for a missing cache object, otherwise downloads and verifies the complete vinext tarball recorded in `package-lock.json`, limits npm to one socket, and terminates a stalled install. That CI install helper remains Linux-specific. `build` uses a portable Node timeout runner and validates the generated Worker configuration and Sites artifact, so the same build command works on macOS and Linux without installing GNU `timeout`.

Scripts that need writable project-scoped home, npm, XDG, and temporary paths use `scripts/sites-env.sh`. Development and preview forward application environment values while keeping Wrangler logs and local binding state inside the checkout. The generated `.sites-runtime/` directory is disposable and ignored by Git.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Diagnostic Commands

- `npm run install:ci`: perform the one bounded lockfile install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build and validate the deployable Sites artifact
- `npm run start`: start a binding-aware production preview of the built Worker (also available as `npm run preview`)
- `npm run test:unit`: run the fast unit/regression suite only
- `npm run test:integration`: build, then run the isolated D1/R2 API integration suite
- `npm run test:integration:built`: run integration tests against the existing verified artifact
- `npm test`: build, validate, and run both unit and D1/R2 integration suites; integration failures fail this command
- `npm run validate:artifact`: recheck the Worker handlers, packaged migrations, D1/R2 bindings, client assets, cron, and hosting manifest
- `npm run db:generate`: generate Drizzle migrations after schema changes

`npm run start` requires a successful build. It applies pending packaged migrations to a persistent local D1 database, then runs the production Worker through Wrangler with local `DB` and `BUCKET` bindings. Preview data is isolated under `.sites-runtime/preview-state` and never changes hosted D1 or R2 data. The first run applies the product seed and can take longer than subsequent starts.

### D1/R2 API integration tests

The integration suite requires the same Node.js, Bash, locked dependencies, and successful production build described above. It starts the packaged Cloudflare Worker with Miniflare/Workerd on an operating-system-assigned loopback port, real local D1 and R2 bindings, deterministic test accounts, and test-only Razorpay signing secrets. It disables outbound provider traffic, so Supabase, Twilio, Resend, Razorpay, and other hosted services are not required.

Every run creates a fresh temporary persistence directory, applies every migration packaged in `dist/.openai/drizzle`, proves a second migration pass is a no-op, loads one suite-level fixture, and uses that single migrated Worker runtime for all HTTP scenarios. D1 and R2 side effects are inspected only after the runtime stops, then all temporary state is removed in success, failure, timeout, and signal paths. No command contains `--remote`; hosted D1/R2 resources are never contacted or modified.

Use `SITES_INTEGRATION_TIMEOUT` (default `10m`) and `SITES_INTEGRATION_KILL_AFTER` (default `10s`) to bound the complete integration run. A failed run prints its assertion plus the tail of buffered Workerd logs before cleanup. The full product seed is loaded only once per suite; on the first run, migration and seed setup normally dominate runtime and may take roughly 10–30 seconds depending on the machine.

Use `HOST` and `PORT` to change the listener (defaults: `127.0.0.1:3000`), `SITES_PREVIEW_STATE` to select another local persistence directory, and `SITES_PREVIEW_ENV_FILE` to load one explicit runtime environment file. `.env`, `.env.local`, and `.dev.vars` are loaded automatically when present. `SITES_PREVIEW_SKIP_MIGRATIONS=1` is available only for targeted diagnosis against an already migrated preview database.

## Private Marketplace Integration

Version 5 adds public customer/vendor identity and the live marketplace backend while the Site remains owner-only for testing.

Runtime values are stored in Sites environment variables, never in source control:

- `APP_STAGE=testing`
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` for email/password and phone OTP authentication
- Twilio credentials are configured inside Supabase Auth's phone provider settings
- Supabase email confirmation uses the Site URL as its redirect URL; Resend can be configured as Supabase custom SMTP
- `RESEND_API_KEY` and `RESEND_FROM_EMAIL` send transactional order messages from the application
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` enable test payments

The Razorpay webhook target is `/api/webhooks/razorpay`. Enable at least `payment.captured` and `payment.failed`. The app creates Razorpay orders on the server and verifies checkout signatures before recording payment.

Supabase owns credentials and verification. D1 owns URMED profiles, vendors, batch inventory, customer prices, orders, order items, payment audit events, and delivery tracking. Legacy passwords are never reused.

Live identity and record ownership use `account_profiles`; imported `customers` rows are unlinked admin-only recovery references and cannot authenticate. The decision and future proof-based claim rules are documented in `docs/ACCOUNT_IDENTITY_SOURCE_OF_TRUTH.md`.

Use build and validation commands for targeted diagnosis after a remote failure, not as part of the normal checkpoint path.

The timeout defaults can be overridden for a controlled canary with `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER`, `SITES_BUILD_TIMEOUT`, and `SITES_BUILD_KILL_AFTER`. A timeout fails the command; the helpers never retry an unchanged install or build. Build timeouts return exit status `124` on both macOS and Linux.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
