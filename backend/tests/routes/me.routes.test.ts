import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { Conversation } from "../../src/models/Conversation";
import { Notification } from "../../src/models/Notification";
import * as emailService from "../../src/services/email.service";

const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("me-routes-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Ticket.deleteMany({});
  await Conversation.deleteMany({});
  await Notification.deleteMany({});
  vi.restoreAllMocks();
});

function tokenFor(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET as string);
}

async function seedUser(
  email = "current@example.com",
  overrides: Partial<{ role: string; isActive: boolean; isOnline: boolean }> = {}
) {
  const user = await User.create({
    name: "Test User",
    email,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "customer",
    isActive: overrides.isActive ?? true,
    isOnline: overrides.isOnline ?? false,
  });
  return { user, token: tokenFor({ id: user.id, role: user.role }) };
}

describe("GET /api/v1/me/status", () => {
  it("includes isOnline in the response body", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent", isOnline: true });
    const res = await request(app).get("/api/v1/me/status").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.isOnline).toBe(true);
  });
});

describe("GET /api/v1/me/support-summary (customer-portal Story 37)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/me/support-summary");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-customer", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent" });
    const res = await request(app).get("/api/v1/me/support-summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("counts open/active/recently-resolved items scoped to the caller, excluding other customers' and old resolutions", async () => {
    const { user: customer, token } = await seedUser();
    const { user: otherCustomer } = await seedUser("other@example.com");

    await Ticket.create({ subject: "a", description: "d", customer: customer._id, status: "new" });
    await Ticket.create({ subject: "b", description: "d", customer: customer._id, status: "in_progress" });
    await Ticket.create({
      subject: "c",
      description: "d",
      customer: customer._id,
      status: "closed",
    });
    const closedOld = await Ticket.create({
      subject: "d",
      description: "d",
      customer: customer._id,
      status: "closed",
    });
    // Mongoose's timestamps plugin re-stamps updatedAt on every update call
    // unless explicitly disabled — { timestamps: false } is what lets this
    // backdate actually stick, simulating a resolution outside the 30-day window.
    await Ticket.findByIdAndUpdate(
      closedOld._id,
      { updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
      { timestamps: false }
    );
    // Not this customer's — must not be counted.
    await Ticket.create({ subject: "e", description: "d", customer: otherCustomer._id, status: "new" });

    await Conversation.create({ customer: customer._id, status: "ai_handling" });
    await Conversation.create({ customer: customer._id, status: "resolved" });

    const res = await request(app).get("/api/v1/me/support-summary").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.openTickets).toBe(2);
    expect(res.body.activeChats).toBe(1);
    expect(res.body.resolvedRecently).toBe(2); // closedRecent (ticket) + resolvedRecent (chat)
  });
});

describe("PATCH /api/v1/me/availability (Story 21, minimal)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).patch("/api/v1/me/availability").send({ isOnline: true });
    expect(res.status).toBe(401);
  });

  it("lets an active agent flip isOnline true and back to false", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });

    const resOn = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: true });
    expect(resOn.status).toBe(200);
    expect(resOn.body).toEqual({ isOnline: true });
    expect((await User.findById(user.id))!.isOnline).toBe(true);

    const resOff = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: false });
    expect(resOff.status).toBe(200);
    expect(resOff.body).toEqual({ isOnline: false });
    expect((await User.findById(user.id))!.isOnline).toBe(false);
  });

  it("returns 403 for an admin", async () => {
    const { token } = await seedUser("admin@example.com", { role: "admin" });
    const res = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: true });
    expect(res.status).toBe(403);
  });

  it("returns 403 for a customer", async () => {
    const { token } = await seedUser("customer@example.com", { role: "customer" });
    const res = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: true });
    expect(res.status).toBe(403);
  });

  it("returns 403 and does not flip isOnline when a deactivated agent tries to go online", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent", isActive: false });
    const res = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: true });
    expect(res.status).toBe(403);
    expect((await User.findById(user.id))!.isOnline).toBe(false);
  });

  it("returns 400 when isOnline is missing or not a boolean", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent" });
    const resMissing = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(resMissing.status).toBe(400);

    const resWrongType = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: "yes" });
    expect(resWrongType.status).toBe(400);
  });
});

