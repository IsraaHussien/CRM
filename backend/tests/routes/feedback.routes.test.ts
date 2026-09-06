import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { Conversation } from "../../src/models/Conversation";
import { Feedback } from "../../src/models/Feedback";

const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("feedback-routes-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Ticket.deleteMany({});
  await Conversation.deleteMany({});
  await Feedback.deleteMany({});
});

function tokenFor(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET as string);
}

async function seedUser(overrides: Partial<{ role: string; email: string }> = {}) {
  const user = await User.create({
    name: "Test User",
    email: overrides.email ?? `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "customer",
  });
  return { user, token: tokenFor({ id: user.id, role: user.role }) };
}

async function seedTicket(customerId: string, status = "closed") {
  return Ticket.create({ subject: "Broken thing", description: "Details", customer: customerId, status });
}

async function seedConversation(customerId: string, status = "resolved") {
  return Conversation.create({ customer: customerId, status });
}

describe("GET /api/v1/feedback/:parentType/:parentId", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/feedback/ticket/000000000000000000000000");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-customer", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app)
      .get("/api/v1/feedback/ticket/000000000000000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns eligible: false and feedback: null for an open ticket", async () => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "new");

    const res = await request(app)
      .get(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: false, feedback: null });
  });

  it("returns eligible: true for a closed ticket", async () => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "closed");

    const res = await request(app)
      .get(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(res.body.feedback).toBeNull();
  });

  it("returns 404 for a ticket that belongs to a different customer", async () => {
    const { user: owner } = await seedUser();
    const ticket = await seedTicket(owner.id, "closed");
    const { token } = await seedUser();

    const res = await request(app)
      .get(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown ticket id", async () => {
    const { token } = await seedUser();
    const res = await request(app)
      .get(`/api/v1/feedback/ticket/${new mongoose.Types.ObjectId()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns eligible: true for a resolved conversation", async () => {
    const { user: customer, token } = await seedUser();
    const conversation = await seedConversation(customer.id, "resolved");

    const res = await request(app)
      .get(`/api/v1/feedback/conversation/${conversation.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });

  it("returns eligible: false for an active conversation", async () => {
    const { user: customer, token } = await seedUser();
    const conversation = await seedConversation(customer.id, "ai_handling");

    const res = await request(app)
      .get(`/api/v1/feedback/conversation/${conversation.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
  });

  it("returns the existing feedback once submitted", async () => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "closed");
    await Feedback.create({ parentType: "ticket", parentId: ticket._id, customer: customer._id, rating: 4, comment: "Great" });

    const res = await request(app)
      .get(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.feedback).toMatchObject({ rating: 4, comment: "Great" });
  });
});

describe("POST /api/v1/feedback/:parentType/:parentId", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/v1/feedback/ticket/000000000000000000000000").send({ rating: 5 });
    expect(res.status).toBe(401);
  });

  it("creates a feedback row for a closed ticket owned by the caller", async () => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "closed");

    const res = await request(app)
      .post(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating: 5, comment: "Great support" });

    expect(res.status).toBe(201);
    const saved = await Feedback.findOne({ parentType: "ticket", parentId: ticket._id });
    expect(saved).toMatchObject({ rating: 5, comment: "Great support" });
    expect(saved!.customer.toString()).toBe(customer.id);
  });

  it("returns 409 on a second submission for the same item", async () => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "closed");

    await request(app)
      .post(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating: 5 });

    const res = await request(app)
      .post(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating: 2 });

    expect(res.status).toBe(409);
    expect(await Feedback.countDocuments({ parentType: "ticket", parentId: ticket._id })).toBe(1);
  });

  it("returns 403 for a ticket that isn't closed yet", async () => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "new");

    const res = await request(app)
      .post(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating: 5 });

    expect(res.status).toBe(403);
  });

  it("returns 404 for a ticket that isn't the caller's own", async () => {
    const { user: owner } = await seedUser();
    const ticket = await seedTicket(owner.id, "closed");
    const { token } = await seedUser();

    const res = await request(app)
      .post(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating: 5 });

    expect(res.status).toBe(404);
  });

  it.each([0, 6])("returns 400 for an out-of-range rating (%i)", async (rating) => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "closed");

    const res = await request(app)
      .post(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating });

    expect(res.status).toBe(400);
  });

  it("returns 400 for a comment over 1000 characters", async () => {
    const { user: customer, token } = await seedUser();
    const ticket = await seedTicket(customer.id, "closed");

    const res = await request(app)
      .post(`/api/v1/feedback/ticket/${ticket.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating: 5, comment: "x".repeat(1001) });

    expect(res.status).toBe(400);
  });

  it("creates a feedback row for a resolved conversation owned by the caller", async () => {
    const { user: customer, token } = await seedUser();
    const conversation = await seedConversation(customer.id, "resolved");

    const res = await request(app)
      .post(`/api/v1/feedback/conversation/${conversation.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ rating: 3 });

    expect(res.status).toBe(201);
    expect(await Feedback.countDocuments({ parentType: "conversation", parentId: conversation._id })).toBe(1);
  });
});
