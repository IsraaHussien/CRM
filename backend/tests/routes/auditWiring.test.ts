import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { SlaTarget } from "../../src/models/SlaTarget";
import { AuditLog } from "../../src/models/AuditLog";

// security-admin Story 47: proof-of-pattern audit-log wiring into the 3
// concrete call sites — login success/failure (auth.routes.ts), permission
// grant/revoke and staff activate/deactivate (admin.routes.ts).
const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("audit-wiring-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await AuditLog.deleteMany({});
  // Ticket creation (sla-automation Story 26) requires the mandatory
  // default SlaTarget row to exist — same fixture ticket.routes.test.ts
  // seeds for the same reason.
  await SlaTarget.deleteMany({});
  await SlaTarget.create({ priority: null, category: null, responseMinutes: 60, resolutionMinutes: 480 });
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
    password: string;
  }> = {}
) {
  const passwordHash = await bcrypt.hash(overrides.password ?? "password123", 4);
  const user = await User.create({
    name: overrides.name ?? "Test User",
    email: overrides.email ?? `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash,
    role: overrides.role ?? "customer",
    isActive: overrides.isActive ?? true,
    permissions: overrides.permissions ?? [],
  });
  return { user, token: tokenFor({ id: user.id, role: user.role }) };
}

describe("POST /api/v1/auth/login audit wiring", () => {
  it("records a login_success entry on successful login", async () => {
    const { user } = await seedUser({ email: "success@example.com", password: "password123" });
    const res = await request(app).post("/api/v1/auth/login").send({ email: "success@example.com", password: "password123" });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("login_success");
    expect(String(entries[0].actor)).toBe(String(user._id));
  });

  it("records a login_failed entry with actor null and attemptedEmail for an unknown email", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@example.com", password: "whatever123" });
    expect(res.status).toBe(401);

    const entries = await AuditLog.find({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("login_failed");
    expect(entries[0].actor).toBeNull();
    expect(entries[0].metadata.reason).toBe("unknown_email");
    expect(entries[0].metadata.attemptedEmail).toBe("nobody@example.com");
  });

  it("records a login_failed entry with reason wrong_password for an existing user", async () => {
    const { user } = await seedUser({ email: "wrongpw@example.com", password: "correct-password" });
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "wrongpw@example.com", password: "incorrect-password" });
    expect(res.status).toBe(401);

    const entries = await AuditLog.find({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("login_failed");
    expect(entries[0].metadata.reason).toBe("wrong_password");
    expect(String(entries[0].actor)).toBe(String(user._id));
  });

  it("records a login_failed entry with reason account_deactivated for a correct password on a deactivated account", async () => {
    await seedUser({ email: "deactivated@example.com", password: "password123", isActive: false });
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "deactivated@example.com", password: "password123" });
    expect(res.status).toBe(403);

    const entries = await AuditLog.find({});
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("login_failed");
    expect(entries[0].metadata.reason).toBe("account_deactivated");
  });
});

describe("PATCH /api/v1/admin/users/:id audit wiring (permission changes)", () => {
  it("records a permissions_changed entry with before/after metadata", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: target } = await seedUser({ role: "agent", permissions: ["reports:view"] });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ permissions: ["tickets:reassign"] });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "permissions_changed" });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata.before).toEqual(["reports:view"]);
    expect(entries[0].metadata.after).toEqual(["tickets:reassign"]);
    expect(String(entries[0].targetId)).toBe(String(target._id));
  });

  it("does not record a permissions_changed entry when only name/email/role are edited", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: target } = await seedUser({ role: "agent" });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "permissions_changed" });
    expect(entries).toHaveLength(0);
  });

  it("records a staff_updated entry with a before/after diff when name/email/role are edited", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: target } = await seedUser({ role: "agent", name: "Original Name" });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "staff_updated" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].targetId)).toBe(String(target._id));
    expect(entries[0].metadata.changes).toMatchObject({ name: { before: "Original Name", after: "Renamed" } });
  });
});

describe("POST/DELETE /api/v1/admin/users audit wiring", () => {
  it("records a staff_created entry", async () => {
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "New Agent", email: "newagent@example.com", password: "password123", role: "agent" });
    expect(res.status).toBe(201);

    const entries = await AuditLog.find({ action: "staff_created" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].targetId)).toBe(String(res.body.id));
  });

  it("records a staff_deleted entry", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: target } = await seedUser({ role: "agent" });

    const res = await request(app)
      .delete(`/api/v1/admin/users/${target.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);

    const entries = await AuditLog.find({ action: "staff_deleted" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].targetId)).toBe(String(target._id));
  });
});

describe("POST /api/v1/auth/logout audit wiring", () => {
  it("records a logout entry attributed to the account whose refresh token was presented", async () => {
    await seedUser({ email: "logout@example.com", password: "password123" });
    const loginRes = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "logout@example.com", password: "password123" });
    expect(loginRes.status).toBe(200);
    await AuditLog.deleteMany({}); // isolate from the login_success entry above

    const res = await request(app)
      .post("/api/v1/auth/logout")
      .send({ refreshToken: loginRes.body.refreshToken });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "logout" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].actor)).toBe(String(loginRes.body.user.id));
  });

  it("records nothing for a logout call with no refresh token", async () => {
    const res = await request(app).post("/api/v1/auth/logout").send({});
    expect(res.status).toBe(200);
    expect(await AuditLog.countDocuments({})).toBe(0);
  });
});