describe("GET /api/v1/me/contact", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/me/contact");
    expect(res.status).toBe(401);
  });

  it("returns the caller's own contact info", async () => {
    const { token, user } = await seedUser();
    const res = await request(app).get("/api/v1/me/contact").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ phone: null, email: user.email, pendingEmail: null });
  });
});

describe("PATCH /api/v1/me/contact", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).patch("/api/v1/me/contact").send({ phone: "+201012345678" });
    expect(res.status).toBe(401);
  });

  it("updates phone immediately", async () => {
    const { token, user } = await seedUser();
    const res = await request(app)
      .patch("/api/v1/me/contact")
      .set("Authorization", `Bearer ${token}`)
      .send({ phone: "+201012345678" });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe("+201012345678");
    const reloaded = await User.findById(user.id);
    expect(reloaded!.phone).toBe("+201012345678");
  });

  it("requests an email change: sets pendingEmail, leaves email unchanged, sends confirmation", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token, user } = await seedUser();
    const res = await request(app)
      .patch("/api/v1/me/contact")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "new@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email);
    expect(res.body.pendingEmail).toBe("new@example.com");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "new@example.com" }));
  });

  it("accepts an email with surrounding whitespace (validated after trim)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token } = await seedUser();
    const res = await request(app)
      .patch("/api/v1/me/contact")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "  new@example.com  " });
    expect(res.status).toBe(200);
    expect(res.body.pendingEmail).toBe("new@example.com");
  });

  it("rejects when new email equals current email", async () => {
    const { token, user } = await seedUser();
    const res = await request(app)
      .patch("/api/v1/me/contact")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: user.email });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the new email is already in use by another user", async () => {
    await seedUser("taken@example.com");
    const { token } = await seedUser("me@example.com");
    const res = await request(app)
      .patch("/api/v1/me/contact")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "taken@example.com" });
    expect(res.status).toBe(409);
  });

  it("rolls back pendingEmail/token when sendEmail fails", async () => {
    vi.spyOn(emailService, "sendEmail").mockRejectedValue(new Error("SMTP down"));
    const { token, user } = await seedUser();
    const res = await request(app)
      .patch("/api/v1/me/contact")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "new@example.com" });
    expect(res.status).toBe(502);
    const reloaded = await User.findById(user.id);
    expect(reloaded!.pendingEmail).toBeNull();
    expect(reloaded!.emailConfirmToken).toBeNull();
  });
});

