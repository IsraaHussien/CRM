import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { SlaTarget } from "../../src/models/SlaTarget";
import { TicketCategory } from "../../src/models/TicketCategory";
import { Message } from "../../src/models/Message";
import { Conversation } from "../../src/models/Conversation";
import { Notification } from "../../src/models/Notification";
import * as emailService from "../../src/services/email.service";
import * as summaryService from "../../src/services/summary.service";

const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("ticket-routes-test"));
  // sla-automation Story 26: Ticket.create now resolves SLA targets on every
  // creation, which requires the mandatory default SlaTarget row to exist.
  // Seeded once here (not cleared by beforeEach below) so every existing
  // ticket-creation test keeps working unmodified.
  await SlaTarget.create({ priority: null, category: null, responseMinutes: 60, resolutionMinutes: 480 });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Ticket.deleteMany({});
  await TicketCategory.deleteMany({});
  await Message.deleteMany({});
  await Conversation.deleteMany({});
  await Notification.deleteMany({});
});

function tokenFor(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET as string);
}

async function seedUser(
  overrides: Partial<{ role: string; email: string; name: string; permissions: string[]; isActive: boolean }> = {}
) {
  const user = await User.create({
    name: overrides.name ?? "Test Customer",
    email: overrides.email ?? `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "customer",
    permissions: overrides.permissions ?? [],
    isActive: overrides.isActive ?? true,
  });
  return { user, token: tokenFor({ id: user.id, role: user.role }) };
}

describe("POST /api/v1/tickets (Story 8)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app)
      .post("/api/v1/tickets")
      .send({ subject: "Help", description: "It's broken" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-customer caller without tickets:create_for_customer", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });
    expect(res.status).toBe(403);
  });

  it("returns 400 when subject is missing", async () => {
    const { token } = await seedUser();
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "It's broken" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when description is missing", async () => {
    const { token } = await seedUser();
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help" });
    expect(res.status).toBe(400);
  });

  it("creates a ticket with status new, no category/assignedAgent, and sends an acknowledgment email", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user, token } = await seedUser({ email: "customer@example.com" });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Login broken", description: "Cannot sign in since this morning" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subject: "Login broken", status: "new" });
    expect(res.body.id).toBeTruthy();

    const ticket = await Ticket.findById(res.body.id);
    expect(ticket).not.toBeNull();
    expect(ticket!.customer.toString()).toBe(user.id);
    expect(ticket!.category).toBeNull();
    expect(ticket!.assignedAgent).toBeNull();
    expect(ticket!.priority).toBe("medium");

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "customer@example.com" }));
  });

  it("populates sla.responseTargetAt/resolutionTargetAt and returns slaStatus 'on_track' (Story 26)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Login broken", description: "Cannot sign in since this morning" });

    expect(res.status).toBe(201);
    expect(res.body.slaStatus).toBe("on_track");
    expect(new Date(res.body.responseTargetAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(res.body.resolutionTargetAt).getTime()).toBeGreaterThan(Date.now());

    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.sla.responseTargetAt).toBeInstanceOf(Date);
    expect(ticket!.sla.resolutionTargetAt).toBeInstanceOf(Date);
  });

  it("still creates the ticket and returns 201 when the acknowledgment email fails to send", async () => {
    vi.spyOn(emailService, "sendEmail").mockRejectedValue(new Error("SMTP down"));
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Login broken", description: "Cannot sign in since this morning" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket).not.toBeNull();
  });

  it("lets a customer set a category on their own ticket (frontend now offers this, not just staff)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Billing question", description: "Charged twice", category: "Billing" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.category).toBe("Billing");
  });

  it("sets createdBy to the customer and createdVia to customer_portal, ignoring any client-supplied createdVia (Story 63)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user, token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Login broken", description: "Cannot sign in", createdVia: "phone" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.createdBy?.toString()).toBe(user.id);
    expect(ticket!.createdVia).toBe("customer_portal");
  });
});

describe("POST /api/v1/tickets — staff mode (Story 57)", () => {
  it("lets an agent with tickets:create_for_customer, tickets:categorize and tickets:change_priority create a ticket for an existing customer with a non-default category/priority", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: pickedCustomer } = await seedUser({ email: "picked@example.com" });
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:create_for_customer", "tickets:categorize", "tickets:change_priority"],
    });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Billing issue reported by phone",
        description: "Customer called in about a duplicate charge.",
        customerId: pickedCustomer.id,
        category: "billing",
        priority: "high",
        createdVia: "phone",
      });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket).not.toBeNull();
    expect(ticket!.customer.toString()).toBe(pickedCustomer.id);
    expect(ticket!.priority).toBe("high");
    expect(ticket!.category).toBe("billing");
    expect(ticket!.status).toBe("new");
    expect(ticket!.assignedAgent).toBeNull();
  });

  // Gap closed: tickets:create_for_customer alone used to be enough to set
  // ANY category/priority on creation — no separate check against
  // tickets:categorize/tickets:change_priority the way PATCH /:id already
  // requires to change them later. Creating with defaults still needs
  // nothing beyond tickets:create_for_customer; setting a non-default
  // category or priority up front now needs the matching extra permission,
  // same as PATCH /:id.
  it("agent with only tickets:create_for_customer can create with defaults, but 403s if they try to set category or priority", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: pickedCustomer } = await seedUser({ email: "picked-defaults@example.com" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:create_for_customer"] });

    const withDefaults = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "No category or priority set",
        description: "Should still work with defaults.",
        customerId: pickedCustomer.id,
        createdVia: "email",
      });
    expect(withDefaults.status).toBe(201);
    const defaultTicket = await Ticket.findById(withDefaults.body.id);
    expect(defaultTicket!.category).toBeNull();
    expect(defaultTicket!.priority).toBe("medium");

    const withCategory = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Tries to set category",
        description: "Should be rejected.",
        customerId: pickedCustomer.id,
        category: "billing",
      });
    expect(withCategory.status).toBe(403);

    const withPriority = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Tries to set priority",
        description: "Should be rejected.",
        customerId: pickedCustomer.id,
        priority: "high",
      });
    expect(withPriority.status).toBe(403);
  });

  it("lets an admin create a ticket for a customer without any explicit permission grant (implicit admin pass)", async () => {
    // Regression test for the bug caught during plan review: calling
    // hasPermission() directly (instead of through requirePermission) would
    // incorrectly 403 an admin, whose `permissions` array is normally empty.
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: pickedCustomer } = await seedUser({ email: "picked-by-admin@example.com" });
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Opened by admin",
        description: "Reported in person at the front desk.",
        customerId: pickedCustomer.id,
        createdVia: "in_person",
      });

    expect(res.status).toBe(201);
  });

  it("returns 400 when customerId is not a valid ObjectId", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:create_for_customer"] });
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: "not-an-object-id" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when customerId refers to a staff account rather than a customer", async () => {
    const { user: otherAgent } = await seedUser({ role: "agent" });
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: otherAgent.id });
    expect(res.status).toBe(400);
  });

  it("returns 400 when customerId refers to a deactivated customer", async () => {
    const { user: inactiveCustomer } = await seedUser({ isActive: false });
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: inactiveCustomer.id });
    expect(res.status).toBe(400);
  });

  it("does not send any email when notifyCustomer is false (or omitted)", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: pickedCustomer } = await seedUser();
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: pickedCustomer.id, notifyCustomer: false, createdVia: "other" });

    expect(res.status).toBe(201);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends a notify email to the picked customer when notifyCustomer is true, and still returns 201 if it throws", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockRejectedValue(new Error("SMTP down"));
    const { user: pickedCustomer } = await seedUser({ email: "notify-me@example.com" });
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: pickedCustomer.id, notifyCustomer: true, createdVia: "phone" });

    expect(res.status).toBe(201);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "notify-me@example.com" }));
  });

  it("returns 400 when createdVia is missing (Story 63)", async () => {
    const { user: pickedCustomer } = await seedUser();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:create_for_customer"] });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: pickedCustomer.id });

    expect(res.status).toBe(400);
  });

  it("returns 400 when a staff caller sends createdVia: customer_portal (Story 63)", async () => {
    const { user: pickedCustomer } = await seedUser();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:create_for_customer"] });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: pickedCustomer.id, createdVia: "customer_portal" });

    expect(res.status).toBe(400);
  });

  it("sets createdBy to the staff user and round-trips createdVia through GET /:id (Story 63)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: pickedCustomer } = await seedUser();
    const { user: staffUser, token } = await seedUser({
      role: "agent",
      permissions: ["tickets:create_for_customer"],
    });

    const createRes = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "x", description: "y", customerId: pickedCustomer.id, createdVia: "phone" });
    expect(createRes.status).toBe(201);

    const stored = await Ticket.findById(createRes.body.id);
    expect(stored!.createdBy?.toString()).toBe(staffUser.id);
    expect(stored!.createdVia).toBe("phone");

    const getRes = await request(app)
      .get(`/api/v1/tickets/${createRes.body.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.createdVia).toBe("phone");
    expect(getRes.body.createdBy).toMatchObject({ id: staffUser.id, name: staffUser.name });
  });

  it("returns 200 from GET /:id with createdBy/createdVia null for a ticket seeded without them (no migration required, Story 63)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent" });

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.createdBy).toBeNull();
    expect(res.body.createdVia).toBeNull();
  });
});

