import { Types } from "mongoose";
import { Message } from "../models/Message";
import { Conversation } from "../models/Conversation";
import { Ticket } from "../models/Ticket";
import { generateText } from "./gemini.service";
import { suggestKbContent, type KbSuggestion } from "./kbAi.service";
import { recordAuditLog } from "./auditLog.service";

export type { KbSuggestion };

/**
 * Builds the Gemini prompt for live-chat Story 15 (AI agent responds first)
 * from recent conversation history, and returns the AI's reply text.
 * Kept separate from gemini.service.ts, which stays a generic client shared
 * with the unrelated ai-features stories.
 */

const HISTORY_LIMIT = 20;

const SENDER_LABELS: Record<string, string> = {
  customer: "Customer",
  ai: "AI Agent",
  agent: "Agent",
};

const SYSTEM_PREAMBLE =
  "You are the AI support agent for a customer service platform. Reply concisely " +
  "and helpfully to the customer's latest message, in at most 2-3 short sentences. " +
  "The customer is already signed in and identified below -- never ask them for " +
  "their name, account/membership number, or email to 'verify' or 'look up' their " +
  "account; you already have it. Only ask for details specific to the problem " +
  "itself (e.g. an order number, a screenshot, steps to reproduce).";

// Grounding facts about what this specific platform actually contains --
// added after live testing surfaced Gemini inventing a "Help section ->
// Contact Us" navigation flow and an account "membership switching" feature,
// neither of which exist. Without this, the model has zero information about
// this app's real pages/features and falls back to generic SaaS-support
// boilerplate that happens to sound plausible but is simply wrong for this
// product. Keep this in sync with the actual customer-facing surface
// (frontend/app/support/page.tsx and its three cards) -- if a real feature
// changes shape, this text goes stale and starts producing the same kind of
// hallucination it was written to prevent.
const PLATFORM_FACTS =
  "Facts about this specific platform -- get these right, and do not invent a " +
  "different navigation path, button, page, or feature that isn't listed here: " +
  "To open a NEW support ticket, the customer goes to the 'Get support' page " +
  "(linked from the main navigation) and clicks 'Submit a ticket', which opens a " +
  "ticket form -- or you (the AI Agent) can offer to open one for them directly in " +
  "this chat if that fits the conversation. There is no 'Contact Us' page and no " +
  "'Help section' inside a dashboard for opening tickets -- do not describe one. " +
  "The 'Help' page/link is a SEPARATE self-service knowledge base of FAQs and help " +
  "articles for browsing, not for submitting a ticket. There is no account " +
  "'membership switching', multi-account, or account-linking feature of any kind " +
  "-- never claim one exists. If you are not confident a specific button, page, or " +
  "feature exists, describe the goal in general terms instead of naming a UI " +
  "element you are not certain about.";

async function fetchTranscript(conversationId: string): Promise<string> {
  const history = await Message.find({ parentType: "conversation", parentId: conversationId })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  history.reverse();

  return history
    .filter((message) => !message.internal && message.senderType !== "system")
    .map((message) => `${SENDER_LABELS[message.senderType] ?? message.senderType}: ${message.text}`)
    .join("\n");
}

// The customer is already authenticated for the whole chat session -- feed
// their identity into the prompt so the AI never has to ask for it (the gap
// that prompted this: without this, Gemini had no way to know who it was
// talking to and asked for an account number mid-conversation). Best-effort:
// a lookup failure just means the identity line is omitted, never a hard
// failure of the AI reply itself.
async function fetchCustomerContext(conversationId: string): Promise<string> {
  try {
    const conversation = await Conversation.findById(conversationId).populate<{
      customer: { name: string; membershipNumber: string } | null;
    }>("customer", "name membershipNumber");
    const customer = conversation?.customer;
    if (!customer) return "";
    return `Customer identity (already verified, do not ask for this again): name "${customer.name}", membership number ${customer.membershipNumber}.\n\n`;
  } catch {
    return "";
  }
}

