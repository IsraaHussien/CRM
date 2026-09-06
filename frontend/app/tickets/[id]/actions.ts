"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE } from "@/lib/auth";
import { refreshSession } from "@/lib/session";

export interface TicketDetailActionState {
  error: string | null;
}

async function getBearerToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) return token;
  return refreshSession();
}

async function patchTicket(
  ticketId: string,
  body: { category: string | null } | { priority: string } | { assignedAgent: string | null }
): Promise<TicketDetailActionState> {
  const t = await getTranslations("TicketDetail");
  const token = await getBearerToken();
  if (!token) {
    return { error: t("changeFailed") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: t("changeFailed") };
    }
    res = await doFetch(refreshedToken);
  }

  if (!res.ok) {
    if (res.status === 403) return { error: t("noAccess") };
    return { error: t("changeFailed") };
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { error: null };
}

export async function updateTicketCategory(
  ticketId: string,
  category: string | null
): Promise<TicketDetailActionState> {
  return patchTicket(ticketId, { category });
}

export async function updateTicketPriority(ticketId: string, priority: string): Promise<TicketDetailActionState> {
  return patchTicket(ticketId, { priority });
}

export async function reassignTicket(
  ticketId: string,
  assignedAgent: string | null
): Promise<TicketDetailActionState> {
  return patchTicket(ticketId, { assignedAgent });
}

// ticket-management Story 11: separate endpoint (PATCH /:id/status, not
// PATCH /:id) since status transitions are permission-gated differently
// (tickets:change_status vs tickets:close_reopen, decided per-request on
// the backend) from category/priority/assignedAgent above — same
// request/error-handling shape as patchTicket, just a different URL.
export async function updateTicketStatus(
  ticketId: string,
  status: "new" | "in_progress" | "answered" | "closed"
): Promise<TicketDetailActionState> {
  const t = await getTranslations("TicketDetail");
  const token = await getBearerToken();
  if (!token) {
    return { error: t("changeFailed") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ status }),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: t("changeFailed") };
    }
    res = await doFetch(refreshedToken);
  }

  if (!res.ok) {
    if (res.status === 403) return { error: t("noAccess") };
    return { error: t("changeFailed") };
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { error: null };
}

export interface AssignableAgent {
  id: string;
  name: string;
  isOnline: boolean;
}

// Story 25: backs both the ticket-detail sidebar's "Assigned agent" select
// and the queue table's reassign dropdown — one shared action, mirroring
// listActiveTicketCategories in ../new/actions.ts. Returns [] on any
// failure (signed out, forbidden, network hiccup) — same "degrade to
// empty" reasoning that function already uses.
export async function listAssignableAgents(): Promise<AssignableAgent[]> {
  const token = await getBearerToken();
  if (!token) return [];

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/assignable-agents`, {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) return [];
    res = await doFetch(refreshedToken);
  }
  if (!res.ok) return [];
  return (await res.json()) as AssignableAgent[];
}

export interface EscalationTarget {
  id: string;
  name: string;
  role: "agent" | "admin" | "subadmin";
}

// ticket-management Story 12: backs the escalate dialog's target picker.
// Returns [] on any failure — same "degrade to empty" reasoning as
// listAssignableAgents above.
export async function listEscalationTargets(): Promise<EscalationTarget[]> {
  const token = await getBearerToken();
  if (!token) return [];

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/escalation-targets`, {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) return [];
    res = await doFetch(refreshedToken);
  }
  if (!res.ok) return [];
  return (await res.json()) as EscalationTarget[];
}

export interface EscalateTicketState {
  error: string | null;
}

// ticket-management Story 12: POST, not PATCH /:id/status — escalation also
// writes escalatedTo and fires notifications, which the generic status
// endpoint knows nothing about (see backend/src/services/ticketEscalation.service.ts).
export async function escalateTicket(ticketId: string, escalatedTo: string): Promise<EscalateTicketState> {
  const t = await getTranslations("TicketDetail");
  const token = await getBearerToken();
  if (!token) {
    return { error: t("changeFailed") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/${ticketId}/escalate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ escalatedTo }),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: t("changeFailed") };
    }
    res = await doFetch(refreshedToken);
  }

  if (!res.ok) {
    if (res.status === 403) return { error: t("noAccess") };
    if (res.status === 409) return { error: t("alreadyEscalated") };
    const data = await res.json().catch(() => null);
    if (typeof data?.error === "string") return { error: data.error };
    return { error: t("changeFailed") };
  }

  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/tickets");
  return { error: null };
}

export interface InternalNoteTagTarget {
  id: string;
  name: string;
  role: "agent" | "admin" | "subadmin";
}