async function seedOnlineAgent(overrides: Partial<{ email: string }> = {}) {
  return User.create({
    name: "Available Agent",
    email: overrides.email ?? `agent-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: "agent",
    isOnline: true,
    isActive: true,
  });
}

describe("POST /api/v1/tickets — auto-assignment (Story 10)", () => {
  it("assigns the newly created ticket to an online agent", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const agent = await seedOnlineAgent();
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.assignedAgent?.toString()).toBe(agent.id);
  });

  it("leaves assignedAgent null when no agent is online", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.assignedAgent).toBeNull();
  });

  it("writes exactly one ticket_assigned notification for the picked agent (Story 54)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const agent = await seedOnlineAgent();
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const notifications = await Notification.find({ recipient: agent._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("ticket_assigned");
    expect(notifications[0].ticketId!.toString()).toBe(res.body.id);
  });

  it("writes no notification when no agent is online", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it("sends an assignment email to the picked agent", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const agent = await seedOnlineAgent({ email: "agent@example.com" });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: agent.email, subject: expect.stringContaining("New ticket assigned to you") })
    );
  });

  it("still returns 201 when the assignment notification email throws", async () => {
    vi.spyOn(emailService, "sendEmail")
      .mockResolvedValueOnce({ dryRun: true }) // acknowledgment email to the customer
      .mockRejectedValueOnce(new Error("SMTP down")); // assignment email to the agent
    await seedOnlineAgent();
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.assignedAgent).not.toBeNull();
  });

  it("auto-assigns on the staff-created branch too", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const agent = await seedOnlineAgent();
    const { user: pickedCustomer } = await seedUser({ email: "picked@example.com" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:create_for_customer"] });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken", customerId: pickedCustomer.id, createdVia: "email" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.assignedAgent?.toString()).toBe(agent.id);
  });
});

describe("POST /api/v1/tickets — oversight notifications for admins/subadmins", () => {
  it("notifies admins and tickets:view_all subadmins of a new ticket, but not a plain agent or an unpermitted subadmin", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: admin } = await seedUser({ role: "admin" });
    const { user: permittedSubadmin } = await seedUser({ role: "subadmin", permissions: ["tickets:view_all"] });
    const { user: unpermittedSubadmin } = await seedUser({ role: "subadmin", permissions: [] });
    const { user: plainAgent } = await seedUser({ role: "agent" });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const recipients = (await Notification.find({ type: "ticket_created" })).map((n) => n.recipient.toString());
    expect(recipients.sort()).toEqual([admin.id, permittedSubadmin.id].sort());
    expect(recipients).not.toContain(unpermittedSubadmin.id);
    expect(recipients).not.toContain(plainAgent.id);
  });

  it("does not notify a deactivated admin", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    await seedUser({ role: "admin", isActive: false });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    expect(await Notification.countDocuments({ type: "ticket_created" })).toBe(0);
  });

  it("also notifies admins/permitted subadmins with ticket_auto_assigned when an agent picks it up", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const agent = await seedOnlineAgent();
    const { user: admin } = await seedUser({ role: "admin" });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const adminNotifications = await Notification.find({ recipient: admin._id }).sort({ type: 1 });
    const types = adminNotifications.map((n) => n.type).sort();
    expect(types).toEqual(["ticket_auto_assigned", "ticket_created"]);
    // The agent itself only gets the assignee-facing type, never the oversight one.
    const agentTypes = (await Notification.find({ recipient: agent._id })).map((n) => n.type);
    expect(agentTypes).toEqual(["ticket_assigned"]);
  });

  it("does not send ticket_auto_assigned when no agent is online", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    await seedUser({ role: "admin" });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    expect(await Notification.countDocuments({ type: "ticket_auto_assigned" })).toBe(0);
  });

  it("notifies admins/permitted subadmins with ticket_needs_assignment when no agent is online to auto-assign", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: admin } = await seedUser({ role: "admin" });
    const { user: permittedSubadmin } = await seedUser({ role: "subadmin", permissions: ["tickets:view_all"] });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.assignedAgent).toBeNull();
    const recipients = (await Notification.find({ type: "ticket_needs_assignment" })).map((n) =>
      n.recipient.toString()
    );
    expect(recipients.sort()).toEqual([admin.id, permittedSubadmin.id].sort());
  });

  it("does not send ticket_needs_assignment when an agent was successfully auto-assigned", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    await seedOnlineAgent();
    await seedUser({ role: "admin" });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    expect(await Notification.countDocuments({ type: "ticket_needs_assignment" })).toBe(0);
  });
});

describe("POST /api/v1/tickets — sourceConversation (Story 62)", () => {
  it("persists sourceConversation when it belongs to the caller", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken", sourceConversation: conversation.id });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.sourceConversation?.toString()).toBe(conversation.id);
    // Story 63: accepting the AI's in-chat suggestion is a distinct channel
    // from a plain portal submission, even though both are self-submits.
    expect(ticket!.createdVia).toBe("ai");
  });

  it("returns 403 when sourceConversation belongs to a different customer", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: owner } = await seedUser();
    const { token: otherToken } = await seedUser();
    const conversation = await Conversation.create({ customer: owner._id, status: "ai_handling" });

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ subject: "Help", description: "It's broken", sourceConversation: conversation.id });

    expect(res.status).toBe(403);
    expect(await Ticket.countDocuments()).toBe(0);
  });

  it("returns 400 for a malformed sourceConversation", async () => {
    const { token } = await seedUser();
    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken", sourceConversation: "not-an-object-id" });

    expect(res.status).toBe(400);
  });

  it("still creates a ticket with sourceConversation null when omitted (backward-compat)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { token } = await seedUser();

    const res = await request(app)
      .post("/api/v1/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ subject: "Help", description: "It's broken" });

    expect(res.status).toBe(201);
    const ticket = await Ticket.findById(res.body.id);
    expect(ticket!.sourceConversation).toBeNull();
    expect(ticket!.createdVia).toBe("customer_portal");
  });
});

async function seedTicket(
  overrides: Partial<{
    category: string | null;
    priority: string;
    assignedAgent: mongoose.Types.ObjectId | null;
    status: string;
  }> = {}
) {
  const { user: customer } = await seedUser();
  return Ticket.create({
    subject: "Something is broken",
    description: "Details here",
    customer: customer._id,
    category: overrides.category ?? null,
    priority: overrides.priority ?? "medium",
    assignedAgent: overrides.assignedAgent ?? null,
    status: overrides.status ?? "new",
  });
}

describe("GET /api/v1/tickets/:id (Story 9)", () => {
  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const res = await request(app).get(`/api/v1/tickets/${ticket.id}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 (not 403) for a customer who doesn't own the ticket (Story 60)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "customer" });
    const res = await request(app).get(`/api/v1/tickets/${ticket.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed id", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app).get("/api/v1/tickets/not-an-object-id").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a well-formed but nonexistent id", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app)
      .get(`/api/v1/tickets/${new mongoose.Types.ObjectId().toHexString()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 200 for an agent, with the populated customer name/email", async () => {
    const ticket = await seedTicket();
    const populatedCustomer = await User.findById(ticket.customer);
    const { token } = await seedUser({ role: "agent" });

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: ticket.id,
      subject: ticket.subject,
      customer: { name: populatedCustomer!.name, email: populatedCustomer!.email },
    });
  });

  it("a legacy ticket with no sla.responseTargetAt reads back as slaStatus 'on_track' (Story 26)", async () => {
    const ticket = await seedTicket();
    expect(ticket.sla?.responseTargetAt).toBeUndefined();
    const { token } = await seedUser({ role: "agent" });

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.slaStatus).toBe("on_track");
    expect(res.body.responseTargetAt).toBeNull();
    expect(res.body.resolutionTargetAt).toBeNull();
  });
});