describe("PATCH /api/v1/me/availability audit wiring", () => {
  it("records an agent_availability_changed entry with the new isOnline value", async () => {
    const { token, user } = await seedUser({ role: "agent" });

    const res = await request(app)
      .patch("/api/v1/me/availability")
      .set("Authorization", `Bearer ${token}`)
      .send({ isOnline: true });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "agent_availability_changed" });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata.isOnline).toBe(true);
    expect(String(entries[0].actor)).toBe(String(user._id));
    expect(String(entries[0].targetId)).toBe(String(user._id));
  });
});

describe("PATCH /api/v1/admin/users/:id/(de)activate audit wiring", () => {
  it("records a staff_deactivated entry", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: target } = await seedUser({ role: "agent" });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target.id}/deactivate`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "staff_deactivated" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].targetId)).toBe(String(target._id));
  });

  it("records a staff_activated entry", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: target } = await seedUser({ role: "agent", isActive: false });

    const res = await request(app)
      .patch(`/api/v1/admin/users/${target.id}/activate`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "staff_activated" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].targetId)).toBe(String(target._id));
  });
});

describe("POST /api/v1/tickets audit wiring", () => {
  it("records a ticket_created entry, tagged isStaffCreated, for a staff creation on behalf of a customer", async () => {
    const { token: staffToken } = await seedUser({ role: "agent", permissions: ["tickets:create_for_customer"] });
    const { user: customer } = await seedUser({ role: "customer" });

    const staffRes = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ subject: "Billing question", description: "Details", customerId: customer.id, createdVia: "phone" });
    expect(staffRes.status).toBe(201);

    const entries = await AuditLog.find({ action: "ticket_created" });
    expect(entries).toHaveLength(1);
    expect(entries[0].targetType).toBe("Ticket");
    expect(String(entries[0].targetId)).toBe(String(staffRes.body.id));
    expect(entries[0].metadata.customerId).toBe(String(customer._id));
    expect(entries[0].metadata.isStaffCreated).toBe(true);
  });

  it("also records a ticket_created entry, tagged NOT isStaffCreated, for a customer's own self-submission", async () => {
    const { token: customerToken, user: customer } = await seedUser({ role: "customer" });
    const selfRes = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({ subject: "My own issue", description: "Details" });
    expect(selfRes.status).toBe(201);

    const entries = await AuditLog.find({ action: "ticket_created" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].actor)).toBe(String(customer._id));
    expect(entries[0].metadata.isStaffCreated).toBe(false);
  });
});

describe("PATCH /api/v1/tickets/:id audit wiring", () => {
  it("records a ticket_reassigned entry on assignedAgent change", async () => {
    const { token, user: admin } = await seedUser({ role: "admin" });
    const { user: customer } = await seedUser({ role: "customer" });
    const { user: agent } = await seedUser({ role: "agent", isActive: true });
    const ticket = await Ticket.create({ subject: "Subject", description: "Details", customer: customer._id });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "ticket_reassigned" });
    expect(entries).toHaveLength(1);
    expect(String(entries[0].targetId)).toBe(String(ticket._id));
    expect(entries[0].metadata.to).toBe(String(agent._id));
    expect(String(entries[0].actor)).toBe(String(admin._id));
  });
});

describe("PATCH /api/v1/tickets/:id/status audit wiring", () => {
  it("records a ticket_status_changed entry with from/to metadata", async () => {
    const { token } = await seedUser({ role: "admin", permissions: ["tickets:change_status"] });
    const { user: customer } = await seedUser({ role: "customer" });
    const ticket = await Ticket.create({ subject: "Subject", description: "Details", customer: customer._id });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "ticket_status_changed" });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toMatchObject({ from: "new", to: "in_progress" });
  });
});

describe("PATCH /api/v1/customers/:id audit wiring", () => {
  it("records a customer_updated entry with a before/after diff", async () => {
    const { token } = await seedUser({ role: "admin" });
    const { user: customer } = await seedUser({ role: "customer", name: "Old Name" });

    const res = await request(app)
      .patch(`/api/v1/customers/${customer.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "New Name" });
    expect(res.status).toBe(200);

    const entries = await AuditLog.find({ action: "customer_updated" });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata.changes).toMatchObject({ name: { before: "Old Name", after: "New Name" } });
  });
});

describe("KB FAQ audit wiring", () => {
  it("records a kb_faq_created entry", async () => {
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post("/api/v1/kb/faqs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        question: { en: "How do I reset my password?", ar: "" },
        answer: { en: "Use the reset link.", ar: "" },
        category: "account-and-profile",
      });
    expect(res.status).toBe(201);

    const entries = await AuditLog.find({ action: "kb_faq_created" });
    expect(entries).toHaveLength(1);
    expect(entries[0].targetType).toBe("Faq");
    expect(String(entries[0].targetId)).toBe(String(res.body.id));
  });
});

describe("POST /api/v1/customers audit wiring", () => {
  it("records a customer_created entry when staff creates a customer account", async () => {
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post("/api/v1/customers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "New Customer", email: "newcust@example.com", password: "password123" });
    expect(res.status).toBe(201);

    const entries = await AuditLog.find({ action: "customer_created" });
    expect(entries).toHaveLength(1);
    expect(entries[0].targetType).toBe("User");
    expect(String(entries[0].targetId)).toBe(String(res.body.id));
    expect(entries[0].metadata.email).toBe("newcust@example.com");
  });
});
