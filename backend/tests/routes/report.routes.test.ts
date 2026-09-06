import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { Conversation } from "../../src/models/Conversation";

const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("report-routes-test"));
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

function tokenFor(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET as string);
}

async function seedUser(overrides: Partial<{ role: string; isActive: boolean; permissions: string[] }> = {}) {
  const user = await User.create({
    name: "Test User",
    email: `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "customer",
    isActive: overrides.isActive ?? true,
    permissions: overrides.permissions ?? [],
  });
  return { user, token: tokenFor({ id: user.id, role: user.role }) };
}

describe("GET /api/v1/reports/tickets (Story 40)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/reports/tickets");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a customer, and for an agent without reports:view", async () => {
    const { token: customerToken } = await seedUser({ role: "customer" });
    expect((await request(app).get("/api/v1/reports/tickets").set("Authorization", `Bearer ${customerToken}`)).status).toBe(403);

    const { token: agentToken } = await seedUser({ role: "agent", permissions: [] });
    expect((await request(app).get("/api/v1/reports/tickets").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
  });

  it("returns 403 for a deactivated admin", async () => {
    const { token } = await seedUser({ role: "admin", isActive: false });
    const res = await request(app).get("/api/v1/reports/tickets").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 200 for an admin, and for an agent granted reports:view", async () => {
    const { token: adminToken } = await seedUser({ role: "admin" });
    const resAdmin = await request(app).get("/api/v1/reports/tickets").set("Authorization", `Bearer ${adminToken}`);
    expect(resAdmin.status).toBe(200);
    expect(resAdmin.body.totals.count).toBe(0);

    const { token: agentToken } = await seedUser({ role: "agent", permissions: ["reports:view"] });
    const resAgent = await request(app).get("/api/v1/reports/tickets").set("Authorization", `Bearer ${agentToken}`);
    expect(resAgent.status).toBe(200);
  });

  it("returns 400 for an invalid date range", async () => {
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app)
      .get("/api/v1/reports/tickets")
      .query({ from: "2026-03-01", to: "2026-01-01" })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("export.csv requires reports:export specifically — reports:view alone is not enough", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["reports:view"] });
    const res = await request(app).get("/api/v1/reports/tickets/export.csv").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("export.csv returns a CSV attachment for an admin", async () => {
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app).get("/api/v1/reports/tickets/export.csv").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.text).toContain("Volume");
  });
});

describe("GET /api/v1/reports/sla (Story 41)", () => {
  it("returns 401 without a token and 403 for a customer", async () => {
    expect((await request(app).get("/api/v1/reports/sla")).status).toBe(401);
    const { token } = await seedUser({ role: "customer" });
    expect((await request(app).get("/api/v1/reports/sla").set("Authorization", `Bearer ${token}`)).status).toBe(403);
  });

  it("returns 403 for a deactivated admin", async () => {
    const { token } = await seedUser({ role: "admin", isActive: false });
    const res = await request(app).get("/api/v1/reports/sla").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns 200 for an admin with both tickets and conversations sections by default", async () => {
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app).get("/api/v1/reports/sla").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tickets).not.toBeNull();
    expect(res.body.conversations).not.toBeNull();
  });

  it("scope=tickets omits the conversations section entirely", async () => {
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app).get("/api/v1/reports/sla").query({ scope: "tickets" }).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toBeNull();
  });

  it("returns 400 when the window exceeds 366 days", async () => {
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app)
      .get("/api/v1/reports/sla")
      .query({ from: "2025-01-01", to: "2026-06-01" })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