describe("PATCH /api/v1/tickets/:id (Story 9)", () => {
  it("sets category to an existing active category name (case-insensitive input), storing the canonical name", async () => {
    await TicketCategory.create({ name: "Billing", active: true });
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:categorize"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "billing" });

    expect(res.status).toBe(200);
    expect(res.body.category).toBe("Billing");
    const stored = await Ticket.findById(ticket.id);
    expect(stored!.category).toBe("Billing");
  });

  it("clears category when set to null", async () => {
    const ticket = await seedTicket({ category: "Billing" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:categorize"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: null });

    expect(res.status).toBe(200);
    expect(res.body.category).toBeNull();
  });

  it("clears category when set to an empty string", async () => {
    const ticket = await seedTicket({ category: "Billing" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:categorize"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "" });

    expect(res.status).toBe(200);
    expect(res.body.category).toBeNull();
  });

  it("returns 400 for a category name not in the active list (nonexistent)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:categorize"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Nonexistent" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for a category name that exists but is inactive", async () => {
    await TicketCategory.create({ name: "Retired", active: false });
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:categorize"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Retired" });

    expect(res.status).toBe(400);
  });

  it.each(["low", "medium", "high", "urgent"])("returns 200 setting priority to %s", async (priority) => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_priority"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority });

    expect(res.status).toBe(200);
    expect(res.body.priority).toBe(priority);
  });

  it("returns 400 for an invalid priority value", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_priority"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "not-a-priority" });

    expect(res.status).toBe(400);
  });

  it("sets both category and priority together", async () => {
    await TicketCategory.create({ name: "Billing", active: true });
    const ticket = await seedTicket();
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:categorize", "tickets:change_priority"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing", priority: "urgent" });

    expect(res.status).toBe(200);
    expect(res.body.category).toBe("Billing");
    expect(res.body.priority).toBe("urgent");
  });

  it("leaves category untouched when only priority is sent (partial-update regression)", async () => {
    const ticket = await seedTicket({ category: "Billing", priority: "low" });
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:categorize", "tickets:change_priority"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    expect(res.body.category).toBe("Billing");
    expect(res.body.priority).toBe("high");
  });

  it("leaves priority untouched when only category is sent (partial-update regression)", async () => {
    await TicketCategory.create({ name: "Billing", active: true });
    const ticket = await seedTicket({ category: null, priority: "urgent" });
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:categorize", "tickets:change_priority"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing" });

    expect(res.status).toBe(200);
    expect(res.body.category).toBe("Billing");
    expect(res.body.priority).toBe("urgent");
  });

  it("returns 403 when caller lacks tickets:categorize and sends category, even holding tickets:change_priority", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_priority"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing" });

    expect(res.status).toBe(403);
  });

  it("returns 403 when caller lacks tickets:change_priority and sends priority", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:categorize"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });

    expect(res.status).toBe(403);
  });

  it("returns 403 for a customer", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "customer" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });

    expect(res.status).toBe(403);
  });

  it("returns 403 for an agent lacking both keys", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: [] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing" });

    expect(res.status).toBe(403);
  });

  it("returns 404 for a malformed id", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_priority"] });
    const res = await request(app)
      .patch("/api/v1/tickets/not-an-object-id")
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a well-formed but nonexistent id", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_priority"] });
    const res = await request(app)
      .patch(`/api/v1/tickets/${new mongoose.Types.ObjectId().toHexString()}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });
    expect(res.status).toBe(404);
  });

  it("lets an admin change both fields with no explicit permission grant (implicit admin pass)", async () => {
    await TicketCategory.create({ name: "Billing", active: true });
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing", priority: "urgent" });

    expect(res.status).toBe(200);
    expect(res.body.category).toBe("Billing");
    expect(res.body.priority).toBe("urgent");
  });

  it("returns 403 for a deactivated agent holding both keys (isActive re-check)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:categorize", "tickets:change_priority"],
      isActive: false,
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });

    expect(res.status).toBe(403);
  });

  it("appends to categoryHistory and priorityHistory (Story 13 follow-up audit trail)", async () => {
    await TicketCategory.create({ name: "Billing", active: true });
    const ticket = await seedTicket();
    const { user: agent, token } = await seedUser({
      role: "agent",
      permissions: ["tickets:categorize", "tickets:change_priority"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing", priority: "high" });

    expect(res.status).toBe(200);
    const stored = await Ticket.findById(ticket.id);
    expect(stored!.categoryHistory).toHaveLength(1);
    expect(stored!.categoryHistory[0]).toMatchObject({
      category: "Billing",
      changedBy: new mongoose.Types.ObjectId(agent.id),
    });
    expect(stored!.priorityHistory).toHaveLength(1);
    expect(stored!.priorityHistory[0]).toMatchObject({
      priority: "high",
      changedBy: new mongoose.Types.ObjectId(agent.id),
    });
  });
});

// sla-automation gap fix: sla.responseTargetAt/resolutionTargetAt were only
// ever computed once, at POST /tickets creation time — changing priority or
// category afterward via this same PATCH /:id left a ticket running against
// its original (possibly now-wrong) deadlines forever. See sla.service.ts's
// recomputeTicketSla.
describe("PATCH /api/v1/tickets/:id — recomputes SLA targets when priority/category change (sla-automation gap fix)", () => {
  afterEach(async () => {
    // The default (null, null) row seeded in beforeAll must survive; only
    // clear the extra specific rows each test adds.
    await SlaTarget.deleteMany({ $or: [{ priority: { $ne: null } }, { category: { $ne: null } }] });
  });

  // Mongoose's `timestamps: true` makes `createdAt` immutable after insert,
  // so these tests can't force it to a fixed literal — they check the
  // recomputed targets against the ticket's REAL createdAt via arithmetic
  // instead of hardcoded absolute ISO strings.
  async function seedTicketWithSla(overrides: {
    category?: string | null;
    priority?: string;
    responseTargetAt: Date;
    resolutionTargetAt: Date;
    atRiskAlerted?: boolean;
    breached?: boolean;
  }) {
    const ticket = await seedTicket({ category: overrides.category, priority: overrides.priority });
    ticket.sla = {
      responseTargetAt: overrides.responseTargetAt,
      resolutionTargetAt: overrides.resolutionTargetAt,
      breached: overrides.breached ?? false,
      atRiskAlerted: overrides.atRiskAlerted ?? true,
    };
    await ticket.save();
    return ticket;
  }

  it("recomputes responseTargetAt/resolutionTargetAt anchored on the ticket's createdAt when priority changes to a stricter target", async () => {
    await SlaTarget.create({ priority: "high", category: null, responseMinutes: 5, resolutionMinutes: 15 });
    const ticket = await seedTicketWithSla({
      priority: "medium",
      responseTargetAt: new Date(Date.now() + 60 * 60_000),
      resolutionTargetAt: new Date(Date.now() + 480 * 60_000),
    });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_priority"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    expect(new Date(res.body.responseTargetAt).getTime()).toBe(ticket.createdAt.getTime() + 5 * 60_000);
    expect(new Date(res.body.resolutionTargetAt).getTime()).toBe(ticket.createdAt.getTime() + 15 * 60_000);

    const stored = await Ticket.findById(ticket.id);
    expect(stored!.sla.atRiskAlerted).toBe(false);
  });

  it("recomputes SLA targets when only category changes", async () => {
    await TicketCategory.create({ name: "Billing", active: true });
    await SlaTarget.create({ priority: null, category: "Billing", responseMinutes: 20, resolutionMinutes: 90 });
    const ticket = await seedTicketWithSla({
      category: null,
      responseTargetAt: new Date(Date.now() + 60 * 60_000),
      resolutionTargetAt: new Date(Date.now() + 480 * 60_000),
    });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:categorize"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing" });

    expect(res.status).toBe(200);
    expect(new Date(res.body.responseTargetAt).getTime()).toBe(ticket.createdAt.getTime() + 20 * 60_000);
    expect(new Date(res.body.resolutionTargetAt).getTime()).toBe(ticket.createdAt.getTime() + 90 * 60_000);
  });

  it("leaves SLA targets untouched when neither category nor priority is sent (e.g. reassignment-only)", async () => {
    const responseTargetAt = new Date(Date.now() + 60 * 60_000);
    const resolutionTargetAt = new Date(Date.now() + 480 * 60_000);
    const ticket = await seedTicketWithSla({ responseTargetAt, resolutionTargetAt, atRiskAlerted: true });
    const { user: agent } = await seedUser({ role: "agent", isActive: true });
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(200);
    expect(res.body.responseTargetAt).toBe(responseTargetAt.toISOString());
    expect(res.body.resolutionTargetAt).toBe(resolutionTargetAt.toISOString());

    const stored = await Ticket.findById(ticket.id);
    expect(stored!.sla.atRiskAlerted).toBe(true);
  });

  it("does not recompute (and does not un-breach) a ticket whose SLA already breached", async () => {
    await SlaTarget.create({ priority: "high", category: null, responseMinutes: 5, resolutionMinutes: 15 });
    const responseTargetAt = new Date(Date.now() + 60 * 60_000);
    const resolutionTargetAt = new Date(Date.now() + 480 * 60_000);
    const ticket = await seedTicketWithSla({
      priority: "medium",
      responseTargetAt,
      resolutionTargetAt,
      breached: true,
    });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_priority"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    expect(res.body.responseTargetAt).toBe(responseTargetAt.toISOString());
    expect(res.body.resolutionTargetAt).toBe(resolutionTargetAt.toISOString());

    const stored = await Ticket.findById(ticket.id);
    expect(stored!.sla.breached).toBe(true);
  });
});

async function seedActiveAgent(overrides: Partial<{ isOnline: boolean; email: string }> = {}) {
  return User.create({
    name: "Assignable Agent",
    email: overrides.email ?? `assignable-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: "agent",
    isActive: true,
    isOnline: overrides.isOnline ?? false,
  });
}

describe("GET /api/v1/tickets/assignable-agents (Story 25)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/tickets/assignable-agents");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a caller without tickets:reassign", async () => {
    const { token } = await seedUser({ role: "agent", permissions: [] });
    const res = await request(app).get("/api/v1/tickets/assignable-agents").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns only active agents, online and offline alike, sorted by name", async () => {
    await seedActiveAgent({ isOnline: false, email: "zed@example.com" });
    await User.findOneAndUpdate({ email: "zed@example.com" }, { name: "Zed" });
    await seedActiveAgent({ isOnline: true, email: "amy@example.com" });
    await User.findOneAndUpdate({ email: "amy@example.com" }, { name: "Amy" });
    await User.create({
      name: "Inactive Agent",
      email: "inactive@example.com",
      passwordHash: "irrelevant-for-these-tests",
      role: "agent",
      isActive: false,
    });
    await seedUser({ role: "subadmin", email: "sub@example.com" }); // not an agent — must be excluded
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app).get("/api/v1/tickets/assignable-agents").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((a: { name: string }) => a.name)).toEqual(["Amy", "Zed"]);
    expect(res.body.find((a: { name: string; isOnline: boolean }) => a.name === "Amy")!.isOnline).toBe(true);
    expect(res.body.find((a: { name: string; isOnline: boolean }) => a.name === "Zed")!.isOnline).toBe(false);
  });
});

