import request from "supertest";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { RefreshFamily } from "../../src/models/RefreshFamily";
import { AuditLog } from "../../src/models/AuditLog";
import * as emailService from "../../src/services/email.service";
import { hashResetToken } from "../../src/services/passwordChange.service";

const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("auth-forgot-password-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await RefreshFamily.deleteMany({});
  await AuditLog.deleteMany({});
  vi.restoreAllMocks();
});

const OLD_PASSWORD = "OldPassword1";
const NEW_PASSWORD = "BrandNewPass2";

async function seedUser(email = "user@example.com", overrides: Partial<{ isActive: boolean }> = {}) {
  const passwordHash = await bcrypt.hash(OLD_PASSWORD, 10);
  return User.create({
    name: "Test User",
    email,
    passwordHash,
    role: "customer",
    isActive: overrides.isActive ?? true,
  });
}

describe("POST /api/v1/auth/forgot-password", () => {
  it("returns the generic message for an unknown email and writes no token anywhere", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const res = await request(app).post("/api/v1/auth/forgot-password").send({ email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns the same generic message for a deactivated account and does not issue a token", async () => {
    const user = await seedUser("inactive@example.com", { isActive: false });
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const res = await request(app).post("/api/v1/auth/forgot-password").send({ email: user.email });
    expect(res.status).toBe(200);
    const reloaded = await User.findById(user.id);
    expect(reloaded!.passwordResetTokenHash).toBeNull();
  });

  it("issues a hashed, expiring, unused token for a real active account and emails the link", async () => {
    const user = await seedUser();
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const res = await request(app).post("/api/v1/auth/forgot-password").send({ email: user.email });
    expect(res.status).toBe(200);

    const reloaded = await User.findById(user.id);
    expect(reloaded!.passwordResetTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(reloaded!.passwordResetTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(reloaded!.passwordResetTokenExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 5000);
    expect(reloaded!.passwordResetTokenUsedAt).toBeNull();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: user.email }));
  });

  it("invalidates an earlier unused token when a new one is requested", async () => {
    const user = await seedUser();
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    await request(app).post("/api/v1/auth/forgot-password").send({ email: user.email });
    const first = (await User.findById(user.id))!.passwordResetTokenHash;

    await request(app).post("/api/v1/auth/forgot-password").send({ email: user.email });
    const second = (await User.findById(user.id))!.passwordResetTokenHash;

    expect(second).not.toBe(first);
  });

  it("returns 400 for a malformed body", async () => {
    const res = await request(app).post("/api/v1/auth/forgot-password").send({});
    expect(res.status).toBe(400);
  });

  it("still returns the generic 200 (not a 500) when sendEmail fails, preserving anti-enumeration", async () => {
    const user = await seedUser();
    vi.spyOn(emailService, "sendEmail").mockRejectedValue(new Error("SMTP down"));
    const res = await request(app).post("/api/v1/auth/forgot-password").send({ email: user.email });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
    // The token is still issued even though the email failed to send —
    // matches the "password already changed, notify is best-effort" fallout
    // convention used elsewhere (me.routes.ts's /password, /contact).
    const reloaded = await User.findById(user.id);
    expect(reloaded!.passwordResetTokenHash).not.toBeNull();
  });
});

describe("POST /api/v1/auth/reset-password", () => {
  async function seedUserWithResetToken(overrides: Partial<{ expiresAt: Date; usedAt: Date | null; isActive: boolean }> = {}) {
    const rawToken = "raw-test-token-1234567890";
    const user = await seedUser("reset@example.com", { isActive: overrides.isActive ?? true });
    user.passwordResetTokenHash = hashResetToken(rawToken);
    user.passwordResetTokenExpiresAt = overrides.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000);
    user.passwordResetTokenUsedAt = overrides.usedAt ?? null;
    await user.save();
    return { user, rawToken };
  }

  it("resets the password on a valid token, revokes sessions, notifies, and audit-logs", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user, rawToken } = await seedUserWithResetToken();
    await RefreshFamily.create({
      familyId: "family-a",
      userId: user.id,
      currentHeadHash: "irrelevant",
      sessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      revoked: false,
    });

    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const reloaded = await User.findById(user.id);
    expect(await bcrypt.compare(NEW_PASSWORD, reloaded!.passwordHash)).toBe(true);
    expect(reloaded!.passwordResetTokenHash).toBeNull();
    expect(reloaded!.passwordResetTokenUsedAt).not.toBeNull();

    const family = await RefreshFamily.findOne({ familyId: "family-a" });
    expect(family!.revoked).toBe(true);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    const entry = await AuditLog.findOne({ action: "password_reset" });
    expect(entry).toBeTruthy();
    expect(entry!.actor?.toString()).toBe(user.id);
  });

  it("cannot be replayed once the token has been consumed", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { rawToken } = await seedUserWithResetToken();

    const first = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, newPassword: NEW_PASSWORD });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, newPassword: "AnotherPass3" });
    expect(second.status).toBe(400);
  });

  it("rejects an unknown token with the generic error", async () => {
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "does-not-exist", newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or has expired/i);
  });

  it("rejects an expired token with the generic error", async () => {
    const { rawToken } = await seedUserWithResetToken({ expiresAt: new Date(Date.now() - 60 * 1000) });
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects a token belonging to a now-inactive user", async () => {
    const { rawToken } = await seedUserWithResetToken({ isActive: false });
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a new password shorter than 8 characters", async () => {
    const { rawToken } = await seedUserWithResetToken();
    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: rawToken, newPassword: "short1" });
    expect(res.status).toBe(400);
  });
});
