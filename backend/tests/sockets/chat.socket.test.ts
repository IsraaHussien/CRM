import http from "http";
import { AddressInfo } from "net";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerChatHandlers } from "../../src/sockets/chat.socket";
import { User } from "../../src/models/User";
import { Conversation } from "../../src/models/Conversation";
import { Message } from "../../src/models/Message";
import { Notification } from "../../src/models/Notification";
import { Ticket } from "../../src/models/Ticket";
import * as liveChatAiService from "../../src/services/liveChatAi.service";
import * as emailService from "../../src/services/email.service";

vi.mock("../../src/services/liveChatAi.service", () => ({
  getAiReply: vi.fn(),
  evaluateTicketSuggestion: vi.fn(),
  evaluateKbSuggestion: vi.fn(),
}));

let mongod: MongoMemoryServer;
let httpServer: http.Server;
let io: Server;
let port: number;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("chat-socket-test"));

  httpServer = http.createServer();
  io = new Server(httpServer);
  registerChatHandlers(io);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Conversation.deleteMany({});
  await Message.deleteMany({});
  await Notification.deleteMany({});
  await Ticket.deleteMany({});
  vi.mocked(liveChatAiService.getAiReply).mockReset();
  vi.mocked(liveChatAiService.evaluateTicketSuggestion).mockReset();
  vi.mocked(liveChatAiService.evaluateTicketSuggestion).mockResolvedValue(null);
  vi.mocked(liveChatAiService.evaluateKbSuggestion).mockReset();
  vi.mocked(liveChatAiService.evaluateKbSuggestion).mockResolvedValue(null);
});

// Story 41-adjacent: real login tokens carry { sub, role, name } (see
// middleware/auth.ts's JwtPayload) — chat.socket.ts's io.use now reads
// `name` off the verified payload for the claim broadcast, so test tokens
// must include it too or every claimed.agent.name comes back undefined.
function tokenFor(user: { id: string; role: string; name?: string }) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name ?? "Test User" },
    process.env.JWT_SECRET as string
  );
}

async function seedUser(role = "customer") {
  const user = await User.create({
    name: "Test User",
    email: `user-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role,
  });
  return { user, token: tokenFor({ id: user.id, role, name: user.name }) };
}

async function seedOnlineAgent() {
  return User.create({
    name: "Available Agent",
    email: `agent-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
    passwordHash: "irrelevant-for-these-tests",
    role: "agent",
    isOnline: true,
    isActive: true,
    // chats:manage is required to claim a conversation (conversation:claim)
    // and to be an eligible chat_needs_agent notification recipient — this
    // helper's whole purpose is seeding an agent meant to be eligible for
    // both. "isOnline" no longer gates eligibility for either (there's no
    // more auto-assign step that only considered online agents), but the
    // name is kept since most call sites still want an online, eligible
    // agent for realism.
    permissions: ["chats:manage"],
  });
}

function connect(token?: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: token ? { token } : {},
      transports: ["websocket"],
      reconnection: false,
    });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });
}

describe("chat.socket.ts (Story 14)", () => {
  it("rejects a connection with no token", async () => {
    await expect(connect()).rejects.toThrow("Unauthorized");
  });

  it("rejects a connection with a bogus token", async () => {
    await expect(connect("not-a-real-token")).rejects.toThrow("Unauthorized");
  });

  it("lets the conversation's own customer join", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id });
    const socket = await connect(token);

    const joined = new Promise((resolve) => socket.on("conversation:joined", resolve));
    socket.emit("conversation:join", conversation.id);

    await expect(joined).resolves.toEqual({ conversationId: conversation.id });
    socket.disconnect();
  });

  it("rejects a foreign customer trying to join", async () => {
    const { user: owner } = await seedUser();
    const { token: otherToken } = await seedUser();
    const conversation = await Conversation.create({ customer: owner._id });
    const socket = await connect(otherToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:join", conversation.id);

    await expect(errored).resolves.toEqual({ error: "You do not have permission to join this conversation" });
    socket.disconnect();
  });

  it("persists and broadcasts a message after a valid join", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id });
    const socket = await connect(token);

    await new Promise((resolve) => {
      socket.on("conversation:joined", resolve);
      socket.emit("conversation:join", conversation.id);
    });

    const received = new Promise<Record<string, unknown>>((resolve) =>
      socket.on("conversation:message", resolve)
    );
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hello" });

    const message = await received;
    expect(message.text).toBe("hello");
    expect(message.senderType).toBe("customer");
    expect(message.senderId).toBe(user.id);
    expect(message.parentType).toBe("conversation");
    // Story 15: this conversation defaults to status "ai_handling", so the
    // customer's message also triggers an AI reply — scope this assertion to
    // the customer's own message to keep testing only what Story 14 added.
    expect(await Message.countDocuments({ parentType: "conversation", senderType: "customer" })).toBe(1);

    socket.disconnect();
  });

  it("rejects empty/whitespace-only text and writes no Message", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id });
    const socket = await connect(token);

    await new Promise((resolve) => {
      socket.on("conversation:joined", resolve);
      socket.emit("conversation:join", conversation.id);
    });

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:message", { conversationId: conversation.id, text: "   " });

    await errored;
    expect(await Message.countDocuments()).toBe(0);
    socket.disconnect();
  });

  it("rejects a message from a foreign sender and writes no Message", async () => {
    const { user: owner } = await seedUser();
    const { token: otherToken } = await seedUser();
    const conversation = await Conversation.create({ customer: owner._id });
    const socket = await connect(otherToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hello" });

    await expect(errored).resolves.toEqual({
      error: "You do not have permission to send messages in this conversation",
    });
    expect(await Message.countDocuments()).toBe(0);
    socket.disconnect();
  });

  it("rejects a message on a resolved conversation", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "resolved" });
    const socket = await connect(token);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hello" });

    await expect(errored).resolves.toEqual({ error: "This conversation is closed" });
    expect(await Message.countDocuments()).toBe(0);
    socket.disconnect();
  });
});