// Matches the "TCK-<n>" reference shown to customers everywhere a ticket is
// surfaced (emails, the ticket list, tickets/[id] itself — see
// ticket.routes.ts's referenceNumber) — customers naturally quote that exact
// string back, or a loose variant of it ("TCK 5", "TCK5"). Deliberately not
// matched more loosely (e.g. bare "ticket 5"): a wrong match here would ground
// the AI's reply in the WRONG ticket's data and state it as fact.
const TICKET_REFERENCE_PATTERN = /\bTCK-?\s*(\d+)\b/i;

// ai-features/live-chat: the AI agent now has real grounding into the
// customer's own tickets — when their latest message names one (by its
// TCK-<n> reference), this looks up the real record scoped to THIS customer
// (never confirms/denies a ticket number that isn't theirs) and returns a
// context block Gemini must answer from, instead of guessing/inventing a
// status. Records the inquiry on the ticket itself (chatInquiryHistory,
// surfaced in its history timeline as "chat_inquiry" — see
// ticketHistory.service.ts) and an audit log entry, but only once per
// conversation — a customer repeating the same reference several times in one
// chat should not spam the ticket's history with duplicate entries.
async function fetchTicketContext(conversationId: string, latestCustomerMessage: string): Promise<string> {
  const match = latestCustomerMessage.match(TICKET_REFERENCE_PATTERN);
  if (!match) return "";
  const ticketNumber = Number(match[1]);
  if (!Number.isFinite(ticketNumber)) return "";

  try {
    const conversation = await Conversation.findById(conversationId).select("customer");
    if (!conversation) return "";

    const ticket = await Ticket.findOne({ ticketNumber, customer: conversation.customer });
    if (!ticket) return "";

    const alreadyRecorded = ticket.chatInquiryHistory.some(
      (entry) => entry.conversation.toString() === conversationId
    );
    if (!alreadyRecorded) {
      ticket.chatInquiryHistory.push({ conversation: new Types.ObjectId(conversationId), at: new Date() });
      await ticket.save();

      await recordAuditLog({
        actor: String(conversation.customer),
        action: "ticket_referenced_in_chat",
        targetType: "Ticket",
        targetId: String(ticket._id),
      });
    }

    return (
      `The customer is asking about their existing ticket TCK-${ticket.ticketNumber} ("${ticket.subject}"). ` +
      `Its real current status is "${ticket.status}", category "${ticket.category ?? "unspecified"}", ` +
      `priority "${ticket.priority}". Answer using ONLY this information for this ticket -- do not guess or ` +
      "invent any other detail (no made-up resolution, no made-up timeline) beyond what's stated here.\n\n"
    );
  } catch (err) {
    console.error("[liveChatAi] fetchTicketContext failed:", (err as Error).message);
    return "";
  }
}

export async function getAiReply(conversationId: string, latestCustomerMessage: string): Promise<string | null> {
  try {
    const [customerContext, ticketContext, transcript] = await Promise.all([
      fetchCustomerContext(conversationId),
      fetchTicketContext(conversationId, latestCustomerMessage),
      fetchTranscript(conversationId),
    ]);
    const prompt = `${SYSTEM_PREAMBLE}\n\n${PLATFORM_FACTS}\n\n${customerContext}${ticketContext}${transcript}\nAI Agent:`;

    const reply = await generateText(prompt);
    if (!reply || reply.trim().length === 0) {
      return null;
    }
    return reply.trim();
  } catch (err) {
    console.error("[liveChatAi] getAiReply failed:", (err as Error).message);
    return null;
  }
}

export interface TicketSuggestion {
  subject: string;
  description: string;
}

