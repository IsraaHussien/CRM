"use server";

import { cookies } from "next/headers";
import { API_URL, SESSION_COOKIE } from "@/lib/auth";

// agent-workspace Story 35: colocated at the top level, same reasoning as
// actions/notifications.ts — this action backs both the dashboard page's
// server-rendered first paint and TriageBoard's client-side polling, so it
// isn't owned by either one of them.

// Mirrors backend/src/routes/me.routes.ts's WorkspaceItem field-for-field.
export interface WorkspaceItem {
  id: string;
  type: "ticket" | "chat";
  // "TCK-1234" for tickets, null for chats — a conversation has no reference
  // number, so the card falls back to its customer name.
  reference: string | null;
  title: string | null;
  priority: "low" | "medium" | "high" | "urgent" | null;
  status: string;
  customer: { id: string; name: string } | null;
  assignedAgent: { id: string; name: string } | null;
  slaStatus: "on_track" | "at_risk" | "breached";
  // The earliest defined SLA target on the item — what the column sorts on
  // and the card counts down to. Null for items predating sla-automation.
  urgencyAt: string | null;
  responseTargetAt: string | null;
  resolutionTargetAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceColumn {
  items: WorkspaceItem[];
  total: number;
}

export interface WorkspaceColumns {
  breached: WorkspaceColumn;
  at_risk: WorkspaceColumn;
  on_track: WorkspaceColumn;
}

export interface WorkspaceResponse {
  columns: WorkspaceColumns;
  generatedAt: string;
}

// Deliberately no refreshSession() fallback/retry here, unlike a
// user-triggered action (postInternalNote, sendTicketReply, ...): this
// action backs two call sites, and both are invisible to the user in the
// moment they run. The page's initial server-rendered fetch
// (dashboard/page.tsx) already runs after that page's own GET /me/status
// call has validated (and, if needed, refreshed) the session — by the time
// this runs, the token is already fresh. TriageBoard's 60s client-side poll
// (Frontend Task 2b) is the other caller, and refreshing FROM a background
// poll is actively worse than just failing quietly: the refresh token
// rotates on every use (see CLAUDE.md's "Frontend auth" section), so two
// invisible pollers racing to refresh around the same expiry moment (this
// one, NotificationBell's) risks tripping the reuse-detection lockout meant
// for a stolen-token attacker, over something no one is even looking at. A
// stale board for up to one poll interval — or until the next real,
// visible, user-driven navigation triggers the real refresh flow — is a far
// cheaper failure than that.
async function getBearerToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? null;
}

// Returns null (not an empty board) on any failure so callers can tell "no
// data yet" apart from "genuinely nothing assigned" ({ breached: { items:
// [], total: 0 }, ... }). Same never-throw contract as fetchNotifications():
// fetch() itself rejects when the backend is unreachable, and a background
// poll must degrade rather than crash the page it lives on.
export async function fetchWorkspace(): Promise<WorkspaceResponse | null> {
  const token = await getBearerToken();
  if (!token) return null;

  try {
    const res = await fetch(`${API_URL}/api/v1/me/workspace`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as WorkspaceResponse;
  } catch {
    return null;
  }
}
