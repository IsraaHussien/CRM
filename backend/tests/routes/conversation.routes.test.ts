import request from "supertest";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User";
import { Conversation } from "../../src/models/Conversation";
import { Message } from "../../src/models/Message";
import { SlaTarget } from "../../src/models/SlaTarget";
import { AuditLog } from "../../src/models/AuditLog";
import * as summaryService from "../../src/services/summary.service";

const app = createApp();
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("conversation-routes-test"));
  // sla-automation Story 26: Conversation.create now resolves SLA targets on
  // every creation, which requires the mandatory default SlaTarget row to
  // exist. Seeded once here (not cleared by beforeEach below) so every
  // existing conversation-creation test keeps working unmodified.
  await SlaTarget.create({ priority: null, category: null, responseMinutes: 60, resolutionMinutes: 480 });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Conversation.deleteMany({});
  await Message.deleteMany({});
  await AuditLog.deleteMany({});
});

function tokenFor(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET as string);
}

async function seedUser(overrides: Partial<{ role: string; email: string; name: string; permissions: string[] }> = {}) {
  const user = await User.create({
    name: overrides.name ?? "Test Customer",
    email: overrides.email ?? `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: overrides.role ?? "customer",
    permissions: overrides.permissions ?? [],
  });
  return { user, token: tokenFor({ id: user.id, role: user.role }) };
}

describe("POST /api/v1/conversations (Story 14)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).post("/api/v1/conversations").send({});
    expect(res.status).toBe(401);
  });

  it("returns 403 for an agent", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
  });

  it("returns 403 for an admin", async () => {
    const { token } = await seedUser({ role: "admin" });
    const res = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
  });

  it("creates a Conversation for a customer and returns 201", async () => {
    const { user, token } = await seedUser();
    const res = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});

    expect(res.status).toBe(201);
    expect(res.body.conversation.customer).toBe(user.id);
    expect(res.body.conversation.status).toBe("ai_handling");
    expect(res.body.conversation.assignedAgent).toBeNull();

    expect(await Conversation.countDocuments()).toBe(1);
  });

  it("populates sla.responseTargetAt on creation (Story 26)", async () => {
    const { token } = await seedUser();
    const res = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});

    expect(res.status).toBe(201);
    const stored = await Conversation.findById(res.body.conversation._id);
    expect(stored!.sla.responseTargetAt).toBeInstanceOf(Date);
    expect(stored!.sla.responseTargetAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("resumes the customer's existing non-resolved conversation instead of creating a new one", async () => {
    const { user, token } = await seedUser();
    const first = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});
    expect(first.status).toBe(201);

    await Message.create({
      parentType: "conversation",
      parentId: first.body.conversation._id,
      senderType: "customer",
      senderId: user.id,
      text: "hello",
    });

    const second = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});

    expect(second.status).toBe(200);
    expect(second.body.conversation._id).toBe(first.body.conversation._id);
    expect(second.body.messages).toHaveLength(1);
    expect(second.body.messages[0].text).toBe("hello");
    // Only one Conversation and one chat_started audit entry across both calls.
    expect(await Conversation.countDocuments()).toBe(1);
    expect(await AuditLog.countDocuments({ action: "chat_started" })).toBe(1);
  });

  it("creates a fresh conversation once the previous one is resolved", async () => {
    const { token } = await seedUser();
    const first = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});
    await Conversation.findByIdAndUpdate(first.body.conversation._id, { status: "resolved" });

    const second = await request(app).post("/api/v1/conversations").set("Authorization", `Bearer ${token}`).send({});

    expect(second.status).toBe(201);
    expect(second.body.conversation._id).not.toBe(first.body.conversation._id);
    expect(await Conversation.countDocuments()).toBe(2);
    expect(await AuditLog.countDocuments({ action: "chat_started" })).toBe(2);
  });

  it("returns 404 for POST /:id/escalate — escalation is socket-only (Story 16)", async () => {
    const { token } = await seedUser();
    const res = await request(app)
      .post("/api/v1/conversations/abc/escalate")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/conversations/active (live-chat)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/conversations/active");
    expect(res.status).toBe(401);
  });

  it("returns null when the customer has no conversation at all", async () => {
    const { token } = await seedUser();
    const res = await request(app).get("/api/v1/conversations/active").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation).toBeNull();
    expect(res.body.messages).toEqual([]);
  });

  it("returns null for an existing conversation that has zero messages — an untouched chat must not resume", async () => {
    const { user, token } = await seedUser();
    await Conversation.create({ customer: user._id, status: "ai_handling" });

    const res = await request(app).get("/api/v1/conversations/active").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation).toBeNull();
  });

  it("returns the conversation and its messages once it has at least one", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    await Message.create({
      parentType: "conversation",
      parentId: conversation._id,
      senderType: "customer",
      senderId: user.id,
      text: "hello",
    });

    const res = await request(app).get("/api/v1/conversations/active").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation._id).toBe(conversation.id);
    expect(res.body.messages).toHaveLength(1);
  });

  it("returns null once the conversation is resolved", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "resolved" });
    await Message.create({
      parentType: "conversation",
      parentId: conversation._id,
      senderType: "customer",
      senderId: user.id,
      text: "hello",
    });

    const res = await request(app).get("/api/v1/conversations/active").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation).toBeNull();
  });

  it("returns 403 for a non-customer", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app).get("/api/v1/conversations/active").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/conversations (Story 18)", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/v1/conversations");
    expect(res.status).toBe(401);
  });

  // customer-portal Story 37: a customer now gets their own scoped list here
  // instead of a 403 — see the customer-branch tests at the end of this
  // describe block for the actual scoping behaviour.
  it("returns 200 with an empty list for a customer with no conversations", async () => {
    const { token } = await seedUser();
    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([]);
  });

  it("returns 403 for an agent without chats:manage", async () => {
    const { token } = await seedUser({ role: "agent" });
    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("scopes an agent's list to conversations they're handling plus unclaimed ones — never another agent's claimed chat", async () => {
    const { user: customer } = await seedUser();
    const { user: agent, token: agentToken } = await seedUser({ role: "agent", permissions: ["chats:manage"] });
    const { user: otherAgent } = await seedUser({ role: "agent", permissions: ["chats:manage"] });
    const mine = await Conversation.create({ customer: customer._id, assignedAgent: agent._id, status: "with_agent" });
    const unclaimed = await Conversation.create({ customer: customer._id, assignedAgent: null, status: "escalated" });
    await Conversation.create({ customer: customer._id, assignedAgent: otherAgent._id, status: "with_agent" });
    await Conversation.create({ customer: customer._id, assignedAgent: agent._id, status: "resolved" });

    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
    const ids = res.body.conversations.map((c: { _id: string }) => c._id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(unclaimed.id);
  });

  it("returns every active conversation for an admin, regardless of assignment", async () => {
    const { user: customer } = await seedUser();
    const { user: agentA } = await seedUser({ role: "agent" });
    const { user: agentB } = await seedUser({ role: "agent" });
    const { token: adminToken } = await seedUser({ role: "admin" });
    await Conversation.create({ customer: customer._id, assignedAgent: agentA._id, status: "with_agent" });
    await Conversation.create({ customer: customer._id, assignedAgent: agentB._id, status: "escalated" });
    await Conversation.create({ customer: customer._id, assignedAgent: agentA._id, status: "resolved" });

    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
  });

  it("exposes slaStatus/responseTargetAt per row, 'on_track' for a legacy conversation with no sla (Story 26)", async () => {
    const { user: customer } = await seedUser();
    const { token: adminToken } = await seedUser({ role: "admin" });
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });
    expect(conversation.sla?.responseTargetAt).toBeUndefined();

    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].slaStatus).toBe("on_track");
    expect(res.body.conversations[0].responseTargetAt).toBeNull();
  });

  // customer-portal Story 37: unlike the staff branches above, a customer's
  // own list has no status restriction — ai_handling/resolved conversations
  // must show up too, not just escalated/with_agent.
  it("scopes a customer's list to their own conversations, any status, and excludes other customers'", async () => {
    const { user: customer, token } = await seedUser();
    const { user: otherCustomer } = await seedUser();
    const mineActive = await Conversation.create({ customer: customer._id, status: "ai_handling" });
    const mineResolved = await Conversation.create({ customer: customer._id, status: "resolved" });
    await Conversation.create({ customer: otherCustomer._id, status: "with_agent" });

    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
    const ids = res.body.conversations.map((c: { _id: string }) => c._id);
    expect(ids).toContain(mineActive.id);
    expect(ids).toContain(mineResolved.id);
  });
});

describe("GET /api/v1/conversations/:id (Story 18)", () => {
  it("returns 401 without a token", async () => {
    const conversation = await Conversation.create({ customer: new mongoose.Types.ObjectId() });
    const res = await request(app).get(`/api/v1/conversations/${conversation.id}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a malformed id and for an unknown id", async () => {
    const { token } = await seedUser({ role: "admin" });
    const resMalformed = await request(app)
      .get("/api/v1/conversations/not-an-object-id")
      .set("Authorization", `Bearer ${token}`);
    expect(resMalformed.status).toBe(404);

    const resUnknown = await request(app)
      .get(`/api/v1/conversations/${new mongoose.Types.ObjectId()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(resUnknown.status).toBe(404);
  });

  it("lets the assigned agent view the transcript including AI messages", async () => {
    const { user: customer } = await seedUser();
    const { user: agent, token: agentToken } = await seedUser({ role: "agent" });
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    await Message.create({ parentType: "conversation", parentId: conversation._id, senderType: "customer", senderId: customer._id, text: "hi" });
    await Message.create({ parentType: "conversation", parentId: conversation._id, senderType: "ai", senderId: null, text: "AI reply" });

    const res = await request(app)
      .get(`/api/v1/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation._id).toBe(conversation.id);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages.map((m: { senderType: string }) => m.senderType)).toEqual(["customer", "ai"]);
  });

  it("lets the owning customer view their own conversation", async () => {
    const { user: customer, token: customerToken } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "ai_handling" });

    const res = await request(app)
      .get(`/api/v1/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
  });

  it("exposes slaStatus/responseTargetAt, 'on_track' for a legacy conversation with no sla (Story 26)", async () => {
    const { user: customer, token: customerToken } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "ai_handling" });
    expect(conversation.sla?.responseTargetAt).toBeUndefined();

    const res = await request(app)
      .get(`/api/v1/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${customerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.conversation.slaStatus).toBe("on_track");
    expect(res.body.conversation.responseTargetAt).toBeNull();
  });

  it("lets an admin view any conversation regardless of assignment", async () => {
    const { user: customer } = await seedUser();
    const { user: agent } = await seedUser({ role: "agent" });
    const { token: adminToken } = await seedUser({ role: "admin" });
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });

    const res = await request(app)
      .get(`/api/v1/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects an unassigned agent with 403", async () => {
    const { user: customer } = await seedUser();
    const { user: assignedAgent } = await seedUser({ role: "agent" });
    const { token: otherAgentToken } = await seedUser({ role: "agent" });
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: assignedAgent._id,
      status: "with_agent",
    });

    const res = await request(app)
      .get(`/api/v1/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${otherAgentToken}`);
    expect(res.status).toBe(403);
  });

  it("rejects a foreign customer with 403", async () => {
    const { user: owner } = await seedUser();
    const { token: otherCustomerToken } = await seedUser();
    const conversation = await Conversation.create({ customer: owner._id, status: "ai_handling" });

    const res = await request(app)
      .get(`/api/v1/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${otherCustomerToken}`);
    expect(res.status).toBe(403);
  });

  it("stays readable after close (resolved) for the customer, the assigned agent, and an admin (Story 19)", async () => {
    const { user: customer, token: customerToken } = await seedUser();
    const { user: agent, token: agentToken } = await seedUser({ role: "agent" });
    const { token: adminToken } = await seedUser({ role: "admin" });
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "resolved",
    });

    for (const token of [customerToken, agentToken, adminToken]) {
      const res = await request(app)
        .get(`/api/v1/conversations/${conversation.id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.conversation.status).toBe("resolved");
    }
  });
});

