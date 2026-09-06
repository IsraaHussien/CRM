import { Types } from "mongoose";
import { Ticket, ITicket } from "../models/Ticket";
import { Conversation, IConversation } from "../models/Conversation";
import { User } from "../models/User";
import { getSlaSystemSettings } from "../models/SlaSystemSettings";
import {
  createTicketNotification,
  notifyTicketOversight,
  createConversationNotification,
  notifyChatOversight,
} from "./notification.service";
import { sendEmail, renderEmailHtml } from "./email.service";
import { escalateTicket } from "./ticketEscalation.service";
import { escalateConversation } from "./conversationEscalation.service";
import { recordAuditLog } from "./auditLog.service";
import { getIoInstance } from "../sockets/ioRegistry";

// sla-automation Story 28: proactively scans open tickets/conversations for
// approaching-breach and breached SLA timers (Story 26's responseTargetAt /
// resolutionTargetAt), instead of waiting for someone to read a ticket to
// find out. See .squad/plans/sla-automation/39-story-sla-breach-alerts-and-auto-escalation.md.

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

// escalateTicket rejects escalatedToUserId === changedBy (no self-
// escalation — see ticketEscalation.service.ts). There is no "system" User
// account to attribute an automated escalation to, so this picks two
// DISTINCT active staff members instead: one as the escalation target
// (never the ticket's own current assignee, per the "assignee equals
// escalation target" edge case), one to stand in as the actor performing
// the change. Prefers admins, falls back to subadmins (both are valid
// escalateTicket targets — see that service's role check). Returns null
// when fewer than two distinct candidates exist; the caller then skips the
// escalate call for this tick but still fires notifications and flips
// sla.breached, so nothing is silently retried forever.
async function pickEscalationPair(
  excludeUserId?: Types.ObjectId | null
): Promise<{ target: Types.ObjectId; actor: Types.ObjectId } | null> {
  const candidates = await User.find({
    role: { $in: ["admin", "subadmin"] },
    isActive: true,
    isDeleted: { $ne: true },
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
  })
    .sort({ role: 1 }) // "admin" sorts before "subadmin" — prefer an admin pair when available
    .select("_id")
    .limit(2)
    .lean();
  if (candidates.length < 2) return null;
  return { target: candidates[0]._id, actor: candidates[1]._id };
}

type ScanOutcome = "breached" | "at_risk" | "none";

async function scanTicket(ticket: ITicket, atRiskPercent: number, now: Date): Promise<ScanOutcome> {
  // Response and resolution targets are always written together (Story 26)
  // and resolutionMinutes >= responseMinutes is enforced at the SlaTarget
  // level (Story 25), so responseTargetAt — when present — is always the
  // nearer deadline. A ticket only stays in this query's scope while
  // sla.breached is false, so the moment the nearer target is crossed this
  // same tick flips it to true and the ticket drops out of scope for every
  // future tick — there's no scenario where responseTargetAt has already
  // passed yet the ticket is still being scanned against resolutionTargetAt.
  const activeTarget = ticket.sla.responseTargetAt ?? ticket.sla.resolutionTargetAt;
  if (!activeTarget) return "none"; // no SlaTarget was configured when this ticket was created

  if (now.getTime() >= activeTarget.getTime()) {
    ticket.sla.breached = true;
    ticket.slaHistory.push({ event: "breached", at: now });
    await ticket.save();

    if (ticket.assignedAgent) {
      await createTicketNotification({ recipient: ticket.assignedAgent, type: "sla_breached", ticketId: ticket._id });
    }
    await notifyTicketOversight({ type: "sla_breached", ticketId: ticket._id });

    if (ticket.assignedAgent) {
      try {
        const agent = await User.findById(ticket.assignedAgent).select("name email");
        if (agent) {
          await sendEmail({
            to: agent.email,
            subject: `SLA breached — #TCK-${ticket.ticketNumber}`,
            text: `Hi ${agent.name},\n\nThe SLA for ticket "${ticket.subject}" has been breached.\n\nReference: TCK-${ticket.ticketNumber}\n\n— AzmSquad Support`,
            html: renderEmailHtml({
              heading: "SLA breached",
              bodyHtml: `Hi ${agent.name},<br><br>The SLA for ticket "<strong>${ticket.subject}</strong>" has been breached.<br><br>Reference: <strong>TCK-${ticket.ticketNumber}</strong>.`,
              ctaText: "Open ticket",
              ctaUrl: `${CLIENT_ORIGIN}/tickets/${ticket._id.toString()}`,
            }),
          });
        }
      } catch (err) {
        console.error(`[sla-monitor] breach email failed for ticket ${ticket._id}:`, (err as Error).message);
      }
    }

    const pair = await pickEscalationPair(ticket.assignedAgent);
    if (pair) {
      try {
        await escalateTicket({ ticket, escalatedToUserId: pair.target, changedBy: pair.actor, reason: "sla_breach" });
      } catch (err) {
        console.error(`[sla-monitor] failed to escalate ticket ${ticket._id}:`, (err as Error).message);
      }
    } else {
      console.error(`[sla-monitor] no admin/subadmin pair available to escalate ticket ${ticket._id} to`);
    }

    return "breached";
  }

  if (ticket.sla.atRiskAlerted) return "none";
  const windowMs = activeTarget.getTime() - ticket.createdAt.getTime();
  const elapsedPercent = windowMs > 0 ? ((now.getTime() - ticket.createdAt.getTime()) / windowMs) * 100 : 100;
  if (elapsedPercent < atRiskPercent) return "none";

  ticket.sla.atRiskAlerted = true;
  ticket.slaHistory.push({ event: "at_risk", at: now });
  await ticket.save();

  if (ticket.assignedAgent) {
    await createTicketNotification({ recipient: ticket.assignedAgent, type: "sla_at_risk", ticketId: ticket._id });
  } else {
    await notifyTicketOversight({ type: "sla_at_risk", ticketId: ticket._id });
  }

  return "at_risk";
}

