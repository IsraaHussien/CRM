import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { peekJwtPayload } from "@/lib/jwt";
import { StaffSidebar } from "@/components/StaffSidebar";
import { TicketLiveRefresh } from "@/components/TicketLiveRefresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TicketDetailSidebar } from "./TicketDetailSidebar";
import { CustomerTicketProgress } from "./CustomerTicketProgress";
import { TicketMessageThread } from "./TicketMessageThread";
import { TicketReplyComposer } from "./TicketReplyComposer";
import { TicketSummaryPanel } from "./TicketSummaryPanel";
import { ReopenTicketButton } from "./ReopenTicketButton";
import { getTicketHistory } from "./actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("TicketDetail");
  return { title: t("heading"), robots: { index: false, follow: false } };
}

interface TicketDetailResponse {
  id: string;
  reference: string;
  subject: string;
  description: string;
  status: "new" | "in_progress" | "answered" | "escalated" | "closed";
  category: string | null;
  priority: "low" | "medium" | "high" | "urgent";
  customer: { id: string; name: string; email: string };
  assignedAgent: { id: string; name: string } | null;
  escalatedTo: { id: string; name: string } | null;
  // Story 63: both null on a ticket created before this story shipped.
  createdBy: { id: string; name: string } | null;
  createdVia: "customer_portal" | "ai" | "phone" | "email" | "in_person" | "other" | null;
  createdAt: string;
  updatedAt: string;
}

interface TicketMessageAttachment {
  id: string;
  fileName: string;
  size: number;
  url: string;
}

export interface TicketMessage {
  id: string;
  text: string;
  senderType: "customer" | "agent" | "ai" | "system";
  sender: { id: string; name: string } | null;
  // agent-workspace Story 24: optional because a customer-facing response
  // omits the field entirely — the customer surface doesn't acknowledge the
  // concept of an internal message, it doesn't just report `false`.
  internal?: boolean;
  // Only present on an internal note read by a staff viewer.
  taggedUsers?: { id: string; name: string; role: string }[];
  attachments: TicketMessageAttachment[];
  createdAt: string;
}

// Story 63: shown as a badge on the subject line only for a staff-created
// ticket — "customer_portal" and legacy (null) tickets render no badge at
// all (see the render site below). Each channel gets its own emoji + vivid
// color (globals.css's --channel-* tokens) rather than one flat "secondary"
// badge for all of them — see memory: icons/badges carry their own color,
// never inherit the surrounding muted text.
const CREATED_VIA_EMOJI: Record<"ai" | "phone" | "email" | "in_person" | "other", string> = {
  ai: "🤖",
  phone: "📞",
  email: "✉️",
  in_person: "🧑‍💼",
  other: "🧩",
};

const CREATED_VIA_BADGE_CLASS: Record<"ai" | "phone" | "email" | "in_person" | "other", string> = {
  ai: "border-transparent bg-channel-ai/10 text-channel-ai",
  phone: "border-transparent bg-channel-phone/10 text-channel-phone",
  email: "border-transparent bg-channel-email/10 text-channel-email",
  in_person: "border-transparent bg-channel-in-person/10 text-channel-in-person",
  other: "border-transparent bg-channel-other/10 text-channel-other",
};

const CREATED_VIA_KEY: Record<"ai" | "phone" | "email" | "in_person" | "other", string> = {
  ai: "createdViaAi",
  phone: "createdViaPhone",
  email: "createdViaEmail",
  in_person: "createdViaInPerson",
  other: "createdViaOther",
};