// Story 62 (live-chat): a second, smaller, single-purpose Gemini call run in
// parallel with getAiReply — kept separate so getAiReply's plain-text
// contract stays stable and each call can independently timeout/fallback
// per CLAUDE.md's "wrap every Gemini call with a timeout and a graceful
// fallback." Deliberately NOT parsed out of the main reply's text (no
// sentinel/marker parsing of free-form prose).
const SUGGESTION_SYSTEM_PREAMBLE =
  "You are a triage classifier for a customer service live chat. Default to " +
  'suggest: false. Most messages -- small talk, general knowledge questions ' +
  "(e.g. asking about the weather, or anything unrelated to this company's " +
  "product/service), a question you can just answer directly, or a problem " +
  "you already resolved in this conversation -- do NOT need a ticket. Only " +
  "set suggest: true when the customer's LATEST message clearly meets one of " +
  "these two conditions: (1) they explicitly ask to open/file a ticket, submit " +
  "a complaint in writing, or speak to a human/agent, or (2) they are visibly " +
  "frustrated, angry, or repeating the same unresolved account/service " +
  "problem, AND that problem genuinely needs a long written follow-up, file " +
  "attachments, or account-specific investigation beyond a quick chat reply. " +
  "When in doubt, prefer suggest: false and just let the normal chat reply " +
  "handle it. Respond with ONLY strict JSON, no markdown, no commentary, in " +
  'exactly this shape: {"suggest": boolean, "subject": string, "description": ' +
  'string}. When suggest is false, subject and description may be empty ' +
  "strings. Keep subject under 100 characters. Write subject/description in " +
  "the same language the customer is writing in.";

function parseSuggestionJson(raw: string): { suggest: boolean; subject: string; description: string } | null {
  try {
    // Gemini sometimes wraps JSON in a markdown code fence despite
    // instructions not to -- strip that defensively before parsing.
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const parsed = JSON.parse(stripped);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.suggest !== "boolean" ||
      typeof parsed.subject !== "string" ||
      typeof parsed.description !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Returns a ticket suggestion when the classifier decides this conversation
 * would be better handled as a ticket, or null otherwise (including on any
 * failure/timeout/malformed output -- never blocks the customer). Skips the
 * Gemini call entirely once the customer has declined a suggestion this
 * conversation (`alreadyDeclined`), per Story 62's "do not re-suggest" rule.
 */
export async function evaluateTicketSuggestion(
  conversationId: string,
  alreadyDeclined: boolean
): Promise<TicketSuggestion | null> {
  if (alreadyDeclined) return null;

  try {
    const [customerContext, transcript] = await Promise.all([
      fetchCustomerContext(conversationId),
      fetchTranscript(conversationId),
    ]);
    const prompt = `${SUGGESTION_SYSTEM_PREAMBLE}\n\n${customerContext}Conversation so far:\n${transcript}`;

    const raw = await generateText(prompt);
    if (!raw) return null;

    const parsed = parseSuggestionJson(raw);
    if (!parsed || !parsed.suggest) return null;

    return { subject: parsed.subject.trim(), description: parsed.description.trim() };
  } catch (err) {
    console.error("[liveChatAi] evaluateTicketSuggestion failed:", (err as Error).message);
    return null;
  }
}

// ai-features Story 34/35 (live-chat half): thin wrapper so chat.socket.ts
// only ever imports AI assists from this file, matching getAiReply/
// evaluateTicketSuggestion above — the actual FAQ/article retrieval lives in
// kbAi.service.ts alongside the admin-authoring assists it's built the same
// way as. Wrapped in its own try/catch (unlike suggestKbContent itself,
// which only wraps the Gemini call) so a DB hiccup on the shortlist query
// can't take down the reply/ticket-suggestion calls it runs alongside in
// chat.socket.ts's Promise.all.
export async function evaluateKbSuggestion(latestCustomerMessage: string): Promise<KbSuggestion | null> {
  try {
    return await suggestKbContent(latestCustomerMessage);
  } catch (err) {
    console.error("[liveChatAi] evaluateKbSuggestion failed:", (err as Error).message);
    return null;
  }
}
