import { getD1 } from "../../../../db/d1";
import { errorResponse, getLocalProfile } from "../../../../lib/auth-server";
import { randomTestToken, sha256, TEST_TOKEN_PREFIX } from "../../../../lib/test-auth";

type TestAccount = { id: number; authUserId: string; passwordSha256: string };

function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const email = String(body.email ?? "").trim().toLowerCase().slice(0, 180);
    const password = String(body.password ?? "").slice(0, 200);
    const db = getD1();
    const account = await db.prepare(`
      SELECT account.id, account.password_sha256 AS passwordSha256, profile.auth_user_id AS authUserId
      FROM test_accounts account JOIN account_profiles profile ON profile.id = account.profile_id
      WHERE account.email = ? AND account.active = 1 AND profile.status = 'active' LIMIT 1
    `).bind(email).first<TestAccount>();
    if (!account || await sha256(password) !== account.passwordSha256) {
      return Response.json({ error: "Test email or password is incorrect" }, { status: 401 });
    }
    const token = randomTestToken();
    const tokenHash = await sha256(token);
    await db.batch([
      db.prepare("DELETE FROM test_sessions WHERE test_account_id = ? OR datetime(expires_at) <= datetime('now')").bind(account.id),
      db.prepare(`INSERT INTO test_sessions (test_account_id, token_hash, expires_at)
        VALUES (?, ?, datetime('now', '+8 hours'))`).bind(account.id, tokenHash),
    ]);
    return Response.json({ token, profile: await getLocalProfile(account.authUserId), expiresInHours: 8 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const token = bearer(request);
    if (token.startsWith(TEST_TOKEN_PREFIX)) {
      await getD1().prepare("DELETE FROM test_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    }
    return Response.json({ signedOut: true });
  } catch (error) {
    return errorResponse(error);
  }
}
