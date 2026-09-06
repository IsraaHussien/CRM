import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Message } from "../../src/models/Message";
import { Conversation } from "../../src/models/Conversation";
import { User } from "../../src/models/User";
import { Ticket } from "../../src/models/Ticket";
import { AuditLog } from "../../src/models/AuditLog";
import * as geminiService from "../../src/services/gemini.service";
import { getAiReply, evaluateTicketSuggestion } from "../../src/services/liveChatAi.service";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("live-chat-ai-test"));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
  await Conversation.deleteMany({});
  await User.deleteMany({});
  await Ticket.deleteMany({});
  await AuditLog.deleteMany({});
  vi.restoreAllMocks();
});

const parentId = new mongoose.Types.ObjectId();

async function seedMessage(senderType: string, text: string, extra: Partial<{ internal: boolean }> = {}) {
  await Message.create({
    parentType: "conversation",
    parentId,
    senderType,
    senderId: null,
    text,
    ...extra,
  });
}

describe("liveChatAi.service.ts getAiReply (Story 15)", () => {
  it("returns the trimmed reply when generateText resolves to a non-empty string", async () => {
    await seedMessage("customer", "Hello?");
    vi.spyOn(geminiService, "generateText").mockResolvedValue("  Sure, I can help!  ");

    const reply = await getAiReply(parentId.toHexString(), "Hello?");

    expect(reply).toBe("Sure, I can help!");
  });

  it("returns null when generateText resolves to null", async () => {
    await seedMessage("customer", "Hello?");
    vi.spyOn(geminiService, "generateText").mockResolvedValue(null);

    const reply = await getAiReply(parentId.toHexString(), "Hello?");

    expect(reply).toBeNull();
  });

  it("returns null when generateText resolves to whitespace-only text", async () => {
    await seedMessage("customer", "Hello?");
    vi.spyOn(geminiService, "generateText").mockResolvedValue("   ");

    const reply = await getAiReply(parentId.toHexString(), "Hello?");

    expect(reply).toBeNull();
  });

  it("builds the prompt with Customer/AI Agent/Agent labels in oldest-to-newest order", async () => {
    await seedMessage("customer", "First message");
    await seedMessage("ai", "First reply");
    await seedMessage("agent", "Human follow-up");
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(parentId.toHexString(), "First message");

    const prompt = spy.mock.calls[0][0];
    const customerIdx = prompt.indexOf("Customer: First message");
    const aiIdx = prompt.indexOf("AI Agent: First reply");
    const agentIdx = prompt.indexOf("Agent: Human follow-up");
    expect(customerIdx).toBeGreaterThan(-1);
    expect(aiIdx).toBeGreaterThan(customerIdx);
    expect(agentIdx).toBeGreaterThan(aiIdx);
  });

  it("excludes system and internal messages from the prompt", async () => {
    await seedMessage("customer", "Visible message");
    await seedMessage("system", "Should be excluded");
    await seedMessage("agent", "Internal note", { internal: true });
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(parentId.toHexString(), "Visible message");

    const prompt = spy.mock.calls[0][0];
    expect(prompt).not.toContain("Should be excluded");
    expect(prompt).not.toContain("Internal note");
  });

  it("caps history at 20 messages when more exist", async () => {
    for (let i = 0; i < 25; i++) {
      await seedMessage("customer", `msg-${i}`);
    }
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(parentId.toHexString(), "msg-24");

    const prompt = spy.mock.calls[0][0];
    expect(prompt).not.toContain("msg-0\n");
    expect(prompt).toContain("msg-24");
  });

  it("returns null when the history query throws", async () => {
    vi.spyOn(Message, "find").mockImplementation(() => {
      throw new Error("db down");
    });

    const reply = await getAiReply(parentId.toHexString(), "");

    expect(reply).toBeNull();
  });

  it("includes the customer's identity in the prompt so the AI never has to ask for it", async () => {
    const customer = await User.create({
      name: "Sara Ahmed",
      email: "sara@example.com",
      passwordHash: "irrelevant-for-these-tests",
      role: "customer",
    });
    const conversation = await Conversation.create({ customer: customer._id, status: "ai_handling" });
    await Message.create({
      parentType: "conversation",
      parentId: conversation._id,
      senderType: "customer",
      senderId: customer._id,
      text: "I need help",
    });
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(conversation.id, "I need help");

    const prompt = spy.mock.calls[0][0];
    expect(prompt).toContain("Sara Ahmed");
    expect(prompt).toContain(customer.membershipNumber);
    expect(prompt).toMatch(/never ask them for/i);
  });

  it("omits the identity line (no crash) when the conversation/customer can't be found", async () => {
    await seedMessage("customer", "Hello?");
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(parentId.toHexString(), "Hello?");

    const prompt = spy.mock.calls[0][0];
    expect(prompt).not.toContain("Customer identity");
  });
});