describe("GET /api/v1/me/email/confirm", () => {
  async function requestEmailChange(newEmail: string) {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token, user } = await seedUser();
    await request(app).patch("/api/v1/me/contact").set("Authorization", `Bearer ${token}`).send({ email: newEmail });
    const reloaded = await User.findById(user.id);
    return { userId: user.id, token: reloaded!.emailConfirmToken as string };
  }

  // This is a link a human clicks from an email client, not an API call —
  // it redirects to the frontend's public /email-confirmed landing page
  // (with a status query param) rather than returning JSON. See
  // me.routes.ts's GET /email/confirm handler.
  it("confirms a valid token: redirects with status=success, swaps email, clears pending fields", async () => {
    const { userId, token } = await requestEmailChange("new@example.com");
    const res = await request(app).get(`/api/v1/me/email/confirm?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=success");
    expect(res.headers.location).toContain(encodeURIComponent("new@example.com"));
    const reloaded = await User.findById(userId);
    expect(reloaded!.email).toBe("new@example.com");
    expect(reloaded!.pendingEmail).toBeNull();
    expect(reloaded!.emailConfirmToken).toBeNull();
  });

  it("redirects with status=invalid for an expired token", async () => {
    const { userId } = await requestEmailChange("new@example.com");
    await User.findByIdAndUpdate(userId, { emailConfirmTokenExpiresAt: new Date(Date.now() - 1000) });
    const reloaded = await User.findById(userId);
    const res = await request(app).get(`/api/v1/me/email/confirm?token=${reloaded!.emailConfirmToken}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=invalid");
  });

  it("redirects with status=invalid for an unknown token", async () => {
    const res = await request(app).get("/api/v1/me/email/confirm?token=does-not-exist");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=invalid");
  });

  it("redirects with status=conflict when the pending email was confirmed by another account first (race)", async () => {
    const { userId, token } = await requestEmailChange("race@example.com");
    // Simulate another account having confirmed the same address in the
    // TOCTOU window between this test's setup and the confirm call.
    await seedUser("race@example.com");
    const res = await request(app).get(`/api/v1/me/email/confirm?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("status=conflict");
    const reloaded = await User.findById(userId);
    expect(reloaded!.pendingEmail).toBeNull();
  });
});

async function seedTicket(customer: mongoose.Types.ObjectId) {
  return Ticket.create({ subject: "s", description: "d", customer });
}

describe("GET /api/v1/me/notifications (Story 54)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/me/notifications");
    expect(res.status).toBe(401);
  });

  it("returns the caller's notifications unread-first, newest-first within each bucket, and never someone else's", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const { user: otherAgent } = await seedUser("other@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const ticketA = await seedTicket(customer._id);
    const ticketB = await seedTicket(customer._id);
    const ticketC = await seedTicket(customer._id);

    await Notification.create({ recipient: user._id, type: "ticket_assigned", ticketId: ticketA._id, read: true });
    await Notification.create({ recipient: user._id, type: "ticket_assigned", ticketId: ticketB._id, read: false });
    await Notification.create({ recipient: user._id, type: "ticket_reassigned", ticketId: ticketC._id, read: false });
    await Notification.create({ recipient: otherAgent._id, type: "ticket_assigned", ticketId: ticketA._id, read: false });

    const res = await request(app).get("/api/v1/me/notifications").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.every((n: { read: boolean }) => typeof n.read === "boolean")).toBe(true);
    // Unread ones (ticketB, ticketC) sort before the read one (ticketA).
    expect(res.body[2].read).toBe(true);
    expect(res.body[2].ticket.id).toBe(ticketA.id);
  });

  it("drops a notification whose ticket no longer resolves rather than erroring", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    await Notification.create({
      recipient: user._id,
      type: "ticket_assigned",
      ticketId: new mongoose.Types.ObjectId(),
    });
    const res = await request(app).get("/api/v1/me/notifications").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe("GET /api/v1/me/notifications?page=... — history mode", () => {
  it("returns a plain array (unread-first) when no page/limit/from/to param is present, unchanged", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const ticket = await seedTicket(customer._id);
    await Notification.create({ recipient: user._id, type: "ticket_assigned", ticketId: ticket._id });

    const res = await request(app).get("/api/v1/me/notifications").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("switches to { notifications, total, page, limit } once ?page is present", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    for (let i = 0; i < 5; i++) {
      const ticket = await seedTicket(customer._id);
      await Notification.create({ recipient: user._id, type: "ticket_assigned", ticketId: ticket._id });
    }

    const res = await request(app)
      .get("/api/v1/me/notifications?page=1&limit=2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
  });

  it("sorts newest-first regardless of read state in history mode", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const ticketOld = await seedTicket(customer._id);
    const ticketNew = await seedTicket(customer._id);
    const older = await Notification.create({
      recipient: user._id,
      type: "ticket_assigned",
      ticketId: ticketOld._id,
      read: true,
    });
    await Notification.findByIdAndUpdate(older._id, { createdAt: new Date(Date.now() - 60_000) });
    await Notification.create({ recipient: user._id, type: "ticket_assigned", ticketId: ticketNew._id, read: false });

    const res = await request(app)
      .get("/api/v1/me/notifications?page=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications[0].ticket.id).toBe(ticketNew.id);
    expect(res.body.notifications[1].ticket.id).toBe(ticketOld.id);
  });

  it("filters by from/to date range", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const ticketOld = await seedTicket(customer._id);
    const ticketRecent = await seedTicket(customer._id);
    const old = await Notification.create({ recipient: user._id, type: "ticket_assigned", ticketId: ticketOld._id });
    // Bypass mongoose's timestamps plugin (which otherwise re-stamps
    // createdAt/updatedAt on every save/update) via the raw driver, so this
    // notification's createdAt is genuinely backdated for the filter below.
    await Notification.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date("2020-01-01T00:00:00.000Z") } }
    );
    await Notification.create({ recipient: user._id, type: "ticket_assigned", ticketId: ticketRecent._id });

    const res = await request(app)
      .get("/api/v1/me/notifications?page=1&from=2024-01-01")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.notifications[0].ticket.id).toBe(ticketRecent.id);
  });

  it("never returns another user's notifications in history mode", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent" });
    const { user: otherAgent } = await seedUser("other@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const ticket = await seedTicket(customer._id);
    await Notification.create({ recipient: otherAgent._id, type: "ticket_assigned", ticketId: ticket._id });

    const res = await request(app)
      .get("/api/v1/me/notifications?page=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it("returns 400 for an invalid page value", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent" });
    const res = await request(app)
      .get("/api/v1/me/notifications?page=0")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/v1/me/notifications/:id/read (Story 54)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).patch(`/api/v1/me/notifications/${new mongoose.Types.ObjectId()}/read`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a malformed id", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent" });
    const res = await request(app)
      .patch("/api/v1/me/notifications/not-an-object-id/read")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("marks the caller's own notification read", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const ticket = await seedTicket(customer._id);
    const notification = await Notification.create({
      recipient: user._id,
      type: "ticket_assigned",
      ticketId: ticket._id,
    });

    const res = await request(app)
      .patch(`/api/v1/me/notifications/${notification.id}/read`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
    expect((await Notification.findById(notification.id))!.read).toBe(true);
  });

  it("returns 404 (never 403) for someone else's notification, and does not mark it read", async () => {
    const { user: owner } = await seedUser("owner@example.com", { role: "agent" });
    const { token: otherToken } = await seedUser("other@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const ticket = await seedTicket(customer._id);
    const notification = await Notification.create({
      recipient: owner._id,
      type: "ticket_assigned",
      ticketId: ticket._id,
    });

    const res = await request(app)
      .patch(`/api/v1/me/notifications/${notification.id}/read`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
    expect((await Notification.findById(notification.id))!.read).toBe(false);
  });

  it("returns 404 for a non-existent notification id", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent" });
    const res = await request(app)
      .patch(`/api/v1/me/notifications/${new mongoose.Types.ObjectId()}/read`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/me/workspace (agent-workspace Story 35)", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  async function seedAssignedTicket(opts: {
    customer: mongoose.Types.ObjectId;
    agent?: mongoose.Types.ObjectId | null;
    status?: string;
    subject?: string;
    priority?: string;
    sla?: { responseTargetAt?: Date; resolutionTargetAt?: Date };
  }) {
    return Ticket.create({
      subject: opts.subject ?? "s",
      description: "d",
      customer: opts.customer,
      assignedAgent: opts.agent ?? null,
      status: opts.status ?? "new",
      priority: opts.priority ?? "medium",
      ...(opts.sla ? { sla: opts.sla } : {}),
    });
  }

  async function seedConversation(opts: {
    customer: mongoose.Types.ObjectId;
    agent?: mongoose.Types.ObjectId | null;
    status?: string;
    sla?: { responseTargetAt?: Date };
  }) {
    return Conversation.create({
      customer: opts.customer,
      assignedAgent: opts.agent ?? null,
      status: opts.status ?? "with_agent",
      ...(opts.sla ? { sla: opts.sla } : {}),
    });
  }

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/me/workspace");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a customer", async () => {
    const { token } = await seedUser("customer@example.com");
    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 for a deactivated agent whose token is still valid", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent", isActive: false });
    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns all three columns, empty, for an agent with nothing assigned", async () => {
    const { token } = await seedUser("agent@example.com", { role: "agent" });
    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.columns).sort()).toEqual(["at_risk", "breached", "on_track"]);
    for (const key of ["breached", "at_risk", "on_track"]) {
      expect(res.body.columns[key].items).toEqual([]);
      expect(res.body.columns[key].total).toBe(0);
    }
    expect(typeof res.body.generatedAt).toBe("string");
  });

  it("never returns another agent's assignments", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const { user: otherAgent } = await seedUser("other@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const mine = await seedAssignedTicket({ customer: customer._id, agent: user._id });
    await seedAssignedTicket({ customer: customer._id, agent: otherAgent._id });

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const all = [
      ...res.body.columns.breached.items,
      ...res.body.columns.at_risk.items,
      ...res.body.columns.on_track.items,
    ];
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(mine.id);
  });

  it("mixes tickets and live chats in the same column", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const past = new Date(Date.now() - HOUR);
    const ticket = await seedAssignedTicket({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: past },
    });
    const conversation = await seedConversation({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: past },
    });

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const breached = res.body.columns.breached.items;
    expect(breached).toHaveLength(2);
    expect(breached.map((i: { type: string }) => i.type).sort()).toEqual(["chat", "ticket"]);
    const ticketItem = breached.find((i: { type: string }) => i.type === "ticket");
    const chatItem = breached.find((i: { type: string }) => i.type === "chat");
    expect(ticketItem.id).toBe(ticket.id);
    expect(ticketItem.reference).toBe(`TCK-${ticket.ticketNumber}`);
    expect(chatItem.id).toBe(conversation.id);
    expect(chatItem.reference).toBeNull();
  });

  it("groups by the SLA status computeSlaStatus derives", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const breachedTicket = await seedAssignedTicket({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: new Date(Date.now() - HOUR) },
    });
    const atRiskTicket = await seedAssignedTicket({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: new Date(Date.now() + 5 * MINUTE) },
    });
    const onTrackTicket = await seedAssignedTicket({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: new Date(Date.now() + 6 * HOUR) },
    });

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.columns.breached.items.map((i: { id: string }) => i.id)).toEqual([breachedTicket.id]);
    expect(res.body.columns.at_risk.items.map((i: { id: string }) => i.id)).toEqual([atRiskTicket.id]);
    expect(res.body.columns.on_track.items.map((i: { id: string }) => i.id)).toEqual([onTrackTicket.id]);
  });

  it("sorts the most-overdue item first inside a column", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const lessOverdue = await seedAssignedTicket({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: new Date(Date.now() - 20 * MINUTE) },
    });
    const mostOverdue = await seedAssignedTicket({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: new Date(Date.now() - 3 * HOUR) },
    });

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.columns.breached.items.map((i: { id: string }) => i.id)).toEqual([mostOverdue.id, lessOverdue.id]);
  });

  it("sorts an item with no SLA target last inside its column", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const noTarget = await seedAssignedTicket({ customer: customer._id, agent: user._id });
    const distantTarget = await seedAssignedTicket({
      customer: customer._id,
      agent: user._id,
      sla: { responseTargetAt: new Date(Date.now() + 6 * HOUR) },
    });

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const onTrack = res.body.columns.on_track.items;
    expect(onTrack.map((i: { id: string }) => i.id)).toEqual([distantTarget.id, noTarget.id]);
    expect(onTrack[1].urgencyAt).toBeNull();
  });

  it("emits a chat item with resolutionTargetAt null and urgencyAt equal to its response target", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    const responseTargetAt = new Date(Date.now() + 6 * HOUR);
    await seedConversation({ customer: customer._id, agent: user._id, sla: { responseTargetAt } });

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const item = res.body.columns.on_track.items[0];
    expect(item.type).toBe("chat");
    expect(item.resolutionTargetAt).toBeNull();
    expect(item.responseTargetAt).toBe(responseTargetAt.toISOString());
    expect(item.urgencyAt).toBe(responseTargetAt.toISOString());
    expect(item.priority).toBeNull();
    expect(item.customer.name).toBe("Test User");
  });

  it("excludes closed tickets, resolved chats and unclaimed escalated chats", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    await seedAssignedTicket({ customer: customer._id, agent: user._id, status: "closed" });
    await seedConversation({ customer: customer._id, agent: user._id, status: "resolved" });
    await seedConversation({ customer: customer._id, agent: null, status: "escalated" });

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.columns.breached.total).toBe(0);
    expect(res.body.columns.at_risk.total).toBe(0);
    expect(res.body.columns.on_track.total).toBe(0);
  });

  it("caps a column at 25 items while reporting the true total", async () => {
    const { token, user } = await seedUser("agent@example.com", { role: "agent" });
    const customer = (await seedUser("customer@example.com")).user;
    for (let i = 0; i < 27; i++) {
      await seedAssignedTicket({
        customer: customer._id,
        agent: user._id,
        sla: { responseTargetAt: new Date(Date.now() - (i + 1) * MINUTE) },
      });
    }

    const res = await request(app).get("/api/v1/me/workspace").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.columns.breached.items).toHaveLength(25);
    expect(res.body.columns.breached.total).toBe(27);
  });
});
