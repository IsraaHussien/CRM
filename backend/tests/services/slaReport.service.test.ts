import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { Conversation } from "../../src/models/Conversation";
import { buildSlaReport } from "../../src/services/slaReport.service";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sla-report-service-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Ticket.deleteMany({});
  await Conversation.deleteMany({});
});

async function seedUser(overrides: Partial<{ role: string; name: string }> = {}) {
  return User.create({
    name: overrides.name ?? "Test User",
    email: `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "customer",
  });
}

async function seedTicket(overrides: {
  createdAt: Date;
  assignedAgent?: mongoose.Types.ObjectId | null;
  category?: string | null;
  priority?: "low" | "medium" | "high" | "urgent";
  breached?: boolean;
  breachAt?: Date;
  customer: mongoose.Types.ObjectId;
}) {
  const ticket = await Ticket.create({
    subject: "Something is broken",
    description: "Details here",
    customer: overrides.customer,
    assignedAgent: overrides.assignedAgent ?? null,
    category: overrides.category ?? null,
    priority: overrides.priority ?? "medium",
    sla: { breached: overrides.breached ?? false, atRiskAlerted: false },
    slaHistory: overrides.breached && overrides.breachAt ? [{ event: "breached", at: overrides.breachAt }] : [],
  });
  await Ticket.collection.updateOne({ _id: ticket._id }, { $set: { createdAt: overrides.createdAt } });
  return ticket;
}

async function seedConversation(overrides: {
  createdAt: Date;
  assignedAgent?: mongoose.Types.ObjectId | null;
  breached?: boolean;
  customer: mongoose.Types.ObjectId;
}) {
  const conversation = await Conversation.create({
    customer: overrides.customer,
    assignedAgent: overrides.assignedAgent ?? null,
    sla: { breached: overrides.breached ?? false, atRiskAlerted: false },
  });
  await Conversation.collection.updateOne({ _id: conversation._id }, { $set: { createdAt: overrides.createdAt } });
  return conversation;
}

describe("buildSlaReport", () => {
  it("returns zeroed totals for an empty window (both scopes)", async () => {
    const report = await buildSlaReport({ from: new Date("2026-01-01T00:00:00.000Z"), to: new Date("2026-01-02T00:00:00.000Z"), scope: "all" });
    expect(report.tickets?.total).toBe(0);
    expect(report.tickets?.complianceRate).toBeNull();
    expect(report.conversations?.total).toBe(0);
  });

  it("computes ticket compliance, agent/category/priority breakdowns, and an event-based breach trend", async () => {
    const customer = await seedUser({ role: "customer" });
    const agent = await seedUser({ role: "agent", name: "Fatima Noor" });

    await seedTicket({ createdAt: new Date("2026-02-01T08:00:00.000Z"), assignedAgent: agent._id, category: "Billing", priority: "urgent", breached: true, breachAt: new Date("2026-02-03T08:00:00.000Z"), customer: customer._id });
    await seedTicket({ createdAt: new Date("2026-02-01T09:00:00.000Z"), assignedAgent: agent._id, category: "Billing", priority: "low", breached: false, customer: customer._id });
    await seedTicket({ createdAt: new Date("2026-02-02T09:00:00.000Z"), assignedAgent: null, category: null, priority: "medium", breached: false, customer: customer._id });

    const report = await buildSlaReport({ from: new Date("2026-02-01T00:00:00.000Z"), to: new Date("2026-02-05T00:00:00.000Z"), scope: "tickets" });

    expect(report.tickets?.total).toBe(3);
    expect(report.tickets?.breached).toBe(1);
    expect(report.tickets?.complianceRate).toBeCloseTo(2 / 3);
    expect(report.conversations).toBeNull();

    const agentRow = report.tickets?.byAgent.find((r) => r.label === "Fatima Noor");
    expect(agentRow).toMatchObject({ total: 2, breached: 1 });
    const unassignedRow = report.tickets?.byAgent.find((r) => r.key === "__unassigned__");
    expect(unassignedRow).toMatchObject({ total: 1, breached: 0 });

    const billingRow = report.tickets?.byCategory?.find((r) => r.key === "Billing");
    expect(billingRow).toMatchObject({ total: 2, breached: 1 });

    const urgentRow = report.tickets?.byPriority?.find((r) => r.key === "urgent");
    expect(urgentRow).toMatchObject({ total: 1, breached: 1 });

    // Breach EVENT happened on 2026-02-03, two days after creation — the
    // trend must key off the event date, not the ticket's creation date.
    const trendDay = report.tickets?.trend.find((p) => p.bucket === "2026-02-03");
    expect(trendDay?.breaches).toBe(1);
    const creationDay = report.tickets?.trend.find((p) => p.bucket === "2026-02-01");
    expect(creationDay?.breaches).toBe(0);
  });

  it("computes conversation compliance with a creation-day snapshot trend, independent of ticket scope", async () => {
    const customer = await seedUser({ role: "customer" });
    const agent = await seedUser({ role: "agent", name: "Omar Saleh" });
    await seedConversation({ createdAt: new Date("2026-02-01T08:00:00.000Z"), assignedAgent: agent._id, breached: true, customer: customer._id });
    await seedConversation({ createdAt: new Date("2026-02-01T09:00:00.000Z"), assignedAgent: agent._id, breached: false, customer: customer._id });

    const report = await buildSlaReport({ from: new Date("2026-02-01T00:00:00.000Z"), to: new Date("2026-02-02T00:00:00.000Z"), scope: "conversations" });

    expect(report.tickets).toBeNull();
    expect(report.conversations?.total).toBe(2);
    expect(report.conversations?.breached).toBe(1);
    expect(report.conversations?.trend.find((p) => p.bucket === "2026-02-01")?.breaches).toBe(1);
  });
});