describe("liveChatAi.service.ts getAiReply — ticket-context grounding (ai-features/live-chat)", () => {
  async function seedCustomerWithTicket(overrides: Partial<{ status: string; category: string | null }> = {}) {
    const customer = await User.create({
      name: "Sara Ahmed",
      email: `sara-${new mongoose.Types.ObjectId().toHexString()}@example.com`,
      passwordHash: "irrelevant-for-these-tests",
      role: "customer",
    });
    const ticket = await Ticket.create({
      subject: "Payment did not go through",
      description: "Details here",
      customer: customer._id,
      category: overrides.category ?? "Billing",
      priority: "medium",
      status: overrides.status ?? "in_progress",
    });
    const conversation = await Conversation.create({ customer: customer._id, status: "ai_handling" });
    return { customer, ticket, conversation };
  }

  it("grounds the prompt in the real ticket when the message names the customer's own ticket", async () => {
    const { ticket, conversation } = await seedCustomerWithTicket({ status: "in_progress" });
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(conversation.id, `What's happening with TCK-${ticket.ticketNumber}?`);

    const prompt = spy.mock.calls[0][0];
    expect(prompt).toContain(`TCK-${ticket.ticketNumber}`);
    expect(prompt).toContain("in_progress");
    expect(prompt).toMatch(/do not guess or invent/i);
  });

  it("records the inquiry on the ticket's chatInquiryHistory and logs ticket_referenced_in_chat", async () => {
    const { ticket, conversation } = await seedCustomerWithTicket();
    vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(conversation.id, `Any update on TCK-${ticket.ticketNumber}?`);

    const stored = await Ticket.findById(ticket._id);
    expect(stored!.chatInquiryHistory).toHaveLength(1);
    expect(stored!.chatInquiryHistory[0].conversation.toString()).toBe(conversation.id);

    const entry = await AuditLog.findOne({ action: "ticket_referenced_in_chat", targetId: ticket._id });
    expect(entry).not.toBeNull();
    expect(entry!.actor!.toString()).toBe(String(conversation.customer));
  });

  it("does not record a second inquiry entry for a repeated mention in the same conversation", async () => {
    const { ticket, conversation } = await seedCustomerWithTicket();
    vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(conversation.id, `Any update on TCK-${ticket.ticketNumber}?`);
    await getAiReply(conversation.id, `Still waiting on TCK-${ticket.ticketNumber}...`);

    const stored = await Ticket.findById(ticket._id);
    expect(stored!.chatInquiryHistory).toHaveLength(1);
    expect(await AuditLog.countDocuments({ action: "ticket_referenced_in_chat" })).toBe(1);
  });

  it("never grounds in, or leaks the existence of, another customer's ticket", async () => {
    const { ticket: foreignTicket } = await seedCustomerWithTicket();
    const { conversation } = await seedCustomerWithTicket();
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(conversation.id, `What about TCK-${foreignTicket.ticketNumber}?`);

    const prompt = spy.mock.calls[0][0];
    expect(prompt).not.toContain("do not guess or invent");
    expect(await AuditLog.countDocuments({ action: "ticket_referenced_in_chat" })).toBe(0);
    expect((await Ticket.findById(foreignTicket._id))!.chatInquiryHistory).toHaveLength(0);
  });

  it("ignores a message with no ticket reference", async () => {
    const { conversation } = await seedCustomerWithTicket();
    const spy = vi.spyOn(geminiService, "generateText").mockResolvedValue("ok");

    await getAiReply(conversation.id, "Hello, I have a question.");

    const prompt = spy.mock.calls[0][0];
    expect(prompt).not.toMatch(/do not guess or invent/i);
    expect(await AuditLog.countDocuments({ action: "ticket_referenced_in_chat" })).toBe(0);
  });
});