describe("GET /api/v1/tickets/escalation-targets (Story 12)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/tickets/escalation-targets");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a caller without tickets:escalate", async () => {
    const { token } = await seedUser({ role: "agent", permissions: [] });
    const res = await request(app)
      .get("/api/v1/tickets/escalation-targets")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns active agents, admins, and subadmins, excludes the caller and inactive/customer accounts", async () => {
    const { token, user: caller } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    await User.findByIdAndUpdate(caller.id, { name: "Caller" });
    const { user: seniorAgent } = await seedUser({ role: "agent" });
    await User.findByIdAndUpdate(seniorAgent.id, { name: "Senior Agent" });
    const { user: admin } = await seedUser({ role: "admin" });
    await User.findByIdAndUpdate(admin.id, { name: "Admin One" });
    const { user: subadmin } = await seedUser({ role: "subadmin" });
    await User.findByIdAndUpdate(subadmin.id, { name: "Sub One" });
    const { user: inactiveAgent } = await seedUser({ role: "agent", isActive: false });
    await User.findByIdAndUpdate(inactiveAgent.id, { name: "Inactive Agent" });
    await seedUser({ role: "customer" }); // must be excluded

    const res = await request(app)
      .get("/api/v1/tickets/escalation-targets")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.map((u: { name: string }) => u.name).sort();
    expect(names).toEqual(["Admin One", "Senior Agent", "Sub One"]);
    expect(res.body.some((u: { name: string }) => u.name === "Caller")).toBe(false);
  });
});

