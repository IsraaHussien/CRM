import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { AuditLog } from "../../src/models/AuditLog";

const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("audit-routes-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Ticket.deleteMany({});
  await AuditLog.deleteMany({});
});

function tokenFor(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET as string);
}

async function seedUser(
  overrides: Partial<{
    role: string;
    email: string;
    name: string;
    isActive: boolean;
    permissions: string[];
  }> = {}
) {
  const user = await User.create({
    name: overrides.name ?? "Test User",
    email: overrides.email ?? `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "customer",
    isActive: overrides.isActive ?? true,
    permissions: overrides.permissions ?? [],
  });
  return { user, token: tokenFor({ id: user.id, role: user.role }) };
}

describe("GET /api/v1/admin/audit-logs (Story 47)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/admin/audit-logs");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a customer or agent token — audit:view can never be granted to an agent", async () => {
    const { token: customerToken } = await seedUser({ role: "customer" });
    const resCustomer = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${customerToken}`);
    expect(resCustomer.status).toBe(403);

    const { token: agentToken } = await seedUser({ role: "agent", permissions: ["staff:view_list"] });
    const resAgent = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${agentToken}`);
    expect(resAgent.status).toBe(403);
  });

  it("returns 200 for an admin token with an empty log", async () => {
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("returns 200 for a subadmin granted ONLY audit:view (no staff:view_list)", async () => {
    const { token } = await seedUser({ role: "subadmin", permissions: ["audit:view"] });
    const res = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("returns 403 for a subadmin without audit:view granted", async () => {
    const { token } = await seedUser({ role: "subadmin", permissions: ["staff:view_list"] });
    const res = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("filters by action and by category", async () => {
    const { user: actor, token } = await seedUser({ role: "admin" });
    await AuditLog.create({ actor: actor._id, action: "login_success", category: "auth", targetType: "User", targetId: actor._id });
    await AuditLog.create({
      actor: actor._id,
      action: "permissions_changed",
      category: "permissions",
      targetType: "User",
      targetId: actor._id,
    });

    const resAction = await request(app)
      .get("/api/v1/admin/audit-logs?action=login_success")
      .set("Authorization", `Bearer ${token}`);
    expect(resAction.status).toBe(200);
    expect(resAction.body.total).toBe(1);
    expect(resAction.body.entries[0].action).toBe("login_success");

    const resCategory = await request(app)
      .get("/api/v1/admin/audit-logs?category=permissions")
      .set("Authorization", `Bearer ${token}`);
    expect(resCategory.status).toBe(200);
    expect(resCategory.body.total).toBe(1);
    expect(resCategory.body.entries[0].category).toBe("permissions");
  });

  it("filters by date range (dateFrom/dateTo)", async () => {
    const { user: actor, token } = await seedUser({ role: "admin" });
    const older = await AuditLog.create({
      actor: actor._id,
      action: "login_success",
      category: "auth",
      targetType: "User",
      targetId: actor._id,
    });
    // Uses the native collection driver, not the Mongoose model, to set
    // createdAt directly — Model.updateOne goes through Mongoose's
    // timestamps-plugin query middleware, which is unreliable to rely on
    // for overriding an already-set createdAt in a test fixture.
    await AuditLog.collection.updateOne({ _id: older._id }, { $set: { createdAt: new Date("2020-01-01T00:00:00Z") } });
    await AuditLog.create({ actor: actor._id, action: "login_success", category: "auth", targetType: "User", targetId: actor._id });

    const res = await request(app)
      .get("/api/v1/admin/audit-logs?dateFrom=2025-01-01")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it("q searches actor name/email and returns zero rows for no match", async () => {
    const { user: actor, token } = await seedUser({ role: "admin", name: "Alice Example", email: "alice@example.com" });
    await AuditLog.create({ actor: actor._id, action: "login_success", category: "auth", targetType: "User", targetId: actor._id });

    const resMatch = await request(app).get("/api/v1/admin/audit-logs?q=alice").set("Authorization", `Bearer ${token}`);
    expect(resMatch.body.total).toBe(1);

    const resNoMatch = await request(app)
      .get("/api/v1/admin/audit-logs?q=nobody-matches-this")
      .set("Authorization", `Bearer ${token}`);
    expect(resNoMatch.status).toBe(200);
    expect(resNoMatch.body.total).toBe(0);
  });

  it("populates actor and target name/email/role", async () => {
    const { user: actor, token } = await seedUser({ role: "admin", name: "Actor Name", email: "actor@example.com" });
    const { user: target } = await seedUser({ role: "agent", name: "Target Name", email: "target@example.com" });
    await AuditLog.create({
      actor: actor._id,
      action: "permissions_changed",
      category: "permissions",
      targetType: "User",
      targetId: target._id,
      metadata: { before: [], after: ["tickets:reassign"] },
    });

    const res = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].actor).toMatchObject({ name: "Actor Name", email: "actor@example.com" });
    expect(res.body.entries[0].target).toMatchObject({ name: "Target Name", email: "target@example.com" });
  });

  it("actor is null and metadata.attemptedEmail is set for an unknown-email login_failed entry", async () => {
    const { token } = await seedUser({ role: "admin" });
    await AuditLog.create({
      actor: null,
      action: "login_failed",
      category: "auth",
      targetType: "User",
      targetId: null,
      metadata: { reason: "unknown_email", attemptedEmail: "nobody@example.com" },
    });

    const res = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].actor).toBeNull();
    expect(res.body.entries[0].metadata.attemptedEmail).toBe("nobody@example.com");
  });

  // Regression: a Ticket-targeted entry must resolve target.reference/subject
  // via a Ticket lookup, not be silently dropped or mixed up with the
  // User-lookup path the other actions use.
  it("resolves a Ticket target to {id, reference, subject} for a ticket_created entry", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: agent } = await seedUser({ role: "agent" });
    const { user: customer } = await seedUser({ role: "customer" });
    const ticket = await Ticket.create({ subject: "Refund request", description: "Details", customer: customer._id });

    await AuditLog.create({
      actor: agent._id,
      action: "ticket_created",
      category: "tickets",
      targetType: "Ticket",
      targetId: ticket._id,
      metadata: { reference: `TCK-${ticket.ticketNumber}`, subject: ticket.subject, customerId: String(customer._id) },
    });

    const res = await request(app).get("/api/v1/admin/audit-logs").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].targetType).toBe("Ticket");
    expect(res.body.entries[0].target).toMatchObject({
      id: ticket.id,
      reference: `TCK-${ticket.ticketNumber}`,
      subject: "Refund request",
    });
  });
});