// Story 9: the first ticket-detail page — staff-only (agent/admin/subadmin),
// scoped to what this story needs (viewing a ticket's context, editing its
// Category/Priority). Story 56 (reply) and Story 11 (status) extend this
// same page later rather than forking a second one. Gating mirrors
// customers/[id]/page.tsx: cookie → access-token presence → silent-refresh
// redirect → fetch → 401 refresh dance → role/404 handling.
export default async function TicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ _refreshed?: string }>;
}) {
  const { id } = await params;
  const { _refreshed } = await searchParams;
  const t = await getTranslations("TicketDetail");
  const tNav = await getTranslations("Nav");

  const cookieStore = await cookies();
  const accessToken = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  if (!accessToken) {
    if (hasRefreshToken && !_refreshed) {
      redirect(`/api/session/refresh?next=/tickets/${id}`);
    }
    redirect("/");
  }

  const { id: viewerId, role, permissions: viewerPermissions = [] } = peekJwtPayload(accessToken);
  const isStaffViewer = role === "agent" || role === "admin" || role === "subadmin";
  if (!isStaffViewer && role !== "customer") {
    redirect("/dashboard");
  }

  const [res, messagesRes, historyEvents] = await Promise.all([
    fetch(`${API_URL}/api/v1/tickets/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    }),
    fetch(`${API_URL}/api/v1/tickets/${id}/messages`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    }),
    // ticket-management Story 13: getTicketHistory already degrades to []
    // on any failure — never blocks the rest of this page's render. Takes
    // accessToken directly (see actions.ts's comment on why) rather than
    // resolving its own.
    getTicketHistory(id, accessToken),
  ]);

  if (res.status === 401) {
    if (!_refreshed) {
      redirect(`/api/session/refresh?next=/tickets/${id}`);
    }
    redirect("/login");
  }

  if (res.status === 403) {
    redirect("/dashboard");
  }

  if (res.status === 404) {
    return (
      <div className="flex min-h-[calc(100vh-57px)]">
        <StaffSidebar />
        <main className="flex min-w-0 flex-1 items-center justify-center p-8">
          <p className="text-muted-foreground">{t("notFound")}</p>
        </main>
      </div>
    );
  }

  if (!res.ok) {
    redirect("/dashboard");
  }

  const ticket: TicketDetailResponse = await res.json();
  const messages: TicketMessage[] = messagesRes.ok ? await messagesRes.json() : [];
  const isViewerAdmin = role === "admin";
  const canCategorize = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:categorize"));
  const canChangePriority = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:change_priority"));
  const canReply = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:reply"));
  // agent-workspace Story 24: independently grantable from tickets:reply —
  // an internal note is never emailed to the customer and never flips the
  // ticket to "answered", so an account can hold one key without the other.
  const canPostInternalNote =
    isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:post_internal_note"));
  const canReassign = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:reassign"));
  // Story 11: two independent keys, same "check separately" shape as the
  // other per-field booleans above — an account can hold either without
  // the other.
  const canChangeStatus = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:change_status"));
  const canCloseReopen = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:close_reopen"));
  // Story 12: manual escalation to a senior agent or admin.
  const canEscalate = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:escalate"));
  // Story 13: sub-admin-tier — the "Recent activity"/full-timeline section
  // itself has no permission gate (every staff role sees it, same as GET
  // /:id having no tickets:view_all-style restriction), only the export
  // anchor is gated.
  const canExportHistory = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("tickets:export_history"));
  // ai-features Story 32: agent-only, same "no bare role check" shape as
  // every other canX flag above.
  const canSummarize = isStaffViewer && (isViewerAdmin || viewerPermissions.includes("ai:summarize"));
  // Story 11's read-only-when-closed rule: Category/Priority/Assigned Agent
  // lock regardless of the viewer's own permission for that field, and the
  // reply composer is hidden outright. The status control is exempt — it
  // stays interactive for a canCloseReopen holder, so the ticket can be
  // reopened.
  const isLocked = ticket.status === "closed";
  // Story 25's availability rule: admin/sub-admin bypass the online-only
  // restriction; a plain agent holding tickets:reassign does not.
  const viewerIsUnrestrictedReassigner = isViewerAdmin || role === "subadmin";

  return (
    <div className="flex min-h-[calc(100vh-57px)]">
      {isStaffViewer && <StaffSidebar active="tickets" />}
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <TicketLiveRefresh token={accessToken} ticketId={ticket.id} />
        <div className="mx-auto w-full max-w-4xl">
          <nav className="mb-4 text-sm text-muted-foreground">
            <Link href="/tickets" className="hover:text-foreground hover:underline">
              {tNav("tickets")}
            </Link>
            <span className="mx-2">/</span>
            <span className="font-medium text-foreground">{ticket.reference}</span>
          </nav>
          <div className={`gap-6 ${isStaffViewer ? "grid md:grid-cols-[1fr_18rem]" : "flex flex-col"}`}>
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-xl">{ticket.subject}</CardTitle>
                  {/* Story 63: only a staff-created ticket carries a
                      meaningful channel — "customer_portal" and legacy
                      (null) tickets render no badge at all. */}
                  {isStaffViewer && ticket.createdVia && ticket.createdVia !== "customer_portal" && (
                    <Badge
                      variant="outline"
                      className={`shrink-0 gap-1 ${CREATED_VIA_BADGE_CLASS[ticket.createdVia]}`}
                    >
                      <span aria-hidden="true">{CREATED_VIA_EMOJI[ticket.createdVia]}</span>
                      {t(CREATED_VIA_KEY[ticket.createdVia])}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {/* Story 60/36 follow-up: a progress stepper replaces the old
                    bare status Badge for the customer's own view — see
                    CustomerTicketProgress.tsx for why "escalated" is folded
                    into "In Progress" and how the engagement line never
                    names the assigned agent. */}
                {!isStaffViewer && (
                  <CustomerTicketProgress status={ticket.status} hasAssignedAgent={Boolean(ticket.assignedAgent)} />
                )}
                <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
                {isStaffViewer && (
                  <div className="flex flex-col gap-1 border-t border-border pt-4">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("customer")}</span>
                    <span className="text-sm">
                      {ticket.customer.name} — {ticket.customer.email}
                    </span>
                  </div>
                )}
                <div className="flex flex-col gap-3 border-t border-border pt-4">
                  {isStaffViewer ? (
                    <TicketSummaryPanel ticketId={ticket.id} canSummarize={canSummarize} messageCount={messages.length} />
                  ) : (
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("thread")}</span>
                  )}
                  <TicketMessageThread messages={messages} ticketId={ticket.id} staffViewer={isStaffViewer} />
                  {/* Story 61 (deferred): customer email replies aren't captured yet — see USER_STORIES.md. */}
                  {isStaffViewer && <p className="text-xs italic text-muted-foreground">{t("emailReplyComingSoon")}</p>}
                  {/* customer-portal Story 37: reopen affordance — only the
                      ticket's own customer, only when closed. */}
                  {!isStaffViewer && isLocked && <ReopenTicketButton ticketId={ticket.id} />}
                  {/* customer-portal Story 39: coexists with the reopen
                      button above — reopening and rating are independent
                      actions on a closed ticket. */}
                  {!isStaffViewer && isLocked && (
                    <Button asChild variant="link" size="sm" className="self-start px-0">
                      <Link href={`/feedback/ticket/${ticket.id}`}>{t("rateThisTicket")}</Link>
                    </Button>
                  )}
                  {/* Story 11: a closed ticket is read-only — the composer never
                      renders, regardless of canReply, until it's reopened. */}
                  {isLocked && isStaffViewer && (
                    <p className="text-xs italic text-muted-foreground">{t("ticketClosedReadOnly")}</p>
                  )}
                  {/* agent-workspace Story 24: the composer renders whenever
                      the viewer can do EITHER thing — an account holding only
                      tickets:post_internal_note still needs a way in, and one
                      holding only tickets:reply sees exactly what it saw
                      before this story. */}
                  {(canReply || canPostInternalNote) && !isLocked && (
                    <TicketReplyComposer
                      ticketId={ticket.id}
                      canReply={canReply}
                      canPostInternalNote={canPostInternalNote}
                    />
                  )}
                </div>
              </CardContent>
            </Card>

            {isStaffViewer && (
              <Card size="sm" className="h-fit">
                <CardHeader>
                  <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                    {t("heading")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <TicketDetailSidebar
                    ticketId={ticket.id}
                    status={ticket.status}
                    category={ticket.category}
                    priority={ticket.priority}
                    assignedAgent={ticket.assignedAgent}
                    escalatedTo={ticket.escalatedTo}
                    currentUserId={viewerId}
                    canCategorize={canCategorize}
                    canChangePriority={canChangePriority}
                    canReassign={canReassign}
                    canChangeStatus={canChangeStatus}
                    canCloseReopen={canCloseReopen}
                    canEscalate={canEscalate}
                    isLocked={isLocked}
                    viewerIsUnrestrictedReassigner={viewerIsUnrestrictedReassigner}
                    events={historyEvents}
                    canExportHistory={canExportHistory}
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
