"use server";

import { cookies } from "next/headers";
import { API_URL, SESSION_COOKIE } from "@/lib/auth";
import { refreshSession } from "@/lib/session";

// Story 54: colocated at the top level, not under a route-scoped folder,
// same reasoning as actions/availability.ts — the notification bell lives
// in the header (SiteHeader), not on a single page.

export type NotificationType =
  | "ticket_assigned"
  | "ticket_escalated"
  | "ticket_reassigned"
  | "ticket_unassigned"
  | "ticket_created"
  | "ticket_auto_assigned"
  | "ticket_needs_assignment"
  | "ticket_reopened"
  | "ticket_reopened_oversight"
  | "chat_needs_agent"
  | "sla_at_risk"
  | "sla_breached"
  // agent-workspace Story 24: a colleague tagged you in an internal note.
  | "ticket_internal_note_mention";

// live-chat: a notification carries exactly one of ticket/conversation,
// never both (see backend/src/routes/me.routes.ts's toNotificationItem) —
// both are nullable here rather than a discriminated union so callers don't
// need a type-narrowing helper for what's already a simple "pick whichever
// is non-null" check.
export interface NotificationItem {
  id: string;
  type: NotificationType;
  read: boolean;
  createdAt: string;
  ticket: { id: string; reference: string; subject: string } | null;
  conversation: { id: string } | null;
}

async function getBearerToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) return token;
  return refreshSession();
}

// No refreshSession() fallback here, unlike getBearerToken() above (used by
// fetchNotificationHistory/markNotificationRead, both the direct result of a
// user visibly doing something — opening /notifications, clicking a bell
// item). fetchNotifications() backs the bell's own 60s background poll: a
// refresh token rotates on every use, so a poll racing another invisible
// poll (agent-workspace Story 35's dashboard board) to refresh right around
// the same expiry moment risks tripping the reuse-detection lockout meant
// for a stolen-token attacker — over a dropdown nobody's even looking at. A
// stale bell count until the next real, visible, user-driven request
// refreshes the session properly is a far cheaper failure than that.
async function getBearerTokenNoRefresh(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? null;
}

// Returns [] on any failure (signed out, network hiccup, backend down) —
// the bell has no error state of its own; an empty/unchanged list is the
// correct degraded behavior for a polling background fetch like this one.
// The try/catch is load-bearing, not defensive boilerplate: fetch() itself
// rejects (rather than resolving with a bad status) when the backend is
// unreachable, which previously escaped as an unhandled "fetch failed"
// TypeError that crashed the page render instead of degrading.
export async function fetchNotifications(): Promise<NotificationItem[]> {
  const token = await getBearerTokenNoRefresh();
  if (!token) return [];

  try {
    const res = await fetch(`${API_URL}/api/v1/me/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as NotificationItem[];
  } catch {
    return [];
  }
}

export interface NotificationHistoryResult {
  notifications: NotificationItem[];
  total: number;
  page: number;
  limit: number;
}

const HISTORY_LIMIT = 10;

// Backs the dedicated "view all notifications" page — unlike
// fetchNotifications() above (bell dropdown: unread-first, capped at 50,
// plain array), this always requests the backend's paginated/date-filtered
// history mode (GET /me/notifications switches into it whenever ANY of
// page/limit/from/to is present) by always sending `page`. Returns an
// empty page (not throwing) on any failure — same "degrade gracefully"
// convention as every other action in this file.
export async function fetchNotificationHistory(params: {
  page: number;
  from?: string;
  to?: string;
}): Promise<NotificationHistoryResult> {
  const empty: NotificationHistoryResult = { notifications: [], total: 0, page: params.page, limit: HISTORY_LIMIT };
  const token = await getBearerToken();
  if (!token) return empty;

  const query = new URLSearchParams({ page: String(params.page), limit: String(HISTORY_LIMIT) });
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/me/notifications?${query.toString()}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      cache: "no-store",
    });

  try {
    let res = await doFetch(token);
    if (res.status === 401) {
      const refreshedToken = await refreshSession();
      if (!refreshedToken) return empty;
      res = await doFetch(refreshedToken);
    }
    if (!res.ok) return empty;
    return (await res.json()) as NotificationHistoryResult;
  } catch {
    return empty;
  }
}

export async function markNotificationRead(id: string): Promise<boolean> {
  const token = await getBearerToken();
  if (!token) return false;

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/me/notifications/${id}/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bearer}` },
    });

  try {
    let res = await doFetch(token);
    if (res.status === 401) {
      const refreshedToken = await refreshSession();
      if (!refreshedToken) return false;
      res = await doFetch(refreshedToken);
    }
    return res.ok;
  } catch {
    return false;
  }
}