async function scanConversation(conversation: IConversation, atRiskPercent: number, now: Date): Promise<ScanOutcome> {
  const activeTarget = conversation.sla.responseTargetAt;
  if (!activeTarget) return "none";

  if (now.getTime() >= activeTarget.getTime()) {
    conversation.sla.breached = true;
    await conversation.save();

    if (conversation.assignedAgent) {
      await createConversationNotification({
        recipient: conversation.assignedAgent,
        type: "sla_breached",
        conversationId: conversation._id,
      });
    }
    await notifyChatOversight({ type: "sla_breached", conversationId: conversation._id });

    try {
      await escalateConversation({ conversation, reason: "sla_breach" });
    } catch (err) {
      console.error(`[sla-monitor] failed to escalate conversation ${conversation._id}:`, (err as Error).message);
    }

    return "breached";
  }

  if (conversation.sla.atRiskAlerted) return "none";
  const windowMs = activeTarget.getTime() - conversation.createdAt.getTime();
  const elapsedPercent = windowMs > 0 ? ((now.getTime() - conversation.createdAt.getTime()) / windowMs) * 100 : 100;
  if (elapsedPercent < atRiskPercent) return "none";

  conversation.sla.atRiskAlerted = true;
  await conversation.save();

  if (conversation.assignedAgent) {
    await createConversationNotification({
      recipient: conversation.assignedAgent,
      type: "sla_at_risk",
      conversationId: conversation._id,
    });
  } else {
    await notifyChatOversight({ type: "sla_at_risk", conversationId: conversation._id });
  }

  return "at_risk";
}

