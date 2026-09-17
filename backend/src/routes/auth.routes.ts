import express, { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User";
import { RefreshFamily } from "../models/RefreshFamily";
import type { JwtPayload } from "../middleware/auth";
import jwt from "jsonwebtoken";
import { validateBody } from "../middleware/validate";
import {
  registerBodySchema,
  RegisterBody,
  forgotPasswordBodySchema,
  ForgotPasswordBody,
  resetPasswordBodySchema,
  ResetPasswordBody,
} from "../validation/auth.schema";
import { recordAuditLog } from "../services/auditLog.service";
import {
  generateResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
  revokeSessionsAndNotify,
} from "../services/passwordChange.service";
import { sendEmail, renderEmailHtml } from "../services/email.service";
import {
  generateFamilyId,
  generateRootToken,
  parseFamilyId,
  hashToken,
  hashesEqual,
  deriveSuccessor,
  parseDurationMs,
} from "../utils/refreshToken";

const router = express.Router();

export const BCRYPT_SALT_ROUNDS = 10;
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || "30d";

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, {
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
  } as jwt.SignOptions);
}

// Mints a new refresh-token family (one per login session) and returns the
// raw root token — see .squad/plans/auth/02-story-login-customer-agent-or-admin.md,
// "Addendum: Refresh token mechanism". Called once at login/register; every
// subsequent token in this family is derived from this root via the
// deterministic HMAC chain in POST /refresh, never freshly random again.
async function issueRefreshFamily(userId: string): Promise<string> {
  const familyId = generateFamilyId();
  const rootToken = generateRootToken(familyId);
  await RefreshFamily.create({
    familyId,
    userId,
    currentHeadHash: hashToken(rootToken),
    sessionExpiresAt: new Date(Date.now() + parseDurationMs(REFRESH_TOKEN_TTL)),
  });
  return rootToken;
}

// auth feature, Story 1: create a customer account (self-service sign-up is
// always role "customer" — agent/admin accounts are created by an admin,
// Story 44). Auto-logs the customer in by returning a JWT on success.
router.post(
  "/register",
  validateBody(registerBodySchema),
  async (req: Request<unknown, unknown, RegisterBody>, res: Response) => {
    const { name, email, password, phone } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    let user;
    try {
      user = await User.create({
        name,
        email,
        passwordHash,
        role: "customer",
        phone,
      });
    } catch (err) {
      // Guards the race between the findOne check above and this insert —
      // the unique index on User.email (models/User.ts line 60) is the
      // authoritative constraint; this only turns a raw MongoServerError
      // into a clean 409.
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "An account with this email already exists" });
        return;
      }
      throw err;
    }

    const token = signToken({
      sub: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      permissions: user.permissions ?? [],
      membershipNumber: user.membershipNumber,
    });
    const refreshToken = await issueRefreshFamily(user.id);
    await recordAuditLog({
      actor: user.id,
      action: "customer_registered",
      targetType: "User",
      targetId: user.id,
      ipAddress: req.ip,
    });
    res.status(201).json({
      token,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  }
);

