import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import type { JwtPayload } from "../middleware/auth";
import { Conversation } from "../models/Conversation";
import { Message } from "../models/Message";
import { Ticket } from "../models/Ticket";
import { User } from "../models/User";
import { sendEmail, renderEmailHtml } from "../services/email.service";
import { objectIdSchema } from "../validation/common";
import {
  conversationMessagePayloadSchema,
  conversationEscalatePayloadSchema,
  conversationClosePayloadSchema,
  conversationAiSuggestionDeclinedPayloadSchema,
  conversationClaimPayloadSchema,
} from "../validation/conversation.schema";
import { getAiReply, evaluateTicketSuggestion, evaluateKbSuggestion } from "../services/liveChatAi.service";
import { hasPermission } from "../services/permissions";
import { escalateConversation } from "../services/conversationEscalation.service";
import { recordAuditLog } from "../services/auditLog.service";

// customer-portal Story 39: same env-var fallback pattern as
// ticket.routes.ts's CLIENT_ORIGIN.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

const AI_FALLBACK_TEXT =
  "I'm having trouble answering right now — you can try again or ask to speak with a human agent.";

// The escalation ack message text/reasoning (why it's "system" not "ai", why
// it doesn't claim an agent has "joined") now lives in
// conversationEscalation.service.ts alongside ESCALATION_ACK_TEXT itself —
// see that file (sla-automation Story 28 extracted the escalation body out
// of this handler so the SLA monitor can call it without a socket).

/**
 * Socket.io wiring for the live-chat feature (Stories 14, 18: real-time messaging).
 * This is intentionally a thin skeleton — connection/room handling only. The actual
 * message-handling logic (persisting to Message, invoking the AI agent on the
 * customer's first message, escalation, claiming) belongs to each story's
 * implementation and should live in src/services/ + be called from here, not
 * written inline in these handlers.
 */

interface ConversationMessagePayload {
  conversationId: string;
  text: string;
  [key: string]: unknown;
}

const conversationIdSchema = objectIdSchema("Invalid conversation id");
const ticketIdSchema = objectIdSchema("Invalid ticket id");

// Whether `user` may VIEW `conversation` (join its room to read the
// transcript and receive live updates) or close it — the conversation's own
// customer, its current claimant (assignedAgent), any admin, or a sub-admin
// holding chats:manage (mirrors conversation.routes.ts's
// callerAuthorizedOnConversation, duplicated rather than imported so this
// module stays independent of the REST route file). This is deliberately
// broader than "may send a message" — see isClaimant below, which gates
// conversation:message — so an admin/subadmin/agent with chats:manage can
// still watch a chat they haven't claimed. Async because of the live
// permission lookup — a stale JWT-carried permissions snapshot must never
// gate a live socket action (socket.data.user deliberately carries only
// { id, role, name }, never permissions).
async function isAuthorizedOnConversation(
  user: { id: string; role: string },
  conversation: { customer: unknown; assignedAgent: unknown }
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (user.role === "subadmin") return hasPermission(user.id, "chats:manage");
  if (user.role === "agent") {
    // An agent holding chats:manage can view ANY conversation, not just one
    // already assigned to them — they need to be able to see (and then
    // claim, via conversation:claim) an unclaimed escalated chat. Without
    // this, a plain agent could never even open a chat they haven't claimed
    // yet to decide whether to claim it.
    return user.id === String(conversation.assignedAgent) || hasPermission(user.id, "chats:manage");
  }
  return user.id === String(conversation.customer);
}

// Whether `user` currently holds the exclusive claim on `conversation` — the
// only people allowed to actually send a staff reply (conversation:message
// below). Unlike isAuthorizedOnConversation, this has no admin/subadmin
// bypass: per this feature's design, EVERY staff role (agent, subadmin,
// admin) must click "Join chat" before replying, with no exceptions — a
// deliberate change from this conversation's earlier "any admin can jump
// into any chat" behavior.
function isClaimant(user: { id: string }, conversation: { assignedAgent: unknown }): boolean {
  return conversation.assignedAgent != null && user.id === String(conversation.assignedAgent);
}