// agent-workspace Story 24: backs the internal-note composer's "Tag
// colleagues" picker. Its own endpoint (not /escalation-targets) because the
// two permissions are independently grantable — see the backend route's
// comment. Returns [] on any failure, same "degrade to empty" reasoning as
// listAssignableAgents/listEscalationTargets above.
export async function listInternalNoteTagTargets(): Promise<InternalNoteTagTarget[]> {
  const token = await getBearerToken();
  if (!token) return [];

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/internal-note-taggables`, {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) return [];
    res = await doFetch(refreshedToken);
  }
  if (!res.ok) return [];
  return (await res.json()) as InternalNoteTagTarget[];
}

export interface PostInternalNoteState {
  error: string | null;
  // agent-workspace Story 24: the backend's per-id rejection map
  // ({ "<userId>": "reason" }) surfaced verbatim so the composer can mark the
  // exact chip that's invalid instead of showing one opaque error.
  taggedUserIdErrors?: Record<string, string>;
}

// agent-workspace Story 24: POST /:id/internal-notes, not /:id/messages —
// an internal note is never emailed to the customer and never flips the
// ticket to "answered", so it's a separate endpoint with its own permission.
export async function postInternalNote(
  ticketId: string,
  input: { text: string; taggedUserIds: string[] }
): Promise<PostInternalNoteState> {
  const t = await getTranslations("TicketDetail");
  const token = await getBearerToken();
  if (!token) {
    return { error: t("changeFailed") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/${ticketId}/internal-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(input),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: t("changeFailed") };
    }
    res = await doFetch(refreshedToken);
  }

  if (!res.ok) {
    if (res.status === 403) return { error: t("noAccess") };
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      taggedUserIdErrors?: Record<string, string>;
    } | null;
    if (data?.taggedUserIdErrors) {
      return { error: data.error ?? t("changeFailed"), taggedUserIdErrors: data.taggedUserIdErrors };
    }
    if (typeof data?.error === "string") return { error: data.error };
    return { error: t("changeFailed") };
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { error: null };
}

export interface TicketHistoryEvent {
  kind:
    | "created"
    | "status_changed"
    | "category_changed"
    | "priority_changed"
    | "assignee_changed"
    | "reply_posted"
    | "internal_note_added"
    | "chat_participant_joined"
    | "chat_participant_left"
    | "chat_inquiry"
    | "sla_at_risk"
    | "sla_breached";
  at: string;
  actor: { id: string; name: string | null; role: string } | null;
  data: Record<string, unknown>;
}

// ticket-management Story 13: backs the sidebar's "Recent activity" teaser
// and its full-timeline drawer. Returns [] on any failure — same
// "degrade to empty" reasoning as listAssignableAgents/listEscalationTargets
// above; the history section simply renders nothing rather than erroring
// the whole page.
//
// Takes the access token as a parameter rather than reading/refreshing it
// itself (unlike every other action in this file): this is called directly
// from tickets/[id]/page.tsx's Promise.all during that Server Component's
// render, not dispatched as a real Server Action invocation — cookies()
// mutations (what refreshSession()/getBearerToken() would attempt on a
// missing/expired token) are only legal inside an actual Server Action
// call or Route Handler, and throw ("Cookies can only be modified in a
// Server Action or Route Handler") when attempted mid-render. The page
// already resolves and validates accessToken itself (and redirects through
// /api/session/refresh on its own 401), so this just reuses that token.
export async function getTicketHistory(ticketId: string, accessToken: string): Promise<TicketHistoryEvent[]> {
  const res = await fetch(`${API_URL}/api/v1/tickets/${ticketId}/history`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { events: TicketHistoryEvent[] };
  return body.events;
}

export interface SendTicketReplyState {
  error: string | null;
}

// Forwards a multipart FormData (text + optional files) straight through,
// never touching Content-Type (fetch sets the multipart boundary itself) —
// same shape as customers/[id]/actions.ts's doMultipartRequest.
export async function sendTicketReply(ticketId: string, formData: FormData): Promise<SendTicketReplyState> {
  const t = await getTranslations("TicketDetail");
  const token = await getBearerToken();
  if (!token) {
    return { error: t("changeFailed") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/tickets/${ticketId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      body: formData,
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: t("changeFailed") };
    }
    res = await doFetch(refreshedToken);
  }

  if (!res.ok) {
    if (res.status === 403) return { error: t("noAccess") };
    const data = await res.json().catch(() => null);
    if (data?.error === "UNSUPPORTED_FILE_TYPE") return { error: t("unsupportedFileType") };
    if (res.status === 413) return { error: t("fileTooLarge") };
    return { error: t("changeFailed") };
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { error: null };
}
