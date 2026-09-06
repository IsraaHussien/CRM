import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { Conversation } from "../../src/models/Conversation";
import { Notification } from "../../src/models/Notification";
import * as slaSystemSettingsModule from "../../src/models/SlaSystemSettings";
import * as notificationService from "../../src/services/notification.service";
import * as ticketEscalationService from "../../src/services/ticketEscalation.service";
import * as conversationEscalationService from "../../src/services/conversationEscalation.service";
import { AuditLog } from "../../src/models/AuditLog";
import { scanSlaOnce, closeAbandonedConversationsOnce } from "../../src/services/slaMonitor.service";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sla-monitor-service-test"));
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
  await AuditLog.deleteMany({});
  vi.restoreAllMocks();
});

async function seedUser(overrides: Partial<{ role: string; isActive: boolean; isDeleted: boolean }> = {}) {
  return User.create({
    name: "Test User",
    email: `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "agent",
    isActive: overrides.isActive ?? true,
    isDeleted: overrides.isDeleted ?? false,
  });
}

async function seedTicket(overrides: Partial<{ status: string; assignedAgent: mongoose.Types.ObjectId }> = {}) {
  const customer = await seedUser({ role: "customer" });
  return Ticket.create({
    subject: "Something is broken",
    description: "Details here",
    customer: customer._id,
    status: overrides.status ?? "new",
    assignedAgent: overrides.assignedAgent ?? null,
  });
}

// Directly sets the timer fields a real request would compute via
// sla.service.ts's resolveTicketSlaTargets — bypassing that indirection so
// each test can pin an exact elapsed%/breach state.
// Uses the raw collection, not the Mongoose model — Mongoose's
// `timestamps: true` schema option silently strips any user-supplied
// `createdAt` from a query-based update (updateOne/findOneAndUpdate) to
// protect the original creation time, so Ticket.updateOne({...createdAt})
// would be a no-op here.
async function setTicketSlaWindow(
  ticketId: mongoose.Types.ObjectId,
  fields: {
    createdAt: Date;
    responseTargetAt: Date;
    resolutionTargetAt?: Date;
    breached?: boolean;
    atRiskAlerted?: boolean;
  }
) {
  await Ticket.collection.updateOne(
    { _id: ticketId },
    {
      $set: {
        createdAt: fields.createdAt,
        "sla.responseTargetAt": fields.responseTargetAt,
        "sla.resolutionTargetAt": fields.resolutionTargetAt ?? fields.responseTargetAt,
        "sla.breached": fields.breached ?? false,
        "sla.atRiskAlerted": fields.atRiskAlerted ?? false,
      },
    }
  );
}

async function seedConversation(overrides: Partial<{ status: string; assignedAgent: mongoose.Types.ObjectId }> = {}) {
  const customer = await seedUser({ role: "customer" });
  return Conversation.create({
    customer: customer._id,
    status: overrides.status ?? "ai_handling",
    assignedAgent: overrides.assignedAgent ?? null,
  });
}

async function setConversationSlaWindow(
  conversationId: mongoose.Types.ObjectId,
  fields: { createdAt: Date; responseTargetAt: Date; breached?: boolean; atRiskAlerted?: boolean }
) {
  await Conversation.collection.updateOne(
    { _id: conversationId },
    {
      $set: {
        createdAt: fields.createdAt,
        "sla.responseTargetAt": fields.responseTargetAt,
        "sla.breached": fields.breached ?? false,
        "sla.atRiskAlerted": fields.atRiskAlerted ?? false,
      },
    }
  );
}

const MIN = 60_000;

describe("scanSlaOnce (sla-automation Story 28)", () => {
  it("does nothing for a ticket at 50% elapsed (below the default 75% at-risk threshold)", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const agent = await seedUser({ role: "agent" });
    const ticket = await seedTicket({ assignedAgent: agent._id });
    await setTicketSlaWindow(ticket._id, {
      createdAt: new Date(now.getTime() - 30 * MIN),
      responseTargetAt: new Date(now.getTime() + 30 * MIN), // 60min window, 30min elapsed = 50%
      resolutionTargetAt: new Date(now.getTime() + 480 * MIN),
    });

    const result = await scanSlaOnce(now);

    expect(result).toEqual({ ticketsAtRisk: 0, ticketsBreached: 0, conversationsAtRisk: 0, conversationsBreached: 0 });
    expect((await Ticket.findById(ticket._id))!.sla.atRiskAlerted).toBe(false);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it("fires sla_at_risk and flips atRiskAlerted once elapsed crosses 75%, notifying the assignee", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const agent = await seedUser({ role: "agent" });
    const ticket = await seedTicket({ assignedAgent: agent._id });
    await setTicketSlaWindow(ticket._id, {
      createdAt: new Date(now.getTime() - 45 * MIN),
      responseTargetAt: new Date(now.getTime() + 15 * MIN), // 60min window, 45min elapsed = 75%
      resolutionTargetAt: new Date(now.getTime() + 480 * MIN),
    });

    const result = await scanSlaOnce(now);

    expect(result.ticketsAtRisk).toBe(1);
    const updated = await Ticket.findById(ticket._id);
    expect(updated!.sla.atRiskAlerted).toBe(true);
    expect(updated!.slaHistory).toHaveLength(1);
    expect(updated!.slaHistory[0]).toMatchObject({ event: "at_risk" });

    const notifications = await Notification.find({ recipient: agent._id, type: "sla_at_risk" });
    expect(notifications).toHaveLength(1);
  });

  it("does not send a duplicate at-risk notification on a second tick for the same ticket", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const agent = await seedUser({ role: "agent" });
    const ticket = await seedTicket({ assignedAgent: agent._id });
    await setTicketSlaWindow(ticket._id, {
      createdAt: new Date(now.getTime() - 45 * MIN),
      responseTargetAt: new Date(now.getTime() + 15 * MIN),
      resolutionTargetAt: new Date(now.getTime() + 480 * MIN),
    });

    await scanSlaOnce(now);
    const second = await scanSlaOnce(new Date(now.getTime() + MIN));

    expect(second.ticketsAtRisk).toBe(0);
    expect(await Notification.countDocuments({ type: "sla_at_risk" })).toBe(1);
  });

  it("on breach: flips sla.breached, appends slaHistory, notifies assignee + oversight, and escalates with reason sla_breach", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const agent = await seedUser({ role: "agent" });
    const admin1 = await seedUser({ role: "admin" });
    const admin2 = await seedUser({ role: "admin" });
    const ticket = await seedTicket({ assignedAgent: agent._id });
    await setTicketSlaWindow(ticket._id, {
      createdAt: new Date(now.getTime() - 120 * MIN),
      responseTargetAt: new Date(now.getTime() - MIN), // already past
      resolutionTargetAt: new Date(now.getTime() + 480 * MIN),
    });

    const oversightSpy = vi.spyOn(notificationService, "notifyTicketOversight");
    const escalateSpy = vi.spyOn(ticketEscalationService, "escalateTicket");

    const result = await scanSlaOnce(now);

    expect(result.ticketsBreached).toBe(1);
    const updated = await Ticket.findById(ticket._id);
    expect(updated!.sla.breached).toBe(true);
    expect(updated!.slaHistory).toHaveLength(1);
    expect(updated!.slaHistory[0]).toMatchObject({ event: "breached" });

    const assigneeNotifications = await Notification.find({ recipient: agent._id, type: "sla_breached" });
    expect(assigneeNotifications).toHaveLength(1);

    expect(oversightSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "sla_breached", ticketId: ticket._id }));
    expect(escalateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "sla_breach", changedBy: expect.anything() })
    );
    const [admin1Id, admin2Id] = [admin1._id.toString(), admin2._id.toString()];
    const call = escalateSpy.mock.calls[0][0];
    expect([admin1Id, admin2Id]).toContain(call.escalatedToUserId.toString());
    expect(updated!.status).toBe("escalated");
  });

  it("uses the mocked atRiskPercent from getSlaSystemSettings, not a hardcoded 75", async () => {
    vi.spyOn(slaSystemSettingsModule, "getSlaSystemSettings").mockResolvedValue({
      atRiskPercent: 50,
      scanIntervalMinutes: 5,
    });

    const now = new Date("2026-01-01T12:00:00Z");
    const agent = await seedUser({ role: "agent" });
    const ticket = await seedTicket({ assignedAgent: agent._id });
    // 60% elapsed — below the real default (75%) but above the mocked (50%).
    await setTicketSlaWindow(ticket._id, {
      createdAt: new Date(now.getTime() - 36 * MIN),
      responseTargetAt: new Date(now.getTime() + 24 * MIN),
      resolutionTargetAt: new Date(now.getTime() + 480 * MIN),
    });

    const result = await scanSlaOnce(now);

    expect(result.ticketsAtRisk).toBe(1);
  });

  it("skips escalation (but still flips sla.breached) when no admin/subadmin pair is available", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const agent = await seedUser({ role: "agent" }); // only one non-admin staff user exists
    const ticket = await seedTicket({ assignedAgent: agent._id });
    await setTicketSlaWindow(ticket._id, {
      createdAt: new Date(now.getTime() - 120 * MIN),
      responseTargetAt: new Date(now.getTime() - MIN),
      resolutionTargetAt: new Date(now.getTime() + 480 * MIN),
    });
    const escalateSpy = vi.spyOn(ticketEscalationService, "escalateTicket");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await scanSlaOnce(now);

    expect(result.ticketsBreached).toBe(1);
    expect((await Ticket.findById(ticket._id))!.sla.breached).toBe(true);
    expect(escalateSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no admin/subadmin pair available"));
  });

  it("skips a ticket with no configured SLA targets — no side effects", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const ticket = await seedTicket(); // sla.responseTargetAt/resolutionTargetAt left unset

    const result = await scanSlaOnce(now);

    expect(result).toEqual({ ticketsAtRisk: 0, ticketsBreached: 0, conversationsAtRisk: 0, conversationsBreached: 0 });
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it("skips tickets in status closed or escalated even with an overdue target", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const closed = await seedTicket({ status: "closed" });
    const escalated = await seedTicket({ status: "escalated" });
    for (const t of [closed, escalated]) {
      await setTicketSlaWindow(t._id, {
        createdAt: new Date(now.getTime() - 120 * MIN),
        responseTargetAt: new Date(now.getTime() - MIN),
      });
    }

    const result = await scanSlaOnce(now);

    expect(result.ticketsBreached).toBe(0);
    expect((await Ticket.findById(closed._id))!.sla.breached).toBe(false);
    expect((await Ticket.findById(escalated._id))!.sla.breached).toBe(false);
  });

  it("on conversation breach: flips sla.breached and calls escalateConversation with reason sla_breach", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const agent = await seedUser({ role: "agent" });
    const conversation = await seedConversation({ status: "ai_handling", assignedAgent: agent._id });
    await setConversationSlaWindow(conversation._id, {
      createdAt: new Date(now.getTime() - 120 * MIN),
      responseTargetAt: new Date(now.getTime() - MIN),
    });
    const escalateSpy = vi.spyOn(conversationEscalationService, "escalateConversation");

    const result = await scanSlaOnce(now);

    expect(result.conversationsBreached).toBe(1);
    expect((await Conversation.findById(conversation._id))!.sla.breached).toBe(true);
    expect(escalateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "sla_breach" })
    );
    expect(await Notification.findOne({ recipient: agent._id, type: "sla_breached" })).not.toBeNull();
  });

  it("never rejects, and one ticket throwing mid-processing does not block the next ticket", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const agent1 = await seedUser({ role: "agent" });
    const agent2 = await seedUser({ role: "agent" });
    const badTicket = await seedTicket({ assignedAgent: agent1._id });
    const goodTicket = await seedTicket({ assignedAgent: agent2._id });
    for (const t of [badTicket, goodTicket]) {
      await setTicketSlaWindow(t._id, {
        createdAt: new Date(now.getTime() - 120 * MIN),
        responseTargetAt: new Date(now.getTime() - MIN),
      });
    }

    const originalNotifyOversight = notificationService.notifyTicketOversight;
    vi.spyOn(notificationService, "notifyTicketOversight").mockImplementation(async (params) => {
      if (String(params.ticketId) === badTicket.id) {
        throw new Error("injected failure");
      }
      return originalNotifyOversight(params);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(scanSlaOnce(now)).resolves.toBeDefined();

    // badTicket's notifyTicketOversight call threw, so its own outcome
    // wasn't counted — but goodTicket, processed in the same tick, still
    // completed fully despite that.
    expect((await Ticket.findById(goodTicket._id))!.sla.breached).toBe(true);
    expect(await Notification.findOne({ recipient: agent2._id, type: "sla_breached" })).not.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});

// Mongoose's `timestamps: true` strips a user-supplied `updatedAt` from a
// query-based update, same reasoning as setTicketSlaWindow/
// setConversationSlaWindow above using the raw collection for `createdAt`.
async function backdateConversationUpdatedAt(conversationId: mongoose.Types.ObjectId, updatedAt: Date) {
  await Conversation.collection.updateOne({ _id: conversationId }, { $set: { updatedAt } });
}

describe("closeAbandonedConversationsOnce (live-chat)", () => {
  it("resolves a conversation idle past the abandonment threshold and logs chat_closed", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const conversation = await seedConversation({ status: "ai_handling" });
    await backdateConversationUpdatedAt(conversation._id, new Date(now.getTime() - 31 * MIN));

    const closed = await closeAbandonedConversationsOnce(now);

    expect(closed).toBe(1);
    expect((await Conversation.findById(conversation._id))!.status).toBe("resolved");
    const entry = await AuditLog.findOne({ action: "chat_closed", targetId: conversation.id });
    expect(entry).not.toBeNull();
    expect(entry!.metadata.reason).toBe("abandoned");
  });

  it("leaves a conversation alone before the threshold and once already resolved", async () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const recent = await seedConversation({ status: "escalated" });
    await backdateConversationUpdatedAt(recent._id, new Date(now.getTime() - 5 * MIN));
    const alreadyResolved = await seedConversation({ status: "resolved" });
    await backdateConversationUpdatedAt(alreadyResolved._id, new Date(now.getTime() - 60 * MIN));

    const closed = await closeAbandonedConversationsOnce(now);

    expect(closed).toBe(0);
    expect((await Conversation.findById(recent._id))!.status).toBe("escalated");
    expect((await Conversation.findById(alreadyResolved._id))!.status).toBe("resolved");
    expect(await AuditLog.countDocuments({ action: "chat_closed" })).toBe(0);
  });
});
