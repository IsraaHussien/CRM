import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { buildTicketReport, buildTicketReportCsv } from "../../src/services/ticketReport.service";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("ticket-report-service-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Ticket.deleteMany({});
});

async function seedCustomer() {
  return User.create({
    name: "Test Customer",
    email: `customer-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: "customer",
  });
}

async function seedTicket(overrides: {
  createdAt: Date;
  category?: string | null;
  createdVia?: "customer_portal" | "ai" | "phone" | "email" | "in_person" | "other" | null;
  customer: mongoose.Types.ObjectId;
}) {
  const ticket = await Ticket.create({
    subject: "Something is broken",
    description: "Details here",
    customer: overrides.customer,
    category: overrides.category ?? null,
    createdVia: overrides.createdVia ?? null,
  });
  // Mongoose's timestamps:true strips a user-supplied createdAt on create();
  // backdate it directly on the raw collection, same technique used by
  // slaMonitor.service.test.ts's setTicketSlaWindow.
  await Ticket.collection.updateOne({ _id: ticket._id }, { $set: { createdAt: overrides.createdAt } });
  return ticket;
}

describe("buildTicketReport", () => {
  it("returns zeroed totals and empty breakdowns for an empty window", async () => {
    const report = await buildTicketReport({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-08T00:00:00.000Z"),
      grouping: "day",
    });
    expect(report.totals.count).toBe(0);
    expect(report.byCategory).toEqual([]);
    expect(report.bySource).toEqual([]);
    // Trend is still zero-filled across the whole window, not empty.
    expect(report.trend).toHaveLength(7);
    expect(report.trend.every((p) => p.count === 0)).toBe(true);
  });

  it("aggregates volume, category, and source across a seeded window with zero-fill", async () => {
    const customer = await seedCustomer();
    await seedTicket({ createdAt: new Date("2026-02-01T10:00:00.000Z"), category: "Billing", createdVia: "customer_portal", customer: customer._id });
    await seedTicket({ createdAt: new Date("2026-02-01T14:00:00.000Z"), category: "Billing", createdVia: "phone", customer: customer._id });
    await seedTicket({ createdAt: new Date("2026-02-03T09:00:00.000Z"), category: null, createdVia: null, customer: customer._id });
    // Outside the window — must not be counted.
    await seedTicket({ createdAt: new Date("2026-01-15T09:00:00.000Z"), category: "Billing", createdVia: "email", customer: customer._id });

    const report = await buildTicketReport({
      from: new Date("2026-02-01T00:00:00.000Z"),
      to: new Date("2026-02-05T00:00:00.000Z"),
      grouping: "day",
    });

    expect(report.totals.count).toBe(3);
    expect(report.trend).toHaveLength(4);
    expect(report.trend.find((p) => p.bucket === "2026-02-01")?.count).toBe(2);
    expect(report.trend.find((p) => p.bucket === "2026-02-02")?.count).toBe(0);
    expect(report.trend.find((p) => p.bucket === "2026-02-03")?.count).toBe(1);

    const billing = report.byCategory.find((c) => c.category === "Billing");
    expect(billing?.count).toBe(2);
    const uncategorized = report.byCategory.find((c) => c.category === null);
    expect(uncategorized?.count).toBe(1);

    const portal = report.bySource.find((s) => s.createdVia === "customer_portal");
    expect(portal?.count).toBe(1);
    const legacyNullSource = report.bySource.find((s) => s.createdVia === null);
    expect(legacyNullSource?.count).toBe(1);
  });

  it("narrows to the selected categories only", async () => {
    const customer = await seedCustomer();
    await seedTicket({ createdAt: new Date("2026-03-01T00:00:00.000Z"), category: "Billing", customer: customer._id });
    await seedTicket({ createdAt: new Date("2026-03-01T00:00:00.000Z"), category: "Technical Issue", customer: customer._id });

    const report = await buildTicketReport({
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-02T00:00:00.000Z"),
      grouping: "day",
      categories: ["Billing"],
    });

    expect(report.totals.count).toBe(1);
    expect(report.byCategory).toEqual([{ category: "Billing", count: 1 }]);
  });

  it("groups by month when grouping=month", async () => {
    const customer = await seedCustomer();
    await seedTicket({ createdAt: new Date("2026-01-15T00:00:00.000Z"), customer: customer._id });
    await seedTicket({ createdAt: new Date("2026-02-10T00:00:00.000Z"), customer: customer._id });

    const report = await buildTicketReport({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-03-01T00:00:00.000Z"),
      grouping: "month",
    });

    expect(report.trend.map((p) => p.bucket)).toEqual(["2026-01", "2026-02"]);
    expect(report.trend[0].count).toBe(1);
    expect(report.trend[1].count).toBe(1);
  });
});

describe("buildTicketReportCsv", () => {
  it("emits three sections with a leading BOM and escapes commas", () => {
    const csv = buildTicketReportCsv({
      totals: { count: 1 },
      trend: [{ bucket: "2026-01-01", count: 1 }],
      byCategory: [{ category: "Billing, Refunds", count: 1 }],
      bySource: [{ createdVia: "phone", count: 1 }],
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("Volume\nperiod,count\n2026-01-01,1");
    expect(csv).toContain('"Billing, Refunds",1');
    expect(csv).toContain("BySource\nsource,count\nphone,1");
  });
});