// Whether `user` is eligible to claim a conversation at all (conversation:claim
// below) — admin always, agent/subadmin only when holding chats:manage (the
// same permission scope the old auto-assign picker used to require).
async function canClaimConversation(user: { id: string; role: string }): Promise<boolean> {
  if (user.role === "admin") return true;
  if (user.role === "agent" || user.role === "subadmin") return hasPermission(user.id, "chats:manage");
  return false;
}

// Most conversations never have a ticket opened from them (Story 62's "open
// a ticket" suggestion is declinable) — this records a join/leave event on
// whichever ticket(s), if any, have `sourceConversation` pointing at this
// conversation. updateMany rather than findOne+update: there's no unique
// index on sourceConversation, so if more than one ticket somehow points at
// the same conversation, every one of them gets the event. Best-effort, same
// reasoning as notification.service.ts's helpers: a DB hiccup here must
// never break the claim/release flow it rides along on.
async function recordChatPresenceEventOnTicket(
  conversationId: string,
  event: "joined" | "left",
  userId: string
): Promise<void> {
  try {
    await Ticket.updateMany(
      { sourceConversation: conversationId },
      { $push: { chatPresenceHistory: { event, user: userId, at: new Date() } } }
    );
  } catch (err) {
    console.error("[chat.socket] failed to record chat presence on ticket history:", (err as Error).message);
  }
}