describe("liveChatAi.service.ts evaluateTicketSuggestion (Story 62)", () => {
  it("returns a suggestion when Gemini returns valid JSON with suggest: true", async () => {
    await seedMessage("customer", "I need to attach three screenshots and a long log.");
    vi.spyOn(geminiService, "generateText").mockResolvedValue(
      '{"suggest": true, "subject": "Attach screenshots and logs", "description": "Customer needs to attach files."}'
    );

    const suggestion = await evaluateTicketSuggestion(parentId.toHexString(), false);

    expect(suggestion).toEqual({
      subject: "Attach screenshots and logs",
      description: "Customer needs to attach files.",
    });
  });

  it("returns null when Gemini returns suggest: false", async () => {
    await seedMessage("customer", "What are your hours?");
    vi.spyOn(geminiService, "generateText").mockResolvedValue('{"suggest": false, "subject": "", "description": ""}');

    const suggestion = await evaluateTicketSuggestion(parentId.toHexString(), false);

    expect(suggestion).toBeNull();
  });

  it("strips a markdown code fence before parsing", async () => {
    await seedMessage("customer", "Help");
    vi.spyOn(geminiService, "generateText").mockResolvedValue(
      '```json\n{"suggest": true, "subject": "S", "description": "D"}\n```'
    );

    const suggestion = await evaluateTicketSuggestion(parentId.toHexString(), false);

    expect(suggestion).toEqual({ subject: "S", description: "D" });
  });

  it("returns null when generateText resolves to null (timeout/failure)", async () => {
    await seedMessage("customer", "Help");
    vi.spyOn(geminiService, "generateText").mockResolvedValue(null);

    const suggestion = await evaluateTicketSuggestion(parentId.toHexString(), false);

    expect(suggestion).toBeNull();
  });

  it("returns null on malformed / non-JSON Gemini output", async () => {
    await seedMessage("customer", "Help");
    vi.spyOn(geminiService, "generateText").mockResolvedValue("Sure, here's some prose, not JSON.");

    const suggestion = await evaluateTicketSuggestion(parentId.toHexString(), false);

    expect(suggestion).toBeNull();
  });

  it("returns null immediately, without calling Gemini, when alreadyDeclined is true", async () => {
    await seedMessage("customer", "Help");
    const spy = vi.spyOn(geminiService, "generateText");

    const suggestion = await evaluateTicketSuggestion(parentId.toHexString(), true);

    expect(suggestion).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("also includes the customer's identity in the classifier prompt", async () => {
    const customer = await User.create({
      name: "Sara Ahmed",
      email: "sara@example.com",
      passwordHash: "irrelevant-for-these-tests",
      role: "customer",
    });
    const conversation = await Conversation.create({ customer: customer._id, status: "ai_handling" });
    const spy = vi
      .spyOn(geminiService, "generateText")
      .mockResolvedValue('{"suggest": false, "subject": "", "description": ""}');

    await evaluateTicketSuggestion(conversation.id, false);

    const prompt = spy.mock.calls[0][0];
    expect(prompt).toContain("Sara Ahmed");
  });
});