// ai-features Story 32: same 401/403/404/409/503/200 contract as
// ticket.routes.test.ts's POST /:id/summarize block — summarizeConversation
// is stubbed at the module level; summary.service.test.ts covers its own logic.
describe("POST /api/v1/conversations/:id/summarize (ai-features Story 32)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 without a token", async () => {
    const conversation = await Conversation.create({ customer: new mongoose.Types.ObjectId() });
    const res = await request(app).post(`/api/v1/conversations/${conversation.id}/summarize`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for an agent without ai:summarize", async () => {
    const { user: customer } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "with_agent" });
    const { token } = await seedUser({ role: "agent", permissions: [] });

    const res = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("returns 403 for the conversation's own customer — agent-only feature", async () => {
    const { user: customer, token } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "with_agent" });

    const res = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing conversation", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });

    const res = await request(app)
      .post(`/api/v1/conversations/${new mongoose.Types.ObjectId()}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed id", async () => {
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });

    const res = await request(app)
      .post("/api/v1/conversations/not-an-object-id/summarize")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("returns 409 when the service reports not_enough_messages", async () => {
    const { user: customer } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "with_agent" });
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeConversation").mockResolvedValue({
      ok: false,
      reason: "not_enough_messages",
    });

    const res = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_enough_messages");
  });

  it("returns 404 when the service reports not_found", async () => {
    const { user: customer } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "with_agent" });
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeConversation").mockResolvedValue({ ok: false, reason: "not_found" });

    const res = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 503 when the service reports ai_unavailable", async () => {
    const { user: customer } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "with_agent" });
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeConversation").mockResolvedValue({ ok: false, reason: "ai_unavailable" });

    const res = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("ai_unavailable");
  });

  it("returns 200 with the summary on success", async () => {
    const { user: customer } = await seedUser();
    const conversation = await Conversation.create({ customer: customer._id, status: "with_agent" });
    const { token } = await seedUser({ role: "agent", permissions: ["ai:summarize"] });
    vi.spyOn(summaryService, "summarizeConversation").mockResolvedValue({ ok: true, summary: "Issue: ..." });

    const res = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/summarize`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: "Issue: ..." });
  });
});