describe("PATCH /api/v1/tickets/:id — reassignment (Story 25)", () => {
  it("lets an admin reassign to an active but OFFLINE agent", async () => {
    const ticket = await seedTicket();
    const agent = await seedActiveAgent({ isOnline: false });
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(200);
    expect(res.body.assignedAgent).toEqual({ id: agent.id, name: agent.name });
    expect((await Ticket.findById(ticket.id))!.assignedAgent?.toString()).toBe(agent.id);
  });

  it("appends to assignedAgentHistory (Story 13 follow-up audit trail)", async () => {
    const ticket = await seedTicket();
    const agent = await seedActiveAgent({ isOnline: false });
    const { user: admin, token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(200);
    const stored = await Ticket.findById(ticket.id);
    expect(stored!.assignedAgentHistory).toHaveLength(1);
    expect(stored!.assignedAgentHistory[0]).toMatchObject({
      assignedAgent: new mongoose.Types.ObjectId(agent.id),
      changedBy: new mongoose.Types.ObjectId(admin.id),
    });
  });

  it("lets a sub-admin holding tickets:reassign reassign to an OFFLINE agent, same as admin", async () => {
    const ticket = await seedTicket();
    const agent = await seedActiveAgent({ isOnline: false });
    const { token } = await seedUser({ role: "subadmin", permissions: ["tickets:reassign"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(200);
  });

  it("rejects a plain agent (holding tickets:reassign) reassigning to an OFFLINE agent", async () => {
    const ticket = await seedTicket();
    const agent = await seedActiveAgent({ isOnline: false });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reassign"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(400);
    expect((await Ticket.findById(ticket.id))!.assignedAgent).toBeNull();
  });

  it("lets a plain agent (holding tickets:reassign) reassign to an ONLINE agent", async () => {
    const ticket = await seedTicket();
    const agent = await seedActiveAgent({ isOnline: true });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reassign"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(200);
  });

  it("clears assignedAgent when set to null, no online check applies", async () => {
    const agent = await seedActiveAgent({ isOnline: false });
    const ticket = await seedTicket({ assignedAgent: agent._id });
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: null });

    expect(res.status).toBe(200);
    expect(res.body.assignedAgent).toBeNull();
  });

  it("returns 400 for a target that isn't an active agent (wrong role, inactive, or nonexistent)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "admin" });
    const { user: notAnAgent } = await seedUser({ role: "subadmin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: notAnAgent.id });

    expect(res.status).toBe(400);
  });

  it("returns 403 for a caller without tickets:reassign and not admin", async () => {
    const ticket = await seedTicket();
    const agent = await seedActiveAgent({ isOnline: true });
    const { token } = await seedUser({ role: "agent", permissions: [] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(403);
  });

  it("notifies only the new assignee on a first-time assignment (no previous agent)", async () => {
    const ticket = await seedTicket();
    const agent = await seedActiveAgent({ isOnline: true });
    const { token } = await seedUser({ role: "admin" });

    await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    const notifications = await Notification.find({});
    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipient.toString()).toBe(agent.id);
    expect(notifications[0].type).toBe("ticket_reassigned");
  });

  it("notifies both the previous and the new assignee on a real reassignment, each with the correct type", async () => {
    const previousAgent = await seedActiveAgent({ isOnline: true });
    const ticket = await seedTicket({ assignedAgent: previousAgent._id });
    const newAgent = await seedActiveAgent({ isOnline: true });
    const { token } = await seedUser({ role: "admin" });

    await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: newAgent.id });

    const notifications = await Notification.find({});
    const byRecipient = new Map(notifications.map((n) => [n.recipient.toString(), n.type]));
    expect(byRecipient.get(newAgent.id)).toBe("ticket_reassigned");
    expect(byRecipient.get(previousAgent.id)).toBe("ticket_unassigned");
  });

  it("does not notify anyone when reassigning to the already-assigned agent (no-op)", async () => {
    const agent = await seedActiveAgent({ isOnline: true });
    const ticket = await seedTicket({ assignedAgent: agent._id });
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ assignedAgent: agent.id });

    expect(res.status).toBe(200);
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe("PATCH /api/v1/tickets/:id/status (Story 11)", () => {
  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const res = await request(app).patch(`/api/v1/tickets/${ticket.id}/status`).send({ status: "in_progress" });
    expect(res.status).toBe(401);
  });

  it("lets an agent holding tickets:change_status move new -> in_progress", async () => {
    const ticket = await seedTicket();
    const { token, user: agent } = await seedUser({ role: "agent", permissions: ["tickets:change_status"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    const saved = await Ticket.findById(ticket.id);
    expect(saved!.status).toBe("in_progress");
    expect(saved!.statusHistory).toHaveLength(1);
    expect(saved!.statusHistory[0]).toMatchObject({ status: "in_progress", changedBy: new mongoose.Types.ObjectId(agent.id) });
  });

  it("lets a subadmin holding tickets:close_reopen close a ticket", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "subadmin", permissions: ["tickets:close_reopen"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(res.status).toBe(200);
  });

  it("returns 403 for an agent missing tickets:change_status", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: [] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(403);
  });

  it("returns 403 for an agent holding tickets:change_status but not tickets:close_reopen, trying to close", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_status"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(res.status).toBe(403);
  });

  it("lets an agent holding both keys close a ticket", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:change_status", "tickets:close_reopen"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(res.status).toBe(200);
    expect((await Ticket.findById(ticket.id))!.status).toBe("closed");
  });

  it("requires tickets:close_reopen to reopen a closed ticket, even with tickets:change_status granted", async () => {
    const ticket = await seedTicket({ status: "closed" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_status"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(403);
  });

  it("lets an agent holding tickets:close_reopen reopen a closed ticket back to in_progress", async () => {
    const ticket = await seedTicket({ status: "closed" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:close_reopen"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect((await Ticket.findById(ticket.id))!.status).toBe("in_progress");
  });

  // customer-portal Story 37: a customer's one self-service transition —
  // reopening their own closed ticket. No permission grant involved at all.
  it("lets a customer reopen their own closed ticket", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id, { status: "closed" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect((await Ticket.findById(ticket.id))!.status).toBe("in_progress");
  });

  it("returns 403 when a customer tries to reopen a ticket that isn't theirs", async () => {
    const { user: owner } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(owner.id, { status: "closed" });
    const { token } = await seedUser({ role: "customer" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(403);
    expect((await Ticket.findById(ticket.id))!.status).toBe("closed");
  });

  it("returns 403 when a customer tries any transition other than reopening a closed ticket", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id, { status: "new" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(403);
  });

  it("returns 403 when a customer tries to close their own ticket", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id, { status: "new" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(res.status).toBe(403);
  });

  // customer-portal Story 39: closing a ticket triggers the "rate your
  // experience" email.
  it("sends a resolution email when a ticket transitions into closed", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const ticket = await seedTicket({ status: "in_progress" });
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:change_status", "tickets:close_reopen"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining(`/feedback/ticket/${ticket.id}`) })
    );
  });

  it("does not re-send the resolution email for a same-state closed -> closed PATCH", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const ticket = await seedTicket({ status: "closed" });
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:change_status", "tickets:close_reopen"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(res.status).toBe(200);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an illegal transition (closed -> answered)", async () => {
    const ticket = await seedTicket({ status: "closed" });
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:change_status", "tickets:close_reopen"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "answered" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for a request targeting escalated (not a valid manual target)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:change_status", "tickets:close_reopen"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "escalated" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown ticket id", async () => {
    const { token } = await seedUser({
      role: "agent",
      permissions: ["tickets:change_status", "tickets:close_reopen"],
    });

    const res = await request(app)
      .patch(`/api/v1/tickets/${new mongoose.Types.ObjectId()}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(404);
  });

  it("returns 403 for a customer", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "customer" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(403);
  });

  it("lets an admin close and then reopen a ticket with no explicit permission grants (implicit admin pass)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "admin" });

    const closeRes = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });
    expect(closeRes.status).toBe(200);

    const reopenRes = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });
    expect(reopenRes.status).toBe(200);
  });

  it("no-ops on a same-state PATCH: 200, no new statusHistory entry", async () => {
    const ticket = await seedTicket({ status: "in_progress" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_status"] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect((await Ticket.findById(ticket.id))!.statusHistory).toHaveLength(0);
  });

  it("notifies oversight (admin + tickets:view_all subadmin) and the assigned agent on reopen", async () => {
    const agent = await seedActiveAgent();
    const ticket = await seedTicket({ status: "closed", assignedAgent: agent._id });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:close_reopen"] });
    const { user: overseeingAdmin } = await seedUser({ role: "admin" });
    const { user: viewAllSubadmin } = await seedUser({ role: "subadmin", permissions: ["tickets:view_all"] });
    const { user: plainSubadmin } = await seedUser({ role: "subadmin", permissions: [] });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });
    expect(res.status).toBe(200);

    const notifications = await Notification.find({});
    const byRecipient = new Map(notifications.map((n) => [n.recipient.toString(), n.type]));
    expect(byRecipient.get(agent.id)).toBe("ticket_reopened");
    expect(byRecipient.get(overseeingAdmin.id)).toBe("ticket_reopened_oversight");
    expect(byRecipient.get(viewAllSubadmin.id)).toBe("ticket_reopened_oversight");
    expect(byRecipient.has(plainSubadmin.id)).toBe(false);
  });

  it("does not notify anyone for a reopen when the ticket has no assigned agent", async () => {
    const ticket = await seedTicket({ status: "closed" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:close_reopen"] });
    const { user: overseeingAdmin } = await seedUser({ role: "admin" });

    await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    const notifications = await Notification.find({});
    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipient.toString()).toBe(overseeingAdmin.id);
    expect(notifications[0].type).toBe("ticket_reopened_oversight");
  });

  it("does not send reopen notifications for a plain (non-reopen) transition, e.g. new -> in_progress", async () => {
    const agent = await seedActiveAgent();
    const ticket = await seedTicket({ assignedAgent: agent._id });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:change_status"] });
    await seedUser({ role: "admin" });

    await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "in_progress" });

    expect(await Notification.countDocuments()).toBe(0);
  });

  it("does not send reopen notifications when closing a ticket", async () => {
    const agent = await seedActiveAgent();
    const ticket = await seedTicket({ assignedAgent: agent._id });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:close_reopen"] });
    await seedUser({ role: "admin" });

    await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(await Notification.countDocuments()).toBe(0);
  });

  it("does not double-notify on a same-state closed -> closed no-op PATCH", async () => {
    const agent = await seedActiveAgent();
    const ticket = await seedTicket({ status: "closed", assignedAgent: agent._id });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:close_reopen"] });
    await seedUser({ role: "admin" });

    const res = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" });

    expect(res.status).toBe(200);
    expect(await Notification.countDocuments()).toBe(0);
  });
});

describe("POST /api/v1/tickets/:id/escalate (Story 12)", () => {
  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const { user: target } = await seedUser({ role: "admin" });
    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .send({ escalatedTo: target.id });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a caller without tickets:escalate", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: [] });
    const { user: target } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(403);
  });

  it("returns 403 for a customer", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "customer" });
    const { user: target } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(403);
  });

  it("lets an agent holding tickets:escalate escalate to an admin", async () => {
    const ticket = await seedTicket();
    const { token, user: agent } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const { user: target } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("escalated");
    expect(res.body.escalatedTo).toMatchObject({ id: target.id });

    const saved = await Ticket.findById(ticket.id);
    expect(saved!.status).toBe("escalated");
    expect(saved!.escalatedTo?.toString()).toBe(target.id);
    expect(saved!.statusHistory).toHaveLength(1);
    expect(saved!.statusHistory[0]).toMatchObject({
      status: "escalated",
      changedBy: new mongoose.Types.ObjectId(agent.id),
    });
  });

  it("lets an admin escalate with no explicit permission grant (implicit admin pass)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "admin" });
    const { user: target } = await seedUser({ role: "agent" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(200);
  });

  it("notifies the target and oversight admins", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const { user: target } = await seedUser({ role: "agent" });
    const { user: overseeingAdmin } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(200);
    const targetNotifications = await Notification.find({ recipient: target._id, type: "ticket_escalated" });
    expect(targetNotifications).toHaveLength(1);
    const overseerNotifications = await Notification.find({
      recipient: overseeingAdmin._id,
      type: "ticket_escalated",
    });
    expect(overseerNotifications).toHaveLength(1);
  });

  it("returns 400 when the target is a customer", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const { user: target } = await seedUser({ role: "customer" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(400);
  });

  it("returns 400 for self-escalation", async () => {
    const ticket = await seedTicket();
    const { token, user: agent } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: agent.id });

    expect(res.status).toBe(400);
  });

  it("returns 400 when escalatedTo is missing or malformed", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown ticket id", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const { user: target } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${new mongoose.Types.ObjectId()}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(404);
  });

  it("returns 409 when escalating an already-closed ticket", async () => {
    const ticket = await seedTicket({ status: "closed" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const { user: target } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });

    expect(res.status).toBe(409);
  });

  it("is idempotent when re-escalating to the same target: 200, no duplicate notification", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const { user: target } = await seedUser({ role: "agent" });

    const first = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: target.id });
    expect(second.status).toBe(200);

    const notifications = await Notification.find({ recipient: target._id, type: "ticket_escalated" });
    expect(notifications).toHaveLength(1);
  });

  it("returns 409 when re-escalating an already-escalated ticket to a different target", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const { user: firstTarget } = await seedUser({ role: "admin" });
    const { user: secondTarget } = await seedUser({ role: "admin" });

    const first = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: firstTarget.id });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/escalate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ escalatedTo: secondTarget.id });
    expect(second.status).toBe(409);
  });
});

describe("GET /api/v1/tickets/:id/messages (Story 56)", () => {
  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const res = await request(app).get(`/api/v1/tickets/${ticket.id}/messages`);
    expect(res.status).toBe(401);
  });

  it("returns 404 (not 403) for a customer who doesn't own the ticket (Story 60)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "customer" });
    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed or nonexistent ticket id", async () => {
    const { token } = await seedUser({ role: "agent" });
    const malformed = await request(app)
      .get("/api/v1/tickets/not-an-object-id/messages")
      .set("Authorization", `Bearer ${token}`);
    expect(malformed.status).toBe(404);

    const nonexistent = await request(app)
      .get(`/api/v1/tickets/${new mongoose.Types.ObjectId().toHexString()}/messages`)
      .set("Authorization", `Bearer ${token}`);
    expect(nonexistent.status).toBe(404);
  });

  it("returns an empty array for a ticket with no messages", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns messages oldest-first, with populated sender name", async () => {
    const ticket = await seedTicket();
    const { user: agent, token } = await seedUser({ role: "agent", name: "Agent Smith" });
    await Message.create({
      parentType: "ticket",
      parentId: ticket._id,
      senderType: "agent",
      senderId: agent._id,
      text: "first",
      internal: false,
      attachments: [],
      createdAt: new Date(Date.now() - 60_000),
    });
    await Message.create({
      parentType: "ticket",
      parentId: ticket._id,
      senderType: "agent",
      senderId: agent._id,
      text: "second",
      internal: false,
      attachments: [],
    });

    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].text).toBe("first");
    expect(res.body[1].text).toBe("second");
    expect(res.body[0].sender).toEqual({ id: agent.id, name: "Agent Smith" });
  });
});

describe("POST /api/v1/tickets/:id/messages (Story 56)", () => {
  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const res = await request(app).post(`/api/v1/tickets/${ticket.id}/messages`).send({ text: "hi" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a caller lacking tickets:reply", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: [] });
    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hi" });
    expect(res.status).toBe(403);
  });

  it("returns 404 for a malformed or nonexistent ticket id", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });
    const malformed = await request(app)
      .post("/api/v1/tickets/not-an-object-id/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hi" });
    expect(malformed.status).toBe(404);

    const nonexistent = await request(app)
      .post(`/api/v1/tickets/${new mongoose.Types.ObjectId().toHexString()}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hi" });
    expect(nonexistent.status).toBe(404);
  });

  it("returns 400 when text is missing or empty", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });

    const missing = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(missing.status).toBe(400);

    const empty = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "" });
    expect(empty.status).toBe(400);
  });

  it("creates a Message and emails the customer", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const ticket = await seedTicket();
    const customer = await User.findById(ticket.customer);
    const { token, user: agent } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Thanks for reaching out, here's an update." });

    expect(res.status).toBe(201);
    expect(res.body.text).toBe("Thanks for reaching out, here's an update.");
    expect(res.body.senderType).toBe("agent");
    expect(res.body.internal).toBe(false);

    const stored = await Message.findOne({ parentType: "ticket", parentId: ticket._id });
    expect(stored).not.toBeNull();
    expect(stored!.senderId!.toString()).toBe(agent.id);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: customer!.email }));
  });

  it("still creates the Message and returns 201 when the reply email fails to send", async () => {
    vi.spyOn(emailService, "sendEmail").mockRejectedValue(new Error("SMTP down"));
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hi" });

    expect(res.status).toBe(201);
    const stored = await Message.findOne({ parentType: "ticket", parentId: ticket._id });
    expect(stored).not.toBeNull();
  });

  it("flips a New/In Progress ticket to Answered, logged in statusHistory (Story 11)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const ticket = await seedTicket();
    const { token, user: agent } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hi" });

    expect(res.status).toBe(201);
    const stored = await Ticket.findById(ticket.id);
    expect(stored!.status).toBe("answered");
    expect(stored!.statusHistory).toHaveLength(1);
    expect(stored!.statusHistory[0]).toMatchObject({
      status: "answered",
      changedBy: new mongoose.Types.ObjectId(agent.id),
    });
  });

  it("leaves a closed ticket closed", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: customer } = await seedUser();
    const closedTicket = await Ticket.create({
      subject: "Already handled",
      description: "Resolved earlier",
      customer: customer._id,
      status: "closed",
    });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${closedTicket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Following up after closing." });

    expect(res.status).toBe(201);
    const stored = await Ticket.findById(closedTicket.id);
    expect(stored!.status).toBe("closed");
  });

  it("creates a Message with an attachment, stored on disk and downloadable", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .field("text", "See attached.")
      .attach("files", Buffer.from("note contents"), "note.txt");

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].fileName).toBe("note.txt");
    expect(res.body.attachments[0].url).toBe(
      `/api/v1/tickets/${ticket.id}/messages/${res.body.id}/attachments/${res.body.attachments[0].id}`
    );

    const download = await request(app)
      .get(res.body.attachments[0].url)
      .set("Authorization", `Bearer ${token}`);
    expect(download.status).toBe(200);
    expect(download.text).toBe("note contents");
  });

  it("lets an admin reply with no explicit tickets:reply grant (implicit admin pass)", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hi" });

    expect(res.status).toBe(201);
  });

  it("returns 403 for a deactivated agent holding tickets:reply (isActive re-check)", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"], isActive: false });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hi" });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/tickets/:id/messages/:messageId/attachments/:attachmentId (Story 56)", () => {
  it("returns 404 for a malformed or nonexistent ticket/message/attachment id", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent" });

    const malformedTicket = await request(app)
      .get(`/api/v1/tickets/not-an-object-id/messages/${new mongoose.Types.ObjectId().toHexString()}/attachments/${new mongoose.Types.ObjectId().toHexString()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(malformedTicket.status).toBe(404);

    const nonexistentMessage = await request(app)
      .get(
        `/api/v1/tickets/${ticket.id}/messages/${new mongoose.Types.ObjectId().toHexString()}/attachments/${new mongoose.Types.ObjectId().toHexString()}`
      )
      .set("Authorization", `Bearer ${token}`);
    expect(nonexistentMessage.status).toBe(404);
  });

  it("returns 404 for an attachment id that doesn't belong to the message", async () => {
    vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });
    const created = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .field("text", "See attached.")
      .attach("files", Buffer.from("contents"), "file.txt");

    const wrongAttachmentId = await request(app)
      .get(
        `/api/v1/tickets/${ticket.id}/messages/${created.body.id}/attachments/${new mongoose.Types.ObjectId().toHexString()}`
      )
      .set("Authorization", `Bearer ${token}`);
    expect(wrongAttachmentId.status).toBe(404);
  });
});

// Story 60 (merged with customer-portal Story 36, platform Story 59).
async function seedTicketFor(
  customerId: string,
  overrides: Partial<{
    status: string;
    category: string | null;
    priority: string;
    assignedAgent: string;
    subject: string;
  }> = {}
) {
  return Ticket.create({
    subject: overrides.subject ?? "Something is broken",
    description: "Details here",
    customer: customerId,
    status: overrides.status ?? "new",
    category: overrides.category ?? null,
    priority: overrides.priority ?? "medium",
    assignedAgent: overrides.assignedAgent ?? null,
  });
}

describe("GET /api/v1/tickets (Story 60)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/tickets");
    expect(res.status).toBe(401);
  });

  it("scopes a customer to only their own tickets, ignoring a client-supplied customer filter", async () => {
    const { user: customerA, token: tokenA } = await seedUser({ role: "customer" });
    const { user: customerB } = await seedUser({ role: "customer" });
    await seedTicketFor(customerA.id);
    await seedTicketFor(customerA.id);
    await seedTicketFor(customerB.id);

    const res = await request(app)
      .get(`/api/v1/tickets?customer=${customerB.id}`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.tickets).toHaveLength(2);
    for (const row of res.body.tickets) {
      expect(row.customer.id).toBe(customerA.id);
    }
  });

  it("exposes slaStatus/responseTargetAt/resolutionTargetAt per row, 'on_track' for a legacy ticket with no sla (Story 26)", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    await seedTicketFor(customer.id);

    const res = await request(app).get("/api/v1/tickets").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].slaStatus).toBe("on_track");
    expect(res.body.tickets[0].responseTargetAt).toBeNull();
    expect(res.body.tickets[0].resolutionTargetAt).toBeNull();
  });

  it("scopes an agent without tickets:view_all to only their assigned tickets", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { user: agent1, token: token1 } = await seedUser({ role: "agent" });
    const { user: agent2 } = await seedUser({ role: "agent" });
    await seedTicketFor(customer.id, { assignedAgent: agent1.id });
    await seedTicketFor(customer.id, { assignedAgent: agent2.id });

    const res = await request(app).get("/api/v1/tickets").set("Authorization", `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].assignedAgent.id).toBe(agent1.id);
  });

  it("shows every ticket, with assignedAgent populated, for an agent granted tickets:view_all", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { user: agent1 } = await seedUser({ role: "agent" });
    const { user: agent2, token: token2 } = await seedUser({
      role: "agent",
      permissions: ["tickets:view_all"],
    });
    await seedTicketFor(customer.id, { assignedAgent: agent1.id });
    await seedTicketFor(customer.id, { assignedAgent: agent2.id });

    const res = await request(app).get("/api/v1/tickets").set("Authorization", `Bearer ${token2}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it("filters by status, category, and priority (staff caller)", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    await seedTicketFor(customer.id, { status: "new", category: "Billing", priority: "low" });
    await seedTicketFor(customer.id, { status: "closed", category: "Technical", priority: "urgent" });

    const res = await request(app)
      .get("/api/v1/tickets?status=closed&category=Technical&priority=urgent")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].status).toBe("closed");
  });

  it("defaults to a page size of 10", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    for (let i = 0; i < 12; i++) {
      await seedTicketFor(customer.id);
    }

    const res = await request(app).get("/api/v1/tickets").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.tickets).toHaveLength(10);
    expect(res.body.total).toBe(12);
  });

  it("searches by ticket subject", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const matching = await seedTicketFor(customer.id, { subject: "Refund request for order 42" });
    await seedTicketFor(customer.id, { subject: "Cannot log in" });

    const res = await request(app).get("/api/v1/tickets?q=refund").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].id).toBe(matching.id);
  });

  it("searches by customer name, even though the name lives on the referenced User, not the Ticket", async () => {
    const { user: matchingCustomer } = await seedUser({ role: "customer", name: "Priya Sharma" });
    const { user: otherCustomer } = await seedUser({ role: "customer", name: "Jamal Cole" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const matching = await seedTicketFor(matchingCustomer.id);
    await seedTicketFor(otherCustomer.id);

    const res = await request(app).get("/api/v1/tickets?q=priya").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].id).toBe(matching.id);
  });

  it("searches by assigned-agent name", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { user: matchingAgent } = await seedUser({ role: "agent", name: "Dana Osei" });
    const { user: otherAgent } = await seedUser({ role: "agent", name: "Leo Farr" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const matching = await seedTicketFor(customer.id, { assignedAgent: matchingAgent.id });
    await seedTicketFor(customer.id, { assignedAgent: otherAgent.id });

    const res = await request(app).get("/api/v1/tickets?q=osei").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].id).toBe(matching.id);
  });

  it("returns an empty list, not everything, when q matches nothing", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    await seedTicketFor(customer.id, { subject: "Cannot log in" });

    const res = await request(app)
      .get("/api/v1/tickets?q=nonexistent-search-term")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.tickets).toHaveLength(0);
  });

  it("scopes a customer's own search to their tickets' subjects only", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const matching = await seedTicketFor(customer.id, { subject: "Refund request" });
    await seedTicketFor(customer.id, { subject: "Cannot log in" });

    const res = await request(app).get("/api/v1/tickets?q=refund").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].id).toBe(matching.id);
  });

  it("rejects an unsupported sort key with 400", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const res = await request(app).get("/api/v1/tickets?sort=notarealfield").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("filters by createdAt date range (createdFrom/createdTo)", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const oldTicket = await seedTicketFor(customer.id);
    const recentTicket = await seedTicketFor(customer.id);
    await Ticket.collection.updateOne(
      { _id: oldTicket._id },
      { $set: { createdAt: new Date("2020-01-01T00:00:00.000Z") } }
    );

    const res = await request(app)
      .get("/api/v1/tickets?createdFrom=2024-01-01")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].id).toBe(recentTicket.id);
  });

  it("filters by updatedAt date range (updatedFrom/updatedTo), independently of createdAt", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const staleTicket = await seedTicketFor(customer.id);
    const freshTicket = await seedTicketFor(customer.id);
    await Ticket.collection.updateOne(
      { _id: staleTicket._id },
      { $set: { updatedAt: new Date("2020-01-01T00:00:00.000Z") } }
    );

    const res = await request(app)
      .get("/api/v1/tickets?updatedFrom=2024-01-01")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].id).toBe(freshTicket.id);
  });

  it("applies both createdAt and updatedAt ranges together", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const matching = await seedTicketFor(customer.id);
    const wrongCreated = await seedTicketFor(customer.id);
    await Ticket.collection.updateOne(
      { _id: wrongCreated._id },
      { $set: { createdAt: new Date("2020-01-01T00:00:00.000Z") } }
    );

    const res = await request(app)
      .get("/api/v1/tickets?createdFrom=2024-01-01&updatedFrom=2024-01-01")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].id).toBe(matching.id);
  });

  it("scopes date-filtered statusCounts the same way as the list itself", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const oldTicket = await seedTicketFor(customer.id, { status: "closed" });
    await seedTicketFor(customer.id, { status: "new" });
    await Ticket.collection.updateOne(
      { _id: oldTicket._id },
      { $set: { createdAt: new Date("2020-01-01T00:00:00.000Z") } }
    );

    const res = await request(app)
      .get("/api/v1/tickets?createdFrom=2024-01-01")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.statusCounts.closed).toBe(0);
    expect(res.body.statusCounts.new).toBe(1);
  });

  it("returns 400 for a malformed date value", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    const res = await request(app)
      .get("/api/v1/tickets?createdFrom=not-a-date")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("paginates results and reports total/page/limit", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    for (let i = 0; i < 25; i++) {
      await seedTicketFor(customer.id);
    }

    const res = await request(app).get("/api/v1/tickets?page=2&limit=10").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(25);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(10);
    expect(res.body.tickets).toHaveLength(10);
  });

  it("includes a human-friendly TCK-<n> reference on each row", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    await seedTicketFor(customer.id);

    const res = await request(app).get("/api/v1/tickets").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.tickets[0].reference).toMatch(/^TCK-\d+$/);
  });

  it("lets a customer filter their own list by status", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    await seedTicketFor(customer.id, { status: "new" });
    await seedTicketFor(customer.id, { status: "closed" });

    const res = await request(app)
      .get("/api/v1/tickets?status=closed")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].status).toBe("closed");
  });

  it("filters the staff queue by createdVia (Story 63)", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    await Ticket.create({
      subject: "Self-submitted",
      description: "D",
      customer: customer._id,
      createdBy: customer._id,
      createdVia: "customer_portal",
    });
    await Ticket.create({
      subject: "Reported by phone",
      description: "D",
      customer: customer._id,
      createdBy: customer._id,
      createdVia: "phone",
    });

    const res = await request(app).get("/api/v1/tickets?createdVia=phone").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.tickets[0].subject).toBe("Reported by phone");
  });

  it("reports statusCounts scoped by category/priority but not narrowed by the selected status (Plan 29 chips)", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:view_all"] });
    await seedTicketFor(customer.id, { status: "new", category: "Billing" });
    await seedTicketFor(customer.id, { status: "new", category: "Billing" });
    await seedTicketFor(customer.id, { status: "closed", category: "Billing" });
    await seedTicketFor(customer.id, { status: "closed", category: "Technical" });

    const res = await request(app)
      .get("/api/v1/tickets?category=Billing&status=new")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // The list itself is still narrowed by status=new...
    expect(res.body.total).toBe(2);
    // ...but statusCounts reflects every status under category=Billing alone.
    expect(res.body.statusCounts).toEqual({ new: 2, in_progress: 0, answered: 0, escalated: 0, closed: 1 });
  });

  it("scopes statusCounts to only an agent's own tickets when they lack tickets:view_all", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const { user: agent1, token: token1 } = await seedUser({ role: "agent" });
    const { user: agent2 } = await seedUser({ role: "agent" });
    await seedTicketFor(customer.id, { status: "new", assignedAgent: agent1.id });
    await seedTicketFor(customer.id, { status: "closed", assignedAgent: agent2.id });

    const res = await request(app).get("/api/v1/tickets").set("Authorization", `Bearer ${token1}`);

    expect(res.status).toBe(200);
    expect(res.body.statusCounts).toEqual({ new: 1, in_progress: 0, answered: 0, escalated: 0, closed: 0 });
  });

  it("omits statusCounts on the customer branch", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    await seedTicketFor(customer.id, { status: "new" });

    const res = await request(app).get("/api/v1/tickets").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.statusCounts).toBeUndefined();
  });
});

describe("GET /api/v1/tickets/:id — customer ownership branch (Story 60)", () => {
  it("lets a customer read their own ticket", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id);

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ticket.id);
    expect(res.body.reference).toMatch(/^TCK-\d+$/);
  });
});

describe("GET /api/v1/tickets/:id/messages — customer ownership + internal filtering (Story 60)", () => {
  it("excludes internal: true messages for a customer, but an agent still sees them", async () => {
    const { user: customer, token: customerToken } = await seedUser({ role: "customer" });
    const { user: agent, token: agentToken } = await seedUser({ role: "agent" });
    const ticket = await seedTicketFor(customer.id);
    await Message.create({
      parentType: "ticket",
      parentId: ticket._id,
      senderType: "agent",
      senderId: agent._id,
      text: "public reply",
      internal: false,
    });
    await Message.create({
      parentType: "ticket",
      parentId: ticket._id,
      senderType: "agent",
      senderId: agent._id,
      text: "internal note, staff only",
      internal: true,
    });

    const customerRes = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${customerToken}`);
    expect(customerRes.status).toBe(200);
    expect(customerRes.body).toHaveLength(1);
    expect(customerRes.body[0].text).toBe("public reply");

    const agentRes = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(agentRes.status).toBe(200);
    expect(agentRes.body).toHaveLength(2);
  });
});