export async function scanSlaOnce(now: Date = new Date()): Promise<{
  ticketsAtRisk: number;
  ticketsBreached: number;
  conversationsAtRisk: number;
  conversationsBreached: number;
}> {
  // Read fresh every call — never cached across ticks — so an admin's
  // change from /admin/sla-targets's settings card takes effect starting
  // the very next scan, no restart required (Story 25's getSlaSystemSettings).
  const { atRiskPercent } = await getSlaSystemSettings();

  let ticketsAtRisk = 0;
  let ticketsBreached = 0;
  let conversationsAtRisk = 0;
  let conversationsBreached = 0;

  const tickets = await Ticket.find({
    status: { $in: ["new", "in_progress", "answered"] },
    "sla.breached": false,
  });
  for (const ticket of tickets) {
    try {
      const outcome = await scanTicket(ticket, atRiskPercent, now);
      if (outcome === "breached") ticketsBreached++;
      else if (outcome === "at_risk") ticketsAtRisk++;
    } catch (err) {
      // One bad ticket must never block the rest of the queue.
      console.error(`[sla-monitor] failed to process ticket ${ticket._id}:`, err);
    }
  }

  const conversations = await Conversation.find({
    status: { $in: ["ai_handling", "with_agent"] },
    "sla.breached": false,
  });
  for (const conversation of conversations) {
    try {
      const outcome = await scanConversation(conversation, atRiskPercent, now);
      if (outcome === "breached") conversationsBreached++;
      else if (outcome === "at_risk") conversationsAtRisk++;
    } catch (err) {
      console.error(`[sla-monitor] failed to process conversation ${conversation._id}:`, err);
    }
  }

  return { ticketsAtRisk, ticketsBreached, conversationsAtRisk, conversationsBreached };
}

// live-chat: a conversation nobody ever explicitly closes — the customer
// walks away mid-chat without clicking "End chat", no agent resolves it
// either — would otherwise stay "active" forever. That both clutters the
// staff queue and blocks the customer's own history view (chats/[id]/page.tsx
// only renders a "resolved" conversation; anything else redirects back into
// the live widget), so a still-open conversation with no activity for a
// while is treated as abandoned and auto-resolved. 30 minutes matches the
// low end of what live-chat products use for widget-style (synchronous) chat
// idle timeouts — Zendesk's own chat idle threshold is 10 minutes; Intercom's
// async "Workflows" auto-close default is measured in days, but that's the
// email-continuable messaging case this app doesn't have. Piggybacks on the
// same self-rescheduling tick as the SLA scan below rather than its own timer.
const CONVERSATION_ABANDON_MINUTES = 30;

export async function closeAbandonedConversationsOnce(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONVERSATION_ABANDON_MINUTES * 60_000);
  const stale = await Conversation.find({
    status: { $in: ["ai_handling", "escalated", "with_agent"] },
    updatedAt: { $lt: cutoff },
  });

  const io = getIoInstance();
  let closed = 0;
  for (const conversation of stale) {
    try {
      // assignedAgent intentionally left untouched — history keeps it, same
      // convention as the manual close handler (chat.socket.ts's conversation:close).
      conversation.status = "resolved";
      await conversation.save();

      await recordAuditLog({
        actor: String(conversation.customer),
        action: "chat_closed",
        targetType: "Conversation",
        targetId: String(conversation._id),
        metadata: { reason: "abandoned" },
      });

      io?.to(`conversation:${conversation._id}`).emit("conversation:closed", {
        conversationId: String(conversation._id),
        status: "resolved",
      });

      closed++;
    } catch (err) {
      console.error(`[sla-monitor] failed to auto-close abandoned conversation ${conversation._id}:`, err);
    }
  }
  return closed;
}

// Self-rescheduling setTimeout loop, not a fixed setInterval — this is what
// lets an admin's scanIntervalMinutes change take effect starting the next
// cycle without a server restart (each tick reads getSlaSystemSettings()
// fresh before scheduling the next one). Guarded off entirely in the test
// environment so vitest never inherits a live timer chain — tests call
// scanSlaOnce() directly instead.
export function startSlaMonitor(): { stop: () => void } {
  if (process.env.NODE_ENV === "test") {
    return { stop: () => {} };
  }

  let stopped = false;
  let handle: NodeJS.Timeout | null = null;

  async function tick() {
    if (stopped) return;
    const counts = await scanSlaOnce();
    const abandonedClosed = await closeAbandonedConversationsOnce();
    console.log(`[sla-monitor] tick counts=${JSON.stringify(counts)} abandonedClosed=${abandonedClosed}`);
    if (stopped) return;
    const { scanIntervalMinutes } = await getSlaSystemSettings();
    handle = setTimeout(tick, scanIntervalMinutes * 60_000);
  }

  handle = setTimeout(tick, 0); // first tick fires immediately, subsequent ones self-schedule
  return {
    stop() {
      stopped = true;
      if (handle) clearTimeout(handle);
    },
  };
}
