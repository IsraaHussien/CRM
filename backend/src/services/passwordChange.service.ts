import crypto from "crypto";
import { renderEmailHtml, sendEmail } from "./email.service";
import { revokeAllRefreshFamiliesForUser } from "../utils/refreshToken";

// auth Story 65 (forgot password): reset tokens are single-use and expire 15
// minutes after issue — deliberately stronger than User.emailConfirmToken's
// 24h plaintext precedent, because a leaked password-reset token is a full
// account takeover, not just an email change.
export const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Generates a fresh reset token. Only the SHA-256 hash is ever persisted
 * (User.passwordResetTokenHash) — the raw token exists only in the email
 * link and this return value, never touching the database.
 */
export function generateResetToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString("hex");
  return { rawToken, tokenHash: hashResetToken(rawToken) };
}

export function hashResetToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Shared fallout for both password-change (Story 64) and password-reset
 * (Story 65): revoke active sessions and send a best-effort "your password
 * was changed" notification email. Story 64 passes `exemptFamilyId` so the
 * caller's own current session survives; Story 65 never does, since the
 * caller wasn't logged in to begin with. The email send is swallowed here —
 * a failure to notify must never roll back (or block on) the password
 * change that already happened.
 */
export async function revokeSessionsAndNotify(params: {
  userId: string;
  userEmail: string;
  userName: string;
  exemptFamilyId?: string | null;
}): Promise<void> {
  await revokeAllRefreshFamiliesForUser(params.userId, params.exemptFamilyId ?? null);

  const loginUrl = `${process.env.CLIENT_ORIGIN || "http://localhost:3000"}/login`;
  try {
    await sendEmail({
      to: params.userEmail,
      subject: "Your password was changed",
      text: `Hi ${params.userName},\n\nYour password was just changed. If this wasn't you, contact support immediately.\n\nSign in: ${loginUrl}`,
      html: renderEmailHtml({
        heading: "Your password was changed",
        bodyHtml: `<p>Hi ${params.userName},</p><p>Your password was just changed. If this wasn't you, contact support immediately.</p>`,
        ctaText: "Sign in",
        ctaUrl: loginUrl,
      }),
    });
  } catch (err) {
    console.warn("[passwordChange] confirmation email failed", err);
  }
}