describe("GET /api/v1/tickets/internal-note-taggables (agent-workspace Story 24)", () => {
  it("returns 403 for a caller without tickets:post_internal_note", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:escalate"] });
    const res = await request(app)
      .get("/api/v1/tickets/internal-note-taggables")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns active staff sorted by name, excluding the caller, customers, and deactivated accounts", async () => {
    const { user: caller, token } = await seedUser({
      role: "agent",
      name: "Aaa Caller",
      permissions: ["tickets:post_internal_note"],
    });
    const { user: zed } = await seedUser({ role: "subadmin", name: "Zed Subadmin" });
    const { user: bob } = await seedUser({ role: "admin", name: "Bob Admin" });
    await seedUser({ role: "agent", name: "Ghost Agent", isActive: false });
    await seedUser({ role: "customer", name: "Cust Omer" });

    const res = await request(app)
      .get("/api/v1/tickets/internal-note-taggables")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((u: { id: string }) => u.id)).toEqual([bob.id, zed.id]);
    expect(res.body.map((u: { id: string }) => u.id)).not.toContain(caller.id);
    expect(res.body[0]).toMatchObject({ name: "Bob Admin", role: "admin" });
  });
});

describe("POST /api/v1/tickets/:id/internal-notes (agent-workspace Story 24)", () => {
  const NOTE_PERMS = ["tickets:post_internal_note"];

  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const res = await request(app).post(`/api/v1/tickets/${ticket.id}/internal-notes`).send({ text: "psst" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a customer — even the customer who created the ticket", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id);

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "let me in" });

    expect(res.status).toBe(403);
    expect(await Message.countDocuments({ parentId: ticket._id })).toBe(0);
  });

  it("returns 403 for an agent without tickets:post_internal_note", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["tickets:reply"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "note" });

    expect(res.status).toBe(403);
  });

  it("returns 404 for a malformed or nonexistent ticket id", async () => {
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });

    const malformed = await request(app)
      .post("/api/v1/tickets/not-an-id/internal-notes")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "note" });
    expect(malformed.status).toBe(404);

    const missing = await request(app)
      .post(`/api/v1/tickets/${new mongoose.Types.ObjectId().toHexString()}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "note" });
    expect(missing.status).toBe(404);
  });

  it("returns 400 for empty/whitespace-only text", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "   " });

    expect(res.status).toBe(400);
  });

  it("creates an internal: true agent message with no tags and no notifications", async () => {
    const ticket = await seedTicket();
    const { user: agent, token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Checked the logs, nothing obvious." });

    expect(res.status).toBe(201);
    expect(res.body.internal).toBe(true);
    expect(res.body.senderType).toBe("agent");
    expect(res.body.taggedUsers).toEqual([]);

    const stored = await Message.findById(res.body.id);
    expect(stored!.internal).toBe(true);
    expect(stored!.senderId!.toString()).toBe(agent.id);
    expect(await Notification.countDocuments({ type: "ticket_internal_note_mention" })).toBe(0);
  });

  it("lets an admin post with no explicit grant (implicit admin pass) and does not flip the ticket to answered", async () => {
    const ticket = await seedTicket({ status: "new" });
    const { token } = await seedUser({ role: "admin" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Taking a look." });

    expect(res.status).toBe(201);
    const reloaded = await Ticket.findById(ticket.id);
    expect(reloaded!.status).toBe("new");
  });

  it("notifies exactly one tagged colleague each, and neither the author nor the customer", async () => {
    const { user: customer } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id);
    const { user: author, token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });
    const { user: colleague } = await seedUser({ role: "agent", name: "Colleague" });
    const { user: boss } = await seedUser({ role: "admin", name: "Boss" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Second opinion?", taggedUserIds: [colleague.id, boss.id] });

    expect(res.status).toBe(201);
    expect(res.body.taggedUsers).toHaveLength(2);
    expect(res.body.taggedUsers.map((u: { id: string }) => u.id).sort()).toEqual([colleague.id, boss.id].sort());

    const notifications = await Notification.find({ type: "ticket_internal_note_mention" });
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.ticketId!.toString() === ticket.id)).toBe(true);
    const recipients = notifications.map((n) => n.recipient.toString()).sort();
    expect(recipients).toEqual([colleague.id, boss.id].sort());
    expect(recipients).not.toContain(author.id);
    expect(recipients).not.toContain(customer.id);

    // Persisted on the Message, not only echoed in the 201 — so the thread
    // still renders mention chips after a reload.
    const stored = await Message.findById(res.body.id);
    expect(stored!.taggedUserIds.map((id) => id.toString()).sort()).toEqual([colleague.id, boss.id].sort());

    const reread = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${token}`);
    expect(reread.status).toBe(200);
    expect(reread.body[0].taggedUsers.map((u: { name: string }) => u.name).sort()).toEqual(["Boss", "Colleague"]);
    expect(reread.body[0].taggedUsers.map((u: { role: string }) => u.role).sort()).toEqual(["admin", "agent"]);
  });

  it("dedupes a repeated id into a single notification", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });
    const { user: colleague } = await seedUser({ role: "agent" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Double-tagged", taggedUserIds: [colleague.id, colleague.id] });

    expect(res.status).toBe(201);
    expect(res.body.taggedUsers).toHaveLength(1);
    expect(await Notification.countDocuments({ type: "ticket_internal_note_mention" })).toBe(1);
  });

  it("silently drops the author's own id — 201, one fewer notification, no error", async () => {
    const ticket = await seedTicket();
    const { user: author, token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });
    const { user: colleague } = await seedUser({ role: "agent" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Note to self and one other", taggedUserIds: [author.id, colleague.id] });

    expect(res.status).toBe(201);
    expect(res.body.taggedUsers.map((u: { id: string }) => u.id)).toEqual([colleague.id]);
    const notifications = await Notification.find({ type: "ticket_internal_note_mention" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].recipient.toString()).toBe(colleague.id);
  });

  it("returns 400 with a per-id reason for a non-existent tagged id", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });
    const ghostId = new mongoose.Types.ObjectId().toHexString();

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "who?", taggedUserIds: [ghostId] });

    expect(res.status).toBe(400);
    expect(res.body.taggedUserIdErrors[ghostId]).toBeTruthy();
    expect(await Message.countDocuments({ parentId: ticket._id })).toBe(0);
  });

  it("returns 400 when a customer's id is tagged", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });
    const { user: customer } = await seedUser({ role: "customer" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "leak attempt", taggedUserIds: [customer.id] });

    expect(res.status).toBe(400);
    expect(res.body.taggedUserIdErrors[customer.id]).toBeTruthy();
    expect(await Notification.countDocuments({ type: "ticket_internal_note_mention" })).toBe(0);
  });

  it("returns 400 when a deactivated staff account is tagged", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });
    const { user: retired } = await seedUser({ role: "agent", isActive: false });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "still around?", taggedUserIds: [retired.id] });

    expect(res.status).toBe(400);
    expect(res.body.taggedUserIdErrors[retired.id]).toBeTruthy();
  });

  it("returns 400 for a malformed (non-ObjectId) tagged id, before any DB write", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "bad id", taggedUserIds: ["not-an-object-id"] });

    expect(res.status).toBe(400);
    expect(await Message.countDocuments({ parentId: ticket._id })).toBe(0);
  });

  it("returns 400 when more than 20 colleagues are tagged", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: NOTE_PERMS });
    const ids = Array.from({ length: 21 }, () => new mongoose.Types.ObjectId().toHexString());

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "spam", taggedUserIds: ids });

    expect(res.status).toBe(400);
  });

  // The hard privacy boundary this whole story hinges on.
  it("hides the posted note from the ticket's own customer on every customer-reachable read", async () => {
    const { user: customer, token: customerToken } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id);
    const { token: agentToken } = await seedUser({ role: "agent", permissions: NOTE_PERMS });

    const posted = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/internal-notes`)
      .set("Authorization", `Bearer ${agentToken}`)
      .send({ text: "SECRET-INTERNAL-NOTE" });
    expect(posted.status).toBe(201);

    const customerMessages = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${customerToken}`);
    expect(customerMessages.status).toBe(200);
    expect(customerMessages.body).toHaveLength(0);
    expect(JSON.stringify(customerMessages.body)).not.toContain("SECRET-INTERNAL-NOTE");

    const customerHistory = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/history`)
      .set("Authorization", `Bearer ${customerToken}`);
    expect(customerHistory.status).toBe(200);
    expect(
      customerHistory.body.events.some((e: { kind: string }) => e.kind === "internal_note_added")
    ).toBe(false);

    // ...while staff still see it on both surfaces.
    const agentMessages = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(agentMessages.body).toHaveLength(1);
    expect(agentMessages.body[0].internal).toBe(true);

    const agentHistory = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/history`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(agentHistory.body.events.some((e: { kind: string }) => e.kind === "internal_note_added")).toBe(true);
  });

  it("omits the `internal` flag entirely from a customer-facing message DTO", async () => {
    const { user: customer, token: customerToken } = await seedUser({ role: "customer" });
    const ticket = await seedTicketFor(customer.id);
    const { user: agent } = await seedUser({ role: "agent" });
    await Message.create({
      parentType: "ticket",
      parentId: ticket._id,
      senderType: "agent",
      senderId: agent._id,
      text: "public reply",
      internal: false,
    });

    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${customerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).not.toHaveProperty("internal");
  });
});