// auth feature, Story 2: log in with email/password for any role. Invalid
// credentials always return the same generic error — whether the email or
// the password was wrong, or the account is deactivated — so a caller can't
// enumerate registered emails or account status.
router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  // Captured once, reused in every branch below — security-admin Story 47's
  // audit trail (login success/failure is one of its 3 proof-of-pattern
  // wiring points). Express's own proxy-aware accessor; optional per the
  // AuditLog model, not configured with any extra trust-proxy setup here.
  const ipAddress = req.ip;

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalizedEmail });

  if (!user) {
    await recordAuditLog({
      actor: null,
      action: "login_failed",
      targetType: "User",
      metadata: { reason: "unknown_email", attemptedEmail: normalizedEmail },
      ipAddress,
    });
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    await recordAuditLog({
      actor: user.id,
      action: "login_failed",
      targetType: "User",
      targetId: user.id,
      metadata: { reason: "wrong_password" },
      ipAddress,
    });
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  // Deliberately checked AFTER the password, not folded into the query
  // above with `!user.isActive` (that was the previous shape) — this way a
  // wrong-password guess against a deactivated account still gets the
  // generic anti-enumeration message, and only a caller who actually knows
  // the correct password for a real, deactivated account sees this distinct
  // one. A 403, not 401: the credentials themselves were correct.
  if (!user.isActive) {
    await recordAuditLog({
      actor: user.id,
      action: "login_failed",
      targetType: "User",
      targetId: user.id,
      metadata: { reason: "account_deactivated" },
      ipAddress,
    });
    res.status(403).json({ error: "ACCOUNT_DEACTIVATED" });
    return;
  }

  const token = signToken({
    sub: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    permissions: user.permissions ?? [],
    membershipNumber: user.membershipNumber,
  });
  const refreshToken = await issueRefreshFamily(user.id);
  await recordAuditLog({
    actor: user.id,
    action: "login_success",
    targetType: "User",
    targetId: user.id,
    ipAddress,
  });
  res.status(200).json({
    token,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

interface RefreshBody {
  refreshToken?: string;
}

// auth feature, refresh-token addendum (see the plan doc): rotates a refresh
// token via a deterministic HMAC chain — concurrent requests presenting the
// same token converge on the same successor instead of forking the family
// (see utils/refreshToken.ts). Presenting an already-superseded token is
// treated as reuse and revokes the whole family, not just this request.
router.post("/refresh", async (req: Request<unknown, unknown, RefreshBody>, res: Response) => {
  const presented = req.body?.refreshToken;
  if (typeof presented !== "string" || !presented) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const familyId = parseFamilyId(presented);
  if (!familyId) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const family = await RefreshFamily.findOne({ familyId });
  if (!family || family.revoked || family.sessionExpiresAt.getTime() <= Date.now()) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const presentedHash = hashToken(presented);
  const successor = deriveSuccessor(presented);
  const successorHash = hashToken(successor);

  // Deliberately does NOT compare presentedHash against family.currentHeadHash
  // as a standalone up-front check — that read is a snapshot that a
  // concurrent sibling request presenting the same token can race past,
  // which would misfire as "reuse" for a perfectly legitimate concurrent
  // refresh. The atomic CAS below is the only thing allowed to decide
  // whether the presented token was current.
  const advanced = await RefreshFamily.findOneAndUpdate(
    { familyId, currentHeadHash: presentedHash },
    { $set: { currentHeadHash: successorHash } }
  );

  if (!advanced) {
    // Either a concurrent sibling already advanced the chain to exactly the
    // successor this request also derived (legitimate — same deterministic
    // function, same input), or the presented token is genuinely stale
    // (superseded by an earlier, unrelated rotation). Only the second case
    // is reuse/theft.
    const current = await RefreshFamily.findOne({ familyId });
    if (!current || !hashesEqual(current.currentHeadHash, successorHash)) {
      if (current && !current.revoked) {
        current.revoked = true;
        await current.save();
        console.warn(`[auth/refresh] refresh token reuse detected, family ${familyId} revoked`);
      }
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }
  }

  const user = await User.findById(family.userId);
  if (!user || !user.isActive) {
    await RefreshFamily.updateOne({ familyId }, { $set: { revoked: true } });
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }

  const token = signToken({
    sub: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    permissions: user.permissions ?? [],
    membershipNumber: user.membershipNumber,
  });
  res.status(200).json({
    token,
    refreshToken: successor,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

interface LogoutBody {
  refreshToken?: string;
}

// Best-effort server-side revocation — the frontend clears its cookies
// regardless of this call's outcome (see frontend/app/actions.ts logout()).
router.post("/logout", async (req: Request<unknown, unknown, LogoutBody>, res: Response) => {
  const presented = req.body?.refreshToken;
  const familyId = typeof presented === "string" ? parseFamilyId(presented) : null;
  if (familyId) {
    // findOneAndUpdate, not updateOne — same revocation write as before,
    // but this also hands back userId so the logout can be attributed in
    // the audit trail (security-admin Story 47) without a second query.
    const family = await RefreshFamily.findOneAndUpdate({ familyId }, { $set: { revoked: true } });
    if (family) {
      await recordAuditLog({ actor: String(family.userId), action: "logout", targetType: "User", targetId: String(family.userId), ipAddress: req.ip });
    }
  }
  res.status(200).json({ message: "Logged out" });
});

// auth feature, Story 65: forgot password. Always returns the same generic
// 200 response — whether the email matches a real, active account or not —
// same anti-enumeration reasoning as /login's generic 401 and
// me.routes.ts's email-confirmation flow. No audit log entry here: the
// request itself isn't privileged, and logging every attempt (including
// unknown emails) would just be abuse-noise.
// TODO(security-admin): rate-limit this route per IP + per email — not
// enforced by this story (auth Story 65), tracked as a security-admin gap.
router.post(
  "/forgot-password",
  validateBody(forgotPasswordBodySchema),
  async (req: Request<unknown, unknown, ForgotPasswordBody>, res: Response) => {
    const genericResponse = {
      message: "If an account exists for this email, we've sent a reset link.",
    };

    const user = await User.findOne({ email: req.body.email });

    // Silently no-op on unknown email or inactive account — identical
    // response shape either way, so a caller can't distinguish "no such
    // account" from "email sent" by the response alone.
    if (!user || !user.isActive) {
      res.json(genericResponse);
      return;
    }

    const { rawToken, tokenHash } = generateResetToken();
    user.passwordResetTokenHash = tokenHash;
    user.passwordResetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    user.passwordResetTokenUsedAt = null; // invalidates any earlier unused link for this account
    await user.save();

    // Wrapped in try/catch (unlike me.routes.ts's email-change flow, which
    // rolls back on failure): this route's anti-enumeration property depends
    // on ALWAYS returning the same 200 response regardless of account
    // existence, so a transient SMTP hiccup for a real account must not
    // surface as a 500 that a caller could use to distinguish it from an
    // unknown email.
    const resetUrl = `${process.env.CLIENT_ORIGIN || "http://localhost:3000"}/reset-password?token=${rawToken}`;
    try {
      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        text: `Hi ${user.name},\n\nClick the link below to reset your password. It expires in 15 minutes.\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
        html: renderEmailHtml({
          heading: "Reset your password",
          bodyHtml: `<p>Hi ${user.name},</p><p>Click the button below to reset your password. This link expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`,
          ctaText: "Reset password",
          ctaUrl: resetUrl,
        }),
      });
    } catch (err) {
      console.warn("[auth/forgot-password] reset email failed to send", err);
    }

    res.json(genericResponse);
  }
);

// auth feature, Story 65: consumes a forgot-password link. Invalid, expired,
// and already-used tokens all collapse to the same generic error — the
// caller must not be able to tell which of the three occurred.
router.post(
  "/reset-password",
  validateBody(resetPasswordBodySchema),
  async (req: Request<unknown, unknown, ResetPasswordBody>, res: Response) => {
    const genericError = { error: "This reset link is invalid or has expired." };

    const tokenHash = hashResetToken(req.body.token);
    const user = await User.findOne({ passwordResetTokenHash: tokenHash });

    if (
      !user ||
      !user.isActive ||
      !user.passwordResetTokenExpiresAt ||
      user.passwordResetTokenExpiresAt.getTime() < Date.now() ||
      user.passwordResetTokenUsedAt !== null
    ) {
      res.status(400).json(genericError);
      return;
    }

    user.passwordHash = await bcrypt.hash(req.body.newPassword, BCRYPT_SALT_ROUNDS);
    user.passwordResetTokenUsedAt = new Date();
    user.passwordResetTokenHash = null; // one-shot: the token can never be replayed
    user.passwordResetTokenExpiresAt = null;
    await user.save();

    // No exemption — there's no "current session" here, the caller was
    // logged out to begin with.
    await revokeSessionsAndNotify({ userId: user.id, userEmail: user.email, userName: user.name });

    await recordAuditLog({
      actor: user.id,
      action: "password_reset",
      targetType: "User",
      targetId: user.id,
      ipAddress: req.ip,
    });

    res.json({ message: "Your password has been reset. You can now sign in." });
  }
);

export default router;