export function registerChatHandlers(io: Server): void {
  // Story 14: Socket.io connections carry a JWT in the handshake `auth`
  // payload, verified once at connect-time — reuses the same JWT_SECRET/
  // JwtPayload shape requireAuth already uses (middleware/auth.ts), so
  // there's one auth model across REST and sockets. An alternative
  // (re-authenticating every conversation:message against the DB) was
  // rejected: later stories (16 escalate, 18 agent reply) need the caller's
  // role available at message time, which this way is already on
  // socket.data.user with no per-event DB lookup.
  io.use((socket: Socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ||
      (socket.handshake.headers.authorization?.startsWith("Bearer ")
        ? socket.handshake.headers.authorization.slice(7)
        : undefined);

    if (!token) {
      next(new Error("Unauthorized"));
      return;
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload;
      // name rides along from the already-verified JWT (same claim
      // req.user.name already carries over REST) so the claim broadcast
      // below can show a real name with zero extra DB lookups. Still never
      // carries permissions — see isAuthorizedOnConversation's comment for
      // why that stays true.
      socket.data.user = { id: payload.sub, role: payload.role, name: payload.name };
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    console.log(`[socket] client connected: ${socket.id}`);

    // Every authenticated connection (not just chat-page ones) joins its own
    // personal room, keyed by user id — this is what lets
    // notification.service.ts push a real-time event to a specific user from
    // outside the chat feature entirely (see ioRegistry.ts), without needing
    // to know which conversation, if any, that user currently has open.
    socket.join(`user:${socket.data.user.id}`);

    // ticket-management: every staff connection also joins a shared room so
    // ticketRealtime.service.ts can wake anyone with a ticket list/queue open
    // without needing to know who's currently viewing which page — a
    // customer never joins this room, their own list is covered by the
    // personal `user:<id>` room above instead (ticketRealtime.service.ts
    // emits to both).
    if (socket.data.user.role !== "customer") {
      socket.join("staff:tickets");
    }

    // Client joins the room for a specific ticket so a live "someone changed
    // this ticket" push (ticketRealtime.service.ts) only reaches whoever has
    // that exact ticket's detail page open. Authorization mirrors GET
    // /:id in ticket.routes.ts: any staff role may join any ticket; a
    // customer only their own — silently ignored otherwise (no error event),
    // same "don't reveal whether it exists" reasoning as that route's 404.
    socket.on("ticket:join", async (ticketId: string) => {
      const parsedId = ticketIdSchema.safeParse(ticketId);
      if (!parsedId.success) return;
      const ticket = await Ticket.findById(ticketId).select("customer");
      if (!ticket) return;
      if (socket.data.user.role === "customer" && String(ticket.customer) !== socket.data.user.id) {
        return;
      }
      socket.join(`ticket:${ticketId}`);
    });

    socket.on("ticket:leave", (ticketId: string) => {
      const parsedId = ticketIdSchema.safeParse(ticketId);
      if (!parsedId.success) return;
      socket.leave(`ticket:${ticketId}`);
    });

    // Client joins the room for a specific conversation so messages only broadcast
    // to participants of that conversation.
    socket.on("conversation:join", async (conversationId: string) => {
      const parsedId = conversationIdSchema.safeParse(conversationId);
      if (!parsedId.success) {
        socket.emit("conversation:error", { error: "Invalid conversation id" });
        return;
      }

      const conversation = await Conversation.findById(parsedId.data);
      if (!conversation) {
        socket.emit("conversation:error", { error: "Conversation not found" });
        return;
      }

      if (!(await isAuthorizedOnConversation(socket.data.user, conversation))) {
        socket.emit("conversation:error", { error: "You do not have permission to join this conversation" });
        return;
      }

      socket.join(`conversation:${conversationId}`);
      socket.emit("conversation:joined", { conversationId });
    });

    // Story 14: validates sender, persists the message, and broadcasts it.
    // Story 15: right after the customer's own message is persisted and
    // broadcast, triggers the AI agent's reply — see the guard below.
    socket.on("conversation:message", async (payload: ConversationMessagePayload) => {
      const parsed = conversationMessagePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("conversation:error", { error: parsed.error.issues[0]?.message ?? "Invalid message" });
        return;
      }
      const { conversationId, text } = parsed.data;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        socket.emit("conversation:error", { error: "Conversation not found" });
        return;
      }

      const isOwnCustomer = socket.data.user.id === String(conversation.customer);
      // Replying is narrower than viewing: a staff member must hold the
      // exclusive claim on this conversation (isClaimant), not merely be
      // authorized to view it (isAuthorizedOnConversation, used by
      // conversation:join/close below) — see isClaimant's own comment for
      // why there is no admin/subadmin bypass here. A foreign customer (not
      // this conversation's own) keeps the original error text so the
      // existing "rejects a message from a foreign sender" behavior is
      // unchanged.
      if (!isOwnCustomer && !isClaimant(socket.data.user, conversation)) {
        socket.emit("conversation:error", {
          error:
            socket.data.user.role === "customer"
              ? "You do not have permission to send messages in this conversation"
              : "Join this chat before replying — it hasn't been claimed by you.",
        });
        return;
      }

      if (conversation.status === "resolved") {
        socket.emit("conversation:error", { error: "This conversation is closed" });
        return;
      }

      const senderType = isOwnCustomer ? "customer" : "agent";

      const message = await Message.create({
        parentType: "conversation",
        parentId: conversation._id,
        senderType,
        senderId: socket.data.user.id,
        text,
      });

      io.to(`conversation:${conversationId}`).emit("conversation:message", message);

      // Story 15: the AI agent answers every customer message up until a
      // human actually claims the chat. This deliberately covers BOTH
      // "ai_handling" and "escalated" — escalating (asking for a human) only
      // flags the chat for pickup and shows the customer a "someone will
      // join shortly" banner; it does not mean a human is present yet. Before
      // this fix, the AI branch only ran in "ai_handling", so a customer who
      // escalated and then kept typing while waiting got no reply at all
      // until an agent clicked "Join chat" (status -> "with_agent", which is
      // correctly excluded here since a human is actually handling by then).
      if (
        senderType === "customer" &&
        (conversation.status === "ai_handling" || conversation.status === "escalated")
      ) {
        const roomKey = `conversation:${conversationId}`;
        io.to(roomKey).emit("conversation:ai-typing", { conversationId });

        try {
          // Story 62's ticket-suggestion classifier and ai-features Story
          // 34/35's KB-content suggestion both run alongside the normal
          // reply, not instead of it -- each is independently safe/
          // non-throwing (see liveChatAi.service.ts), so a Promise.all here
          // never lets one call's failure affect the others.
          const [reply, ticketSuggestion, kbSuggestion] = await Promise.all([
            getAiReply(conversationId, text),
            evaluateTicketSuggestion(conversationId, conversation.aiTicketSuggestionDeclined),
            evaluateKbSuggestion(text),
          ]);
          const aiMessage = await Message.create({
            parentType: "conversation",
            parentId: conversation._id,
            senderType: "ai",
            senderId: null,
            text: reply ?? AI_FALLBACK_TEXT,
            aiTicketSuggestion: ticketSuggestion,
            aiKbSuggestion: kbSuggestion,
          });
          io.to(roomKey).emit("conversation:message", aiMessage);
        } catch (err) {
          console.error("[chat.socket] AI branch failed:", (err as Error).message);
          try {
            const fallback = await Message.create({
              parentType: "conversation",
              parentId: conversation._id,
              senderType: "ai",
              senderId: null,
              text: AI_FALLBACK_TEXT,
            });
            io.to(roomKey).emit("conversation:message", fallback);
          } catch (innerErr) {
            console.error("[chat.socket] fallback persistence also failed:", (innerErr as Error).message);
          }
        }
      }
    });

    // Story 62: customer declines the AI's "open a ticket" suggestion —
    // records it so the classifier stops being called for this conversation
    // (evaluateTicketSuggestion's alreadyDeclined short-circuit above). No
    // broadcast needed; the declining client already updates its own local
    // state on click, and no one else needs to know.
    socket.on("conversation:ai-suggestion-declined", async (payload: { conversationId: string }) => {
      const parsed = conversationAiSuggestionDeclinedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("conversation:error", { error: parsed.error.issues[0]?.message ?? "Invalid payload" });
        return;
      }
      const { conversationId } = parsed.data;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        socket.emit("conversation:error", { error: "Conversation not found" });
        return;
      }
      if (socket.data.user.id !== String(conversation.customer)) {
        socket.emit("conversation:error", { error: "You do not have permission to update this conversation" });
        return;
      }
      if (!conversation.aiTicketSuggestionDeclined) {
        conversation.aiTicketSuggestionDeclined = true;
        await conversation.save();
      }
    });

    // Story 16: customer-triggered "talk to a human" — flips status to
    // "escalated", which is enough on its own to disable the Story 15 AI
    // branch above (it only fires while status === "ai_handling"). Chat
    // assignment is no longer automatic (see conversation:claim below) — this
    // handler's only job is to flip status, leave a durable acknowledgment,
    // and tell every eligible staff member a chat needs picking up.
    socket.on("conversation:escalate", async (payload: { conversationId: string }) => {
      const parsed = conversationEscalatePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("conversation:error", { error: parsed.error.issues[0]?.message ?? "Invalid escalate payload" });
        return;
      }
      const { conversationId } = parsed.data;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        socket.emit("conversation:error", { error: "Conversation not found" });
        return;
      }

      // Customer-only: agents never escalate on the customer's behalf in
      // this story (stricter than isAuthorizedOnConversation, which also
      // allows the assignedAgent).
      if (socket.data.user.id !== String(conversation.customer)) {
        socket.emit("conversation:error", { error: "You do not have permission to escalate this conversation" });
        return;
      }

      if (conversation.status === "resolved") {
        socket.emit("conversation:error", { error: "This conversation is closed" });
        return;
      }

      // Determined before calling the service (which has its own, separate
      // idempotency guard) purely to pick which socket event to emit below —
      // a no-op re-emits directly to the caller only, so a reconnecting
      // client can re-sync its UI state without erroring the whole room.
      const wasAlreadyEscalated = conversation.status === "escalated" || conversation.status === "with_agent";

      const { conversation: updated, ackMessage } = await escalateConversation({ conversation, reason: "manual" });

      if (wasAlreadyEscalated) {
        socket.emit("conversation:escalated", { conversationId, status: updated.status });
        return;
      }

      await recordAuditLog({
        actor: socket.data.user.id,
        action: "chat_escalated",
        targetType: "Conversation",
        targetId: conversationId,
        ipAddress: socket.handshake.address,
      });

      io.to(`conversation:${conversationId}`).emit("conversation:escalated", {
        conversationId,
        status: "escalated",
      });

      // ackMessage is null when the post-escalation ack/notify best-effort
      // step failed (logged inside the service) — nothing to broadcast then.
      if (ackMessage) {
        io.to(`conversation:${conversationId}`).emit("conversation:message", ackMessage);
      }
    });

    // The "Join chat" button — a staff member (agent/subadmin holding
    // chats:manage, or any admin) explicitly claims exclusive ownership of a
    // conversation. Atomic on the { assignedAgent: null } guard: two staff
    // members clicking Join on the same conversation at nearly the same
    // moment can't both succeed — MongoDB's single-document update is the
    // race-free boundary, no separate mutex needed (unlike the old
    // load-balanced auto-pick, which had to serialize its own "who's least
    // busy" read before writing). Until this succeeds, nobody but the
    // conversation's own customer can send a message (see
    // conversation:message above).
    socket.on("conversation:claim", async (payload: { conversationId: string }) => {
      const parsed = conversationClaimPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("conversation:error", { error: parsed.error.issues[0]?.message ?? "Invalid claim payload" });
        return;
      }
      const { conversationId } = parsed.data;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        socket.emit("conversation:error", { error: "Conversation not found" });
        return;
      }

      if (!(await canClaimConversation(socket.data.user))) {
        socket.emit("conversation:error", { error: "You do not have permission to claim this conversation" });
        return;
      }

      if (conversation.status === "resolved") {
        socket.emit("conversation:error", { error: "This conversation is closed" });
        return;
      }

      if (isClaimant(socket.data.user, conversation)) {
        // Idempotent: already the claimant (e.g. a reconnecting tab) is a
        // no-op success, re-synced directly to the caller.
        socket.emit("conversation:claimed", {
          conversationId,
          agent: { id: socket.data.user.id, name: socket.data.user.name },
        });
        return;
      }

      const claimed = await Conversation.findOneAndUpdate(
        { _id: conversationId, assignedAgent: null },
        { $set: { assignedAgent: socket.data.user.id, status: "with_agent" } },
        { new: true }
      );
      if (!claimed) {
        socket.emit("conversation:error", {
          error: "This chat is already being handled by another staff member.",
        });
        return;
      }

      // Ticket-history write is best-effort, same reasoning as
      // notification.service.ts's helpers — never lets a DB hiccup here
      // undo the claim that already succeeded above.
      await recordChatPresenceEventOnTicket(conversationId, "joined", socket.data.user.id);

      await recordAuditLog({
        actor: socket.data.user.id,
        action: "chat_claimed",
        targetType: "Conversation",
        targetId: conversationId,
        ipAddress: socket.handshake.address,
      });

      const agentInfo = { id: socket.data.user.id, name: socket.data.user.name };
      io.to(`conversation:${conversationId}`).emit("conversation:claimed", { conversationId, agent: agentInfo });

      // The customer-facing "a support agent has joined" hint now fires
      // right here, at the moment of the real, authoritative claim — not on
      // that person's first message (the old Story 18 heuristic, no longer
      // needed now that claiming is an explicit, unambiguous action).
      if (!claimed.agentJoinedAnnounced) {
        await Conversation.updateOne({ _id: conversationId }, { $set: { agentJoinedAnnounced: true } });
        io.to(`conversation:${conversationId}`).emit("conversation:assigned", {
          conversationId,
          agentId: socket.data.user.id,
          status: "with_agent",
        });
      }
    });

    // The "Leave chat" button — releases the caller's own claim, reverting
    // to "escalated" so it goes back into the pool anyone eligible can claim
    // again. Only the current claimant can release their own claim (no
    // admin override to force-release someone else's — not requested, and
    // reassignment isn't this feature's concern).
    socket.on("conversation:unclaim", async (payload: { conversationId: string }) => {
      const parsed = conversationClaimPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("conversation:error", { error: parsed.error.issues[0]?.message ?? "Invalid unclaim payload" });
        return;
      }
      const { conversationId } = parsed.data;

      const released = await Conversation.findOneAndUpdate(
        { _id: conversationId, assignedAgent: socket.data.user.id },
        { $set: { assignedAgent: null, status: "escalated" } },
        { new: true }
      );
      if (!released) {
        socket.emit("conversation:error", { error: "You are not currently handling this conversation" });
        return;
      }

      await recordChatPresenceEventOnTicket(conversationId, "left", socket.data.user.id);

      await recordAuditLog({
        actor: socket.data.user.id,
        action: "chat_unclaimed",
        targetType: "Conversation",
        targetId: conversationId,
        ipAddress: socket.handshake.address,
      });

      io.to(`conversation:${conversationId}`).emit("conversation:unclaimed", { conversationId });
    });

    // Story 19: widened from customer-only (Story 17's minimal version) to
    // isAuthorizedOnConversation — customer, assignedAgent, or admin can all
    // mark a chat resolved now.
    socket.on("conversation:close", async (payload: { conversationId: string }) => {
      const parsed = conversationClosePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit("conversation:error", { error: parsed.error.issues[0]?.message ?? "Invalid close payload" });
        return;
      }
      const { conversationId } = parsed.data;

      const conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        socket.emit("conversation:error", { error: "Conversation not found" });
        return;
      }

      if (!(await isAuthorizedOnConversation(socket.data.user, conversation))) {
        socket.emit("conversation:error", { error: "You do not have permission to close this conversation" });
        return;
      }

      if (conversation.status === "resolved") {
        socket.emit("conversation:closed", { conversationId, status: "resolved" });
        return;
      }

      // assignedAgent is intentionally left untouched — history keeps it.
      conversation.status = "resolved";
      await conversation.save();

      await recordAuditLog({
        actor: socket.data.user.id,
        action: "chat_closed",
        targetType: "Conversation",
        targetId: conversationId,
        ipAddress: socket.handshake.address,
      });

      io.to(`conversation:${conversationId}`).emit("conversation:closed", {
        conversationId,
        status: "resolved",
      });

      // customer-portal Story 39: same "rate your experience" trigger as
      // ticket.routes.ts's PATCH /:id/status, mirrored for the conversation
      // side — best-effort, never blocks/fails the close itself (already
      // broadcast above by this point regardless of email outcome).
      try {
        const feedbackCustomer = await User.findById(conversation.customer).select("name email");
        if (feedbackCustomer) {
          const feedbackUrl = `${CLIENT_ORIGIN}/feedback/conversation/${conversation.id}`;
          await sendEmail({
            to: feedbackCustomer.email,
            subject: "Your chat is resolved",
            text: `Hi ${feedbackCustomer.name},\n\nYour live chat has been resolved. We'd love to know how we did: ${feedbackUrl}`,
            html: renderEmailHtml({
              heading: "Your chat is resolved",
              bodyHtml: `Hi ${feedbackCustomer.name},<br><br>Your live chat has been resolved. We'd love to know how we did.`,
              ctaText: "Rate your experience",
              ctaUrl: feedbackUrl,
            }),
          });
        }
      } catch (err) {
        console.error("[chat.socket] resolution email failed", err);
      }
    });

    // A claim tied to a session that just vanished (crash, closed tab,
    // network drop) must not stay locked forever with no one able to reply
    // — so a disconnect auto-releases any conversation this socket's user
    // was the claimant of, same effect as clicking "Leave chat" themselves.
    // `disconnecting` fires WHILE the socket is still a member of its rooms;
    // `disconnect` fires AFTER Socket.io has removed it from all of them —
    // capturing the room list in the first and acting in the second is what
    // lets a single find-by-room-prefix work without extra bookkeeping.
    let conversationRoomsAtDisconnect: string[] = [];
    socket.on("disconnecting", () => {
      conversationRoomsAtDisconnect = [...socket.rooms].filter((room) => room.startsWith("conversation:"));
    });

    socket.on("disconnect", async () => {
      console.log(`[socket] client disconnected: ${socket.id}`);
      if (!socket.data.user || socket.data.user.role === "customer") return;
      for (const room of conversationRoomsAtDisconnect) {
        const conversationId = room.slice("conversation:".length);
        try {
          const released = await Conversation.findOneAndUpdate(
            { _id: conversationId, assignedAgent: socket.data.user.id },
            { $set: { assignedAgent: null, status: "escalated" } },
            { new: true }
          );
          if (released) {
            await recordChatPresenceEventOnTicket(conversationId, "left", socket.data.user.id);
            await recordAuditLog({
              actor: socket.data.user.id,
              action: "chat_unclaimed",
              targetType: "Conversation",
              targetId: conversationId,
              metadata: { reason: "disconnect" },
              ipAddress: socket.handshake.address,
            });
            io.to(room).emit("conversation:unclaimed", { conversationId });
          }
        } catch (err) {
          console.error("[chat.socket] failed to auto-release claim on disconnect:", (err as Error).message);
        }
      }
    });
  });
}