describe("GET /api/v1/tickets/:id/history (Story 13)", () => {
  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const res = await request(app).get(`/api/v1/tickets/${ticket.id}/history`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a malformed id", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app)
      .get("/api/v1/tickets/not-an-object-id/history")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns 200 for the assigned agent, with events in the response body", async () => {
    const { user: agent, token } = await seedUser({ role: "agent" });
    const ticket = await seedTicket({ assignedAgent: agent._id });

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}/history`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ticketId).toBe(ticket.id);
    expect(res.body.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "created" })])
    );
  });

  it("returns 200 for a sub-admin viewing an unassigned ticket", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "subadmin" });

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}/history`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("returns 404 (not 403) for a different customer's ticket", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "customer" });

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}/history`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("does not include internal_note_added events when the customer views their own ticket", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const { user: agent } = await seedUser({ role: "agent" });
    const ticket = await seedTicketFor(customer.id);
    await Message.create({
      parentType: "ticket",
      parentId: ticket._id,
      senderType: "agent",
      senderId: agent._id,
      text: "internal note",
      internal: true,
    });

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}/history`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events.some((e: { kind: string }) => e.kind === "internal_note_added")).toBe(false);
  });

  it("includes category_changed, priority_changed, and assignee_changed events end-to-end through PATCH /:id (Story 13 follow-up)", async () => {
    await TicketCategory.create({ name: "Billing", active: true });
    const ticket = await seedTicket();
    const agentTarget = await seedActiveAgent({ isOnline: false });
    const { token } = await seedUser({
      role: "admin",
    });

    const patchRes = await request(app)
      .patch(`/api/v1/tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Billing", priority: "high", assignedAgent: agentTarget.id });
    expect(patchRes.status).toBe(200);

    const res = await request(app).get(`/api/v1/tickets/${ticket.id}/history`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const kinds = res.body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["category_changed", "priority_changed", "assignee_changed"])
    );
    const assigneeEvent = res.body.events.find((e: { kind: string }) => e.kind === "assignee_changed");
    expect(assigneeEvent.data.to).toMatchObject({ id: agentTarget.id, name: agentTarget.name });
  });
});

describe("GET /api/v1/tickets/:id/history/export (Story 13)", () => {
  it("returns 200 with a JSON attachment for a sub-admin holding tickets:export_history", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "subadmin", permissions: ["tickets:export_history"] });

    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/history/export`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(`ticket-${ticket.ticketNumber}-history.json`);
    const body = JSON.parse(res.text);
    expect(body.ticket.id).toBe(ticket.id);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("returns 403 for an agent without tickets:export_history, even the assigned agent", async () => {
    const { user: agent, token } = await seedUser({ role: "agent" });
    const ticket = await seedTicket({ assignedAgent: agent._id });

    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/history/export`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("returns 403 for a customer", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "customer" });

    const res = await request(app)
      .get(`/api/v1/tickets/${ticket.id}/history/export`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ai-features Story 32: one-click AI summary. summary.service.ts's own unit
// tests (summary.service.test.ts) cover the prompt/transcript logic — these
// only cover the route's auth/permission/status-mapping contract, so
// summarizeTicket is stubbed at the module level throughout.
describe("POST /api/v1/tickets/:id/summarize (ai-features Story 32)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without a token", async () => {
    const ticket = await seedTicket();
    const res = await request(app).post(`/api/v1/tickets/${ticket.id}/summarize`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for an agent without ai:summarize", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: [] });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("returns 403 for a customer, even the ticket's own customer", async () => {
    const { user: customer, token } = await seedUser({ role: "customer" });
    const ticket = await Ticket.create({
      subject: "Something is broken",
      description: "Details here",
      customer: customer._id,
    });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing ticket", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });

    const res = await request(app)
      .post(`/api/v1/tickets/${new mongoose.Types.ObjectId()}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed id", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });

    const res = await request(app)
      .post("/api/v1/tickets/not-an-object-id/summarize")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("returns 409 when the service reports not_enough_messages", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeTicket").mockResolvedValue({
      ok: false,
      reason: "not_enough_messages",
    });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_enough_messages");
  });

  it("returns 404 when the service reports not_found", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeTicket").mockResolvedValue({ ok: false, reason: "not_found" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 503 when the service reports ai_unavailable", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeTicket").mockResolvedValue({ ok: false, reason: "ai_unavailable" });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("ai_unavailable");
  });

  it("returns 200 with the summary on success", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeTicket").mockResolvedValue({ ok: true, summary: "Issue: ..." });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: "Issue: ..." });
  });

  it("succeeds for a sub-admin holding ai:summarize", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "subadmin", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeTicket").mockResolvedValue({ ok: true, summary: "Issue: ..." });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("succeeds for an admin without an explicit permission grant", async () => {
    const ticket = await seedTicket();
    const { token } = await seedUser({ role: "admin" });
    vi.spyOn(summaryService, "summarizeTicket").mockResolvedValue({ ok: true, summary: "Issue: ..." });

    const res = await request(app)
      .post(`/api/v1/tickets/${ticket.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});