describe("chat.socket.ts AI agent branch (Story 15)", () => {
  async function joinedSocket(conversationId: string, token: string): Promise<ClientSocket> {
    const socket = await connect(token);
    await new Promise((resolve) => {
      socket.on("conversation:joined", resolve);
      socket.emit("conversation:join", conversationId);
    });
    return socket;
  }

  it("emits ai-typing then a labeled AI reply when the conversation is ai_handling", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("Here's the answer.");
    const socket = await joinedSocket(conversation.id, token);

    const typing = new Promise((resolve) => socket.on("conversation:ai-typing", resolve));
    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    await expect(typing).resolves.toEqual({ conversationId: conversation.id });
    const aiMessage = await secondMessage;
    expect(aiMessage.senderType).toBe("ai");
    expect(aiMessage.text).toBe("Here's the answer.");
    expect(await Message.countDocuments({ senderType: "ai" })).toBe(1);

    socket.disconnect();
  });

  it("broadcasts the fallback text (still senderType ai) when getAiReply resolves null", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue(null);
    const socket = await joinedSocket(conversation.id, token);

    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    const aiMessage = await secondMessage;
    expect(aiMessage.senderType).toBe("ai");
    expect(aiMessage.text).toMatch(/trouble answering/i);

    socket.disconnect();
  });

  it("persists+broadcasts the fallback when Message.create throws for the AI reply", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("Would have been the reply");
    // Only the AI-reply Message.create (the 2nd call: 1st is the customer's
    // own message) should throw — the customer's message must still persist.
    const originalCreate = Message.create.bind(Message);
    let createCalls = 0;
    const createSpy = vi.spyOn(Message, "create").mockImplementation(((...args: unknown[]) => {
      createCalls += 1;
      if (createCalls === 2) {
        throw new Error("db hiccup");
      }
      return originalCreate(...(args as Parameters<typeof originalCreate>));
    }) as typeof Message.create);
    const socket = await joinedSocket(conversation.id, token);

    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    const aiMessage = await secondMessage;
    expect(aiMessage.senderType).toBe("ai");
    expect(aiMessage.text).toMatch(/trouble answering/i);

    createSpy.mockRestore();
    socket.disconnect();
  });

  it("does not trigger the AI branch for a non-customer sender", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "ai_handling",
    });
    const socket = await joinedSocket(conversation.id, agentToken);

    socket.emit("conversation:message", { conversationId: conversation.id, text: "agent reply" });
    await new Promise((resolve) => socket.on("conversation:message", resolve));

    expect(liveChatAiService.getAiReply).not.toHaveBeenCalled();
    expect(await Message.countDocuments({ senderType: "ai" })).toBe(0);

    socket.disconnect();
  });

  it("does not trigger the AI branch when status is with_agent", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "with_agent" });
    const socket = await joinedSocket(conversation.id, token);

    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });
    await new Promise((resolve) => socket.on("conversation:message", resolve));

    expect(liveChatAiService.getAiReply).not.toHaveBeenCalled();
    expect(await Message.countDocuments({ senderType: "ai" })).toBe(0);

    socket.disconnect();
  });

  // A customer who has escalated (asked for a human) but hasn't had anyone
  // claim the chat yet must not be left hanging — the AI keeps answering
  // until status flips to "with_agent" (see the with_agent test above and
  // the escalate describe block's own coverage of this transition).
  it("still triggers the AI branch when status is escalated (no human has claimed yet)", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "escalated" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("Still happy to help while you wait.");
    const socket = await joinedSocket(conversation.id, token);

    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    const aiMessage = await secondMessage;
    expect(aiMessage.senderType).toBe("ai");
    expect(aiMessage.text).toBe("Still happy to help while you wait.");
    expect(liveChatAiService.getAiReply).toHaveBeenCalled();
    expect(await Message.countDocuments({ senderType: "ai" })).toBe(1);

    socket.disconnect();
  });
});

describe("chat.socket.ts escalate (Story 16)", () => {
  async function joinedSocket(conversationId: string, token: string): Promise<ClientSocket> {
    const socket = await connect(token);
    await new Promise((resolve) => {
      socket.on("conversation:joined", resolve);
      socket.emit("conversation:join", conversationId);
    });
    return socket;
  }

  it("flips status to escalated and broadcasts conversation:escalated", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    const socket = await joinedSocket(conversation.id, token);

    const escalated = new Promise((resolve) => socket.on("conversation:escalated", resolve));
    socket.emit("conversation:escalate", { conversationId: conversation.id });

    await expect(escalated).resolves.toEqual({ conversationId: conversation.id, status: "escalated" });
    expect((await Conversation.findById(conversation.id))!.status).toBe("escalated");

    socket.disconnect();
  });

  it("rejects a non-customer (agent) trying to escalate, leaving status unchanged", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "ai_handling",
    });
    const socket = await joinedSocket(conversation.id, agentToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:escalate", { conversationId: conversation.id });

    await expect(errored).resolves.toEqual({
      error: "You do not have permission to escalate this conversation",
    });
    expect((await Conversation.findById(conversation.id))!.status).toBe("ai_handling");

    socket.disconnect();
  });

  it("rejects a malformed payload", async () => {
    const { token } = await seedUser();
    const socket = await connect(token);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:escalate", { conversationId: "not-an-object-id" });

    await errored;
    socket.disconnect();
  });

  it("rejects escalating a resolved conversation", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "resolved" });
    const socket = await connect(token);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:escalate", { conversationId: conversation.id });

    await expect(errored).resolves.toEqual({ error: "This conversation is closed" });

    socket.disconnect();
  });

  it("is idempotent for an already-escalated conversation — no error, direct re-emit", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "escalated" });
    const socket = await connect(token);

    const escalated = new Promise((resolve) => socket.on("conversation:escalated", resolve));
    socket.emit("conversation:escalate", { conversationId: conversation.id });

    await expect(escalated).resolves.toEqual({ conversationId: conversation.id, status: "escalated" });

    socket.disconnect();
  });

  it("is idempotent for an already-with_agent conversation", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "with_agent" });
    const socket = await connect(token);

    const escalated = new Promise((resolve) => socket.on("conversation:escalated", resolve));
    socket.emit("conversation:escalate", { conversationId: conversation.id });

    await expect(escalated).resolves.toEqual({ conversationId: conversation.id, status: "with_agent" });

    socket.disconnect();
  });

  it("after escalation, a customer message still triggers the AI branch until a human claims", async () => {
    // Status leaves "ai_handling" the moment escalation succeeds — this no
    // longer depends on anyone claiming the chat (claiming is a separate,
    // explicit staff action; see the claim/unclaim describe block below).
    // The AI keeps answering through this "escalated" gap on purpose — a
    // customer who escalated and then kept typing while waiting for a human
    // must not be met with silence (see chat.socket.ts's AI-branch comment).
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("Someone will be with you, meanwhile...");
    const socket = await joinedSocket(conversation.id, token);

    await new Promise((resolve) => {
      // Escalation's own persisted acknowledgment ("someone will join
      // shortly") is the first "system"-sender message broadcast — waiting
      // on it confirms escalation finished before the customer message
      // below is sent.
      socket.on("conversation:message", resolve);
      socket.emit("conversation:escalate", { conversationId: conversation.id });
    });

    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "still here?" });

    const aiMessage = await secondMessage;
    expect(aiMessage.senderType).toBe("ai");
    expect(liveChatAiService.getAiReply).toHaveBeenCalled();
    expect(await Message.countDocuments({ senderType: "customer" })).toBe(1);
    expect((await Conversation.findById(conversation.id))!.status).toBe("escalated");

    socket.disconnect();
  });

  it("sends the escalation ack (senderType system) and a chat_needs_agent notification to every eligible staff member", async () => {
    const { user: admin } = await seedUser("admin");
    const onlineEligibleAgent = await seedOnlineAgent();
    const offlineEligibleAgent = await User.create({
      name: "Offline Agent",
      email: `offline-agent-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
      passwordHash: "irrelevant-for-these-tests",
      role: "agent",
      isOnline: false,
      isActive: true,
      permissions: ["chats:manage"],
    });
    // No chats:manage permission — must NOT be notified, online or not.
    const uninvolvedAgent = await seedUser("agent");
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    const socket = await joinedSocket(conversation.id, token);

    const ack = new Promise<Record<string, unknown>>((resolve) => socket.on("conversation:message", resolve));
    socket.emit("conversation:escalate", { conversationId: conversation.id });
    const ackMessage = await ack;

    expect(ackMessage.senderType).toBe("system");
    expect(ackMessage.text).toMatch(/someone will join shortly/i);

    for (const recipient of [admin, onlineEligibleAgent, offlineEligibleAgent]) {
      const notifications = await Notification.find({ recipient: recipient._id });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe("chat_needs_agent");
      expect(notifications[0].conversationId!.toString()).toBe(conversation.id);
      expect(notifications[0].ticketId).toBeNull();
    }
    expect(await Notification.find({ recipient: uninvolvedAgent.user._id })).toHaveLength(0);

    socket.disconnect();
  });
});

describe("chat.socket.ts conversation:claim / conversation:unclaim", () => {
  async function joinedSocket(conversationId: string, token: string): Promise<ClientSocket> {
    const socket = await connect(token);
    await new Promise((resolve) => {
      socket.on("conversation:joined", resolve);
      socket.emit("conversation:join", conversationId);
    });
    return socket;
  }

  it("lets an eligible agent claim an escalated conversation, broadcasting conversation:claimed and conversation:assigned", async () => {
    const { user: customer, token: customerToken } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    await User.updateOne({ _id: agent._id }, { $set: { permissions: ["chats:manage"] } });
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });
    const customerSocket = await joinedSocket(conversation.id, customerToken);
    const agentSocket = await joinedSocket(conversation.id, agentToken);

    const claimed = new Promise<Record<string, unknown>>((resolve) =>
      agentSocket.on("conversation:claimed", resolve)
    );
    const assigned = new Promise<Record<string, unknown>>((resolve) =>
      customerSocket.on("conversation:assigned", resolve)
    );
    agentSocket.emit("conversation:claim", { conversationId: conversation.id });

    await expect(claimed).resolves.toEqual({
      conversationId: conversation.id,
      agent: { id: agent.id, name: agent.name },
    });
    await expect(assigned).resolves.toEqual({
      conversationId: conversation.id,
      agentId: agent.id,
      status: "with_agent",
    });

    const reloaded = await Conversation.findById(conversation.id);
    expect(reloaded!.status).toBe("with_agent");
    expect(reloaded!.assignedAgent?.toString()).toBe(agent.id);
    expect(reloaded!.agentJoinedAnnounced).toBe(true);

    customerSocket.disconnect();
    agentSocket.disconnect();
  });

  it("rejects a second staff member's claim once someone else already holds it", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agentA, token: tokenA } = await seedUser("agent");
    const { user: agentB, token: tokenB } = await seedUser("agent");
    await User.updateMany(
      { _id: { $in: [agentA._id, agentB._id] } },
      { $set: { permissions: ["chats:manage"] } }
    );
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });
    const socketA = await joinedSocket(conversation.id, tokenA);
    const socketB = await joinedSocket(conversation.id, tokenB);

    await new Promise((resolve) => {
      socketA.on("conversation:claimed", resolve);
      socketA.emit("conversation:claim", { conversationId: conversation.id });
    });

    const errored = new Promise((resolve) => socketB.on("conversation:error", resolve));
    socketB.emit("conversation:claim", { conversationId: conversation.id });

    await expect(errored).resolves.toEqual({
      error: "This chat is already being handled by another staff member.",
    });
    expect((await Conversation.findById(conversation.id))!.assignedAgent?.toString()).toBe(agentA.id);

    socketA.disconnect();
    socketB.disconnect();
  });

  it("rejects a claim from the conversation's own customer", async () => {
    const { user: customer, token: customerToken } = await seedUser("customer");
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });

    // The customer CAN view their own conversation (isAuthorizedOnConversation),
    // just never claim it (canClaimConversation) — so joinedSocket() (which
    // expects the join itself to succeed) applies here.
    const socket = await joinedSocket(conversation.id, customerToken);
    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:claim", { conversationId: conversation.id });
    await expect(errored).resolves.toEqual({ error: "You do not have permission to claim this conversation" });
    socket.disconnect();

    expect((await Conversation.findById(conversation.id))!.assignedAgent).toBeNull();
  });

  it("rejects a claim (and the earlier join) from an agent without chats:manage on someone else's conversation", async () => {
    const { user: customer } = await seedUser("customer");
    const { token: plainAgentToken } = await seedUser("agent");
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });

    // An agent with no chats:manage isn't even authorized to VIEW an
    // unclaimed conversation that isn't theirs — unlike the customer case
    // above, this rejects at conversation:join already, so plain connect()
    // is used instead of joinedSocket() (which would hang waiting for a
    // "conversation:joined" that never fires).
    const socket = await connect(plainAgentToken);
    const joinError = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:join", conversation.id);
    await expect(joinError).resolves.toEqual({ error: "You do not have permission to join this conversation" });

    const claimError = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:claim", { conversationId: conversation.id });
    await expect(claimError).resolves.toEqual({ error: "You do not have permission to claim this conversation" });
    socket.disconnect();

    expect((await Conversation.findById(conversation.id))!.assignedAgent).toBeNull();
  });

  it("lets an admin claim regardless of chats:manage, with no bypass for replying without claiming first", async () => {
    const { user: customer } = await seedUser("customer");
    const { token: adminToken } = await seedUser("admin");
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });
    const socket = await joinedSocket(conversation.id, adminToken);

    // Story 18's old "any admin can jump straight into any chat" behavior is
    // gone — even an admin must claim before a message is accepted.
    const beforeClaimError = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:message", { conversationId: conversation.id, text: "too early" });
    await expect(beforeClaimError).resolves.toEqual({
      error: "Join this chat before replying — it hasn't been claimed by you.",
    });

    await new Promise((resolve) => {
      socket.on("conversation:claimed", resolve);
      socket.emit("conversation:claim", { conversationId: conversation.id });
    });

    const received = new Promise<Record<string, unknown>>((resolve) =>
      socket.on("conversation:message", resolve)
    );
    socket.emit("conversation:message", { conversationId: conversation.id, text: "Admin stepping in" });
    const message = await received;
    expect(message.senderType).toBe("agent");
    expect(message.text).toBe("Admin stepping in");

    socket.disconnect();
  });

  it("releases the claim on conversation:unclaim, reverting to escalated and broadcasting conversation:unclaimed", async () => {
    const { user: customer, token: customerToken } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    const customerSocket = await joinedSocket(conversation.id, customerToken);
    const agentSocket = await joinedSocket(conversation.id, agentToken);

    const unclaimed = new Promise<Record<string, unknown>>((resolve) =>
      customerSocket.on("conversation:unclaimed", resolve)
    );
    agentSocket.emit("conversation:unclaim", { conversationId: conversation.id });

    await expect(unclaimed).resolves.toEqual({ conversationId: conversation.id });
    const reloaded = await Conversation.findById(conversation.id);
    expect(reloaded!.assignedAgent).toBeNull();
    expect(reloaded!.status).toBe("escalated");

    customerSocket.disconnect();
    agentSocket.disconnect();
  });

  it("rejects unclaim from someone who isn't the current claimant", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent } = await seedUser("agent");
    const { token: otherAgentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    const socket = await connect(otherAgentToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:unclaim", { conversationId: conversation.id });

    await expect(errored).resolves.toEqual({ error: "You are not currently handling this conversation" });
    expect((await Conversation.findById(conversation.id))!.assignedAgent?.toString()).toBe(agent.id);

    socket.disconnect();
  });

  it("auto-releases the claim when the claimant's socket disconnects, so someone else can claim it", async () => {
    const { user: customer, token: customerToken } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    await User.updateOne({ _id: agent._id }, { $set: { permissions: ["chats:manage"] } });
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });
    const customerSocket = await joinedSocket(conversation.id, customerToken);
    const agentSocket = await joinedSocket(conversation.id, agentToken);

    await new Promise((resolve) => {
      agentSocket.on("conversation:claimed", resolve);
      agentSocket.emit("conversation:claim", { conversationId: conversation.id });
    });

    const unclaimed = new Promise((resolve) => customerSocket.on("conversation:unclaimed", resolve));
    agentSocket.disconnect();

    await expect(unclaimed).resolves.toEqual({ conversationId: conversation.id });
    const reloaded = await Conversation.findById(conversation.id);
    expect(reloaded!.assignedAgent).toBeNull();
    expect(reloaded!.status).toBe("escalated");

    customerSocket.disconnect();
  });

  it("records a joined/left pair on a ticket opened from the conversation", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    await User.updateOne({ _id: agent._id }, { $set: { permissions: ["chats:manage"] } });
    const conversation = await Conversation.create({ customer: customer._id, status: "escalated" });
    const ticket = await Ticket.create({
      subject: "From chat",
      description: "d",
      customer: customer._id,
      sourceConversation: conversation._id,
    });
    const socket = await joinedSocket(conversation.id, agentToken);

    await new Promise((resolve) => {
      socket.on("conversation:claimed", resolve);
      socket.emit("conversation:claim", { conversationId: conversation.id });
    });

    let reloadedTicket = await Ticket.findById(ticket.id);
    expect(reloadedTicket!.chatPresenceHistory).toHaveLength(1);
    expect(reloadedTicket!.chatPresenceHistory[0]).toMatchObject({ event: "joined", user: agent._id });

    const unclaimedPromise = new Promise((resolve) => socket.on("conversation:unclaimed", resolve));
    socket.emit("conversation:unclaim", { conversationId: conversation.id });
    await unclaimedPromise;

    reloadedTicket = await Ticket.findById(ticket.id);
    expect(reloadedTicket!.chatPresenceHistory).toHaveLength(2);
    expect(reloadedTicket!.chatPresenceHistory[1]).toMatchObject({ event: "left", user: agent._id });

    socket.disconnect();
  });

  it("customer close via conversation:close flips status to resolved and broadcasts conversation:closed", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "escalated" });
    const socket = await joinedSocket(conversation.id, token);

    const closed = new Promise((resolve) => socket.on("conversation:closed", resolve));
    socket.emit("conversation:close", { conversationId: conversation.id });

    await expect(closed).resolves.toEqual({ conversationId: conversation.id, status: "resolved" });
    expect((await Conversation.findById(conversation.id))!.status).toBe("resolved");

    socket.disconnect();
  });

  // customer-portal Story 39: resolving a conversation triggers the "rate
  // your experience" email, mirroring ticket.routes.ts's PATCH /:id/status.
  it("sends a resolution email when a conversation transitions into resolved", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "escalated" });
    const socket = await joinedSocket(conversation.id, token);

    const closed = new Promise((resolve) => socket.on("conversation:closed", resolve));
    socket.emit("conversation:close", { conversationId: conversation.id });
    await closed;
    // The email send happens after a real (unmocked) User.findById lookup,
    // which the client-visible "closed" broadcast does not wait on — give
    // it a tick to actually complete server-side before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining(`/feedback/conversation/${conversation.id}`) })
    );

    socket.disconnect();
  });

  it("lets the assigned agent close via conversation:close (Story 19)", async () => {
    const { user: customer, token: customerToken } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    const customerSocket = await joinedSocket(conversation.id, customerToken);
    const agentSocket = await joinedSocket(conversation.id, agentToken);

    const closedForCustomer = new Promise((resolve) => customerSocket.on("conversation:closed", resolve));
    agentSocket.emit("conversation:close", { conversationId: conversation.id });

    await expect(closedForCustomer).resolves.toEqual({ conversationId: conversation.id, status: "resolved" });
    expect((await Conversation.findById(conversation.id))!.status).toBe("resolved");

    customerSocket.disconnect();
    agentSocket.disconnect();
  });

  it("lets an admin close any conversation via conversation:close (Story 19)", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent } = await seedUser("agent");
    const { token: adminToken } = await seedUser("admin");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    const socket = await joinedSocket(conversation.id, adminToken);

    const closed = new Promise((resolve) => socket.on("conversation:closed", resolve));
    socket.emit("conversation:close", { conversationId: conversation.id });

    await expect(closed).resolves.toEqual({ conversationId: conversation.id, status: "resolved" });
    expect((await Conversation.findById(conversation.id))!.status).toBe("resolved");

    socket.disconnect();
  });

  it("rejects a non-participant agent's conversation:close with conversation:error (Story 19)", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: assignedAgent } = await seedUser("agent");
    const { token: otherAgentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: assignedAgent._id,
      status: "with_agent",
    });
    // Not joinedSocket() -- this agent isn't authorized to join the
    // conversation either, so waiting on "conversation:joined" would hang.
    const socket = await connect(otherAgentToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:close", { conversationId: conversation.id });

    await expect(errored).resolves.toEqual({
      error: "You do not have permission to close this conversation",
    });
    expect((await Conversation.findById(conversation.id))!.status).toBe("with_agent");

    socket.disconnect();
  });

  it("closing an already-resolved conversation emits conversation:closed to the caller but does not re-broadcast (Story 19)", async () => {
    const sendEmailMock = vi.spyOn(emailService, "sendEmail").mockResolvedValue({ dryRun: true });
    const { user: customer, token: customerToken } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "resolved",
    });
    const customerSocket = await joinedSocket(conversation.id, customerToken);
    const agentSocket = await joinedSocket(conversation.id, agentToken);

    let customerBroadcasts = 0;
    customerSocket.on("conversation:closed", () => {
      customerBroadcasts += 1;
    });
    const closedForAgent = new Promise((resolve) => agentSocket.on("conversation:closed", resolve));
    agentSocket.emit("conversation:close", { conversationId: conversation.id });

    await expect(closedForAgent).resolves.toEqual({ conversationId: conversation.id, status: "resolved" });
    // Give the (absent) room broadcast a tick to have arrived if it wrongly fired.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(customerBroadcasts).toBe(0);
    // customer-portal Story 39: an already-resolved conversation must not
    // re-send the resolution email either.
    expect(sendEmailMock).not.toHaveBeenCalled();

    customerSocket.disconnect();
    agentSocket.disconnect();
  });

  it("rejects an agent's message on a resolved conversation, same as a customer's (Story 19)", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "resolved",
    });
    const socket = await joinedSocket(conversation.id, agentToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    await expect(errored).resolves.toEqual({ error: "This conversation is closed" });
    expect(await Message.countDocuments()).toBe(0);

    socket.disconnect();
  });
});

describe("chat.socket.ts agent/admin reply (Story 18)", () => {
  async function joinedSocket(conversationId: string, token: string): Promise<ClientSocket> {
    const socket = await connect(token);
    await new Promise((resolve) => {
      socket.on("conversation:joined", resolve);
      socket.emit("conversation:join", conversationId);
    });
    return socket;
  }

  it("lets the assigned agent join and reply; message persists as senderType agent and broadcasts to the customer", async () => {
    const { user: customer, token: customerToken } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    const customerSocket = await joinedSocket(conversation.id, customerToken);
    const agentSocket = await joinedSocket(conversation.id, agentToken);

    const receivedByCustomer = new Promise<Record<string, unknown>>((resolve) =>
      customerSocket.on("conversation:message", resolve)
    );
    agentSocket.emit("conversation:message", { conversationId: conversation.id, text: "How can I help?" });

    const message = await receivedByCustomer;
    expect(message.senderType).toBe("agent");
    expect(message.senderId).toBe(agent.id);
    expect(message.text).toBe("How can I help?");

    customerSocket.disconnect();
    agentSocket.disconnect();
  });

  it("does not trigger the AI branch for the agent's own reply", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent, token: agentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    const socket = await joinedSocket(conversation.id, agentToken);

    socket.emit("conversation:message", { conversationId: conversation.id, text: "agent reply" });
    await new Promise((resolve) => socket.on("conversation:message", resolve));

    expect(liveChatAiService.getAiReply).not.toHaveBeenCalled();
    expect(await Message.countDocuments({ senderType: "ai" })).toBe(0);

    socket.disconnect();
  });

  it("admin can still VIEW (join) any conversation even when not the claimant — replying is covered by the claim describe block above", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: agent } = await seedUser("agent");
    const { token: adminToken } = await seedUser("admin");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: agent._id,
      status: "with_agent",
    });
    const socket = await joinedSocket(conversation.id, adminToken);
    // joinedSocket() already asserts the join succeeded (waits on
    // conversation:joined) — nothing further to check here beyond that not
    // hanging/erroring.
    socket.disconnect();
  });

  it("an unassigned, non-admin agent is still rejected (regression on the widened check)", async () => {
    const { user: customer } = await seedUser("customer");
    const { user: assignedAgent } = await seedUser("agent");
    const { token: otherAgentToken } = await seedUser("agent");
    const conversation = await Conversation.create({
      customer: customer._id,
      assignedAgent: assignedAgent._id,
      status: "with_agent",
    });
    const socket = await connect(otherAgentToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:join", conversation.id);

    await expect(errored).resolves.toEqual({ error: "You do not have permission to join this conversation" });

    socket.disconnect();
  });
});

describe("chat.socket.ts AI ticket suggestion (Story 62)", () => {
  async function joinedSocket(conversationId: string, token: string): Promise<ClientSocket> {
    const socket = await connect(token);
    await new Promise((resolve) => {
      socket.on("conversation:joined", resolve);
      socket.emit("conversation:join", conversationId);
    });
    return socket;
  }

  it("includes aiTicketSuggestion on the AI message when the classifier suggests one", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("Here's the answer.");
    vi.mocked(liveChatAiService.evaluateTicketSuggestion).mockResolvedValue({
      subject: "Attach logs",
      description: "Needs file attachments.",
    });
    const socket = await joinedSocket(conversation.id, token);

    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    const aiMessage = await secondMessage;
    expect(aiMessage.aiTicketSuggestion).toEqual({ subject: "Attach logs", description: "Needs file attachments." });

    socket.disconnect();
  });

  it("omits aiTicketSuggestion (null) when the classifier does not suggest one", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("Here's the answer.");
    vi.mocked(liveChatAiService.evaluateTicketSuggestion).mockResolvedValue(null);
    const socket = await joinedSocket(conversation.id, token);

    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    const aiMessage = await secondMessage;
    expect(aiMessage.aiTicketSuggestion).toBeNull();

    socket.disconnect();
  });

  it("skips the classifier once the conversation is flagged as declined", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({
      customer: user._id,
      status: "ai_handling",
      aiTicketSuggestionDeclined: true,
    });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("ok");
    const socket = await joinedSocket(conversation.id, token);

    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });
    await new Promise((resolve) => socket.on("conversation:message", resolve));

    expect(liveChatAiService.evaluateTicketSuggestion).toHaveBeenCalledWith(conversation.id, true);

    socket.disconnect();
  });

  it("still emits the normal AI reply when the classifier call rejects", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    vi.mocked(liveChatAiService.getAiReply).mockResolvedValue("Here's the answer.");
    vi.mocked(liveChatAiService.evaluateTicketSuggestion).mockRejectedValue(new Error("classifier down"));
    const socket = await joinedSocket(conversation.id, token);

    const messages: Record<string, unknown>[] = [];
    const secondMessage = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("conversation:message", (msg: Record<string, unknown>) => {
        messages.push(msg);
        if (messages.length === 2) resolve(msg);
      });
    });
    socket.emit("conversation:message", { conversationId: conversation.id, text: "hi" });

    // Promise.all rejects if either promise rejects, so the outer catch's
    // fallback path fires -- still a graceful, non-blocking result.
    const aiMessage = await secondMessage;
    expect(aiMessage.senderType).toBe("ai");
    expect(aiMessage.text).toMatch(/trouble answering/i);

    socket.disconnect();
  });
});

describe("chat.socket.ts conversation:ai-suggestion-declined (Story 62)", () => {
  it("sets aiTicketSuggestionDeclined for the conversation's own customer", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({ customer: user._id, status: "ai_handling" });
    const socket = await connect(token);

    socket.emit("conversation:ai-suggestion-declined", { conversationId: conversation.id });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await Conversation.findById(conversation.id))!.aiTicketSuggestionDeclined).toBe(true);

    socket.disconnect();
  });

  it("is idempotent when already declined", async () => {
    const { user, token } = await seedUser();
    const conversation = await Conversation.create({
      customer: user._id,
      status: "ai_handling",
      aiTicketSuggestionDeclined: true,
    });
    const socket = await connect(token);

    socket.emit("conversation:ai-suggestion-declined", { conversationId: conversation.id });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await Conversation.findById(conversation.id))!.aiTicketSuggestionDeclined).toBe(true);

    socket.disconnect();
  });

  it("rejects a non-owning caller and leaves the flag unset", async () => {
    const { user: owner } = await seedUser();
    const { token: otherToken } = await seedUser();
    const conversation = await Conversation.create({ customer: owner._id, status: "ai_handling" });
    const socket = await connect(otherToken);

    const errored = new Promise((resolve) => socket.on("conversation:error", resolve));
    socket.emit("conversation:ai-suggestion-declined", { conversationId: conversation.id });

    await expect(errored).resolves.toEqual({
      error: "You do not have permission to update this conversation",
    });
    expect((await Conversation.findById(conversation.id))!.aiTicketSuggestionDeclined).toBe(false);

    socket.disconnect();
  });
});
