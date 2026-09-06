import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { format, isToday, isYesterday } from "date-fns";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { StaffSidebar } from "@/components/StaffSidebar";
import { ListPagination } from "@/components/ListPagination";
import { cn } from "@/lib/utils";
import { AuditLogFilterBar } from "./AuditLogFilterBar";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("AuditLogList");
  return { title: t("heading"), robots: { index: false, follow: false } };
}

type AuditAction =
  | "login_success"
  | "login_failed"
  | "logout"
  | "customer_registered"
  | "permissions_changed"
  | "staff_created"
  | "staff_updated"
  | "staff_activated"
  | "staff_deactivated"
  | "staff_deleted"
  | "agent_availability_changed"
  | "customer_created"
  | "customer_updated"
  | "customer_contact_updated"
  | "customer_email_change_requested"
  | "customer_email_change_confirmed"
  | "customer_note_added"
  | "customer_note_updated"
  | "customer_attachment_added"
  | "customer_attachment_deleted"
  | "customer_id_document_updated"
  | "ticket_created"
  | "ticket_reassigned"
  | "ticket_category_changed"
  | "ticket_priority_changed"
  | "ticket_status_changed"
  | "ticket_escalated"
  | "ticket_replied"
  | "ticket_internal_note_added"
  | "ticket_summarized"
  | "ticket_category_created"
  | "ticket_category_updated"
  | "ticket_referenced_in_chat"
  | "chat_started"
  | "chat_escalated"
  | "chat_claimed"
  | "chat_unclaimed"
  | "chat_closed"
  | "chat_summarized"
  | "kb_faq_created"
  | "kb_faq_updated"
  | "kb_faq_deleted"
  | "kb_article_created"
  | "kb_article_updated"
  | "kb_article_deleted"
  | "sla_target_created"
  | "sla_target_updated"
  | "sla_target_deleted"
  | "sla_settings_updated"
  | "feedback_submitted";
type AuditCategory = "auth" | "permissions" | "staff" | "customers" | "tickets" | "live-chat" | "knowledge-base" | "sla" | "feedback";
type AuditTargetType =
  | "User"
  | "Ticket"
  | "Conversation"
  | "TicketCategory"
  | "SlaTarget"
  | "SlaSystemSettings"
  | "Faq"
  | "HelpArticle"
  | "Feedback";

interface AuditActor {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AuditTicketTarget {
  id: string;
  reference: string;
  subject: string;
}

// Every non-User, non-Ticket target type (Conversation, TicketCategory,
// SlaTarget, SlaSystemSettings, Faq, HelpArticle, Feedback) resolves to this
// same {id, name} shape server-side (audit.routes.ts's resolveTarget).
interface AuditGenericTarget {
  id: string;
  name: string;
}

interface AuditLogEntry {
  id: string;
  actor: AuditActor | null;
  action: AuditAction;
  category: AuditCategory;
  targetType: AuditTargetType;
  targetId: string | null;
  target: AuditActor | AuditTicketTarget | AuditGenericTarget | null;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  createdAt: string;
}

// security-admin Story 47: admin/subadmin-facing read-only audit timeline,
// gated on audit:view. Grouped-by-day rendering (chosen UI Option B) — the
// backend already returns entries newest-first, this groups the current
// page's rows by local calendar date under Today/Yesterday/explicit-date
// headers. A day can split across a page boundary; accepted the same way
// no other list view in the app respects logical groupings across pages.
const CATEGORY_ACCENT: Record<AuditCategory, string> = {
  auth: "bg-icon-status",
  permissions: "bg-icon-priority",
  staff: "bg-icon-category",
  tickets: "bg-icon-source",
  customers: "bg-icon-date",
  "live-chat": "bg-icon-chat",
  "knowledge-base": "bg-icon-kb",
  sla: "bg-icon-sla",
  feedback: "bg-icon-rating",
};

interface AuditLogListSearchParams {
  page?: string;
  q?: string;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  _refreshed?: string;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<AuditLogListSearchParams>;
}) {
  const { page: pageParam, q, category, dateFrom, dateTo, _refreshed } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const t = await getTranslations("AuditLogList");

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  const currentQuery = new URLSearchParams();
  if (q) currentQuery.set("q", q);
  if (category) currentQuery.set("category", category);
  if (dateFrom) currentQuery.set("dateFrom", dateFrom);
  if (dateTo) currentQuery.set("dateTo", dateTo);
  const nextUrl = `/admin/audit-logs${currentQuery.toString() ? `?${currentQuery.toString()}` : ""}`;

  if (!token) {
    if (hasRefreshToken && !_refreshed) {
      redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    }
    redirect("/");
  }

  const listQuery = new URLSearchParams(currentQuery);
  listQuery.set("page", String(page));
  // Denser than a 10-row table — a compact timeline reads well with more
  // entries per page.
  listQuery.set("limit", "20");

  const res = await fetch(`${API_URL}/api/v1/admin/audit-logs?${listQuery.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (res.status === 401) {
    if (!_refreshed) {
      redirect(`/api/session/refresh?next=${encodeURIComponent(nextUrl)}`);
    }
    redirect("/login");
  }

  if (res.status === 403) {
    // A staff persona without audit:view never gets a working nav link to
    // this page (see lib/staffNav.ts), so reaching it and being turned away
    // belongs on the dashboard, not a dead-end message here — same
    // reasoning as admin/users/page.tsx.
    redirect("/dashboard");
  }

  if (!res.ok) {
    redirect("/");
  }

  const data: { entries: AuditLogEntry[]; total: number; page: number; limit: number } = await res.json();

  function hrefForPage(nextPage: number) {
    const params = new URLSearchParams(currentQuery);
    params.set("page", String(nextPage));
    return `/admin/audit-logs?${params.toString()}`;
  }

  function actorLabel(entry: AuditLogEntry): string {
    if (entry.actor) return entry.actor.name;
    const email = typeof entry.metadata.attemptedEmail === "string" ? entry.metadata.attemptedEmail : "—";
    return t("unknownActor", { email });
  }

  function isTicketTarget(
    target: AuditActor | AuditTicketTarget | AuditGenericTarget | null
  ): target is AuditTicketTarget {
    return Boolean(target) && "reference" in (target as object);
  }

  function targetLabel(entry: AuditLogEntry): string {
    if (isTicketTarget(entry.target)) return entry.target.reference;
    if (!entry.target) return "—";
    if ("email" in entry.target) return entry.target.name ?? entry.target.email ?? "—";
    return entry.target.name;
  }

  function actionLine(entry: AuditLogEntry): string {
    const actor = actorLabel(entry);
    const target = targetLabel(entry);
    switch (entry.action) {
      case "login_success":
        return t("actionLoginSuccess", { actor });
      case "login_failed": {
        const reason = entry.metadata.reason;
        if (reason === "unknown_email") {
          const email = typeof entry.metadata.attemptedEmail === "string" ? entry.metadata.attemptedEmail : "—";
          return t("actionLoginFailedUnknownEmail", { email });
        }
        if (reason === "account_deactivated") return t("actionLoginFailedAccountDeactivated", { actor });
        return t("actionLoginFailedWrongPassword", { actor });
      }
      case "logout":
        return t("actionLogout", { actor });
      case "permissions_changed":
        return t("actionPermissionsChanged", { actor, target });
      case "staff_activated":
        return t("actionStaffActivated", { actor, target });
      case "staff_deactivated":
        return t("actionStaffDeactivated", { actor, target });
      case "agent_availability_changed":
        return entry.metadata.isOnline
          ? t("actionAvailabilityOnline", { actor })
          : t("actionAvailabilityOffline", { actor });
      case "customer_registered":
        return t("actionCustomerRegistered", { actor });
      case "staff_created":
        return t("actionStaffCreated", { actor, target });
      case "staff_updated":
        return t("actionStaffUpdated", { actor, target });
      case "staff_deleted":
        return t("actionStaffDeleted", { actor, target });
      case "customer_created":
        return t("actionCustomerCreated", { actor, target });
      case "customer_updated":
        return t("actionCustomerUpdated", { actor, target });
      case "customer_contact_updated":
        return t("actionCustomerContactUpdated", { actor });
      case "customer_email_change_requested":
        return t("actionCustomerEmailChangeRequested", { actor });
      case "customer_email_change_confirmed":
        return t("actionCustomerEmailChangeConfirmed", { actor });
      case "customer_note_added":
        return t("actionCustomerNoteAdded", { actor, target });
      case "customer_note_updated":
        return t("actionCustomerNoteUpdated", { actor, target });
      case "customer_attachment_added":
        return t("actionCustomerAttachmentAdded", { actor, target });
      case "customer_attachment_deleted":
        return t("actionCustomerAttachmentDeleted", { actor, target });
      case "customer_id_document_updated":
        return t("actionCustomerIdDocumentUpdated", { actor, target });
      case "ticket_created":
        return entry.metadata.isStaffCreated
          ? t("actionTicketCreated", { actor, target })
          : t("actionTicketCreatedSelf", { actor, target });
      case "ticket_reassigned":
        return t("actionTicketReassigned", { actor, target });
      case "ticket_category_changed":
        return t("actionTicketCategoryChanged", { actor, target });
      case "ticket_priority_changed":
        return t("actionTicketPriorityChanged", { actor, target });
      case "ticket_status_changed":
        return t("actionTicketStatusChanged", { actor, target });
      case "ticket_escalated":
        return t("actionTicketEscalated", { actor, target });
      case "ticket_replied":
        return t("actionTicketReplied", { actor, target });
      case "ticket_internal_note_added":
        return t("actionTicketInternalNoteAdded", { actor, target });
      case "ticket_summarized":
        return t("actionTicketSummarized", { actor, target });
      case "ticket_category_created":
        return t("actionTicketCategoryCreated", { actor, target });
      case "ticket_category_updated":
        return t("actionTicketCategoryUpdated", { actor, target });
      case "ticket_referenced_in_chat":
        return t("actionTicketReferencedInChat", { actor, target });
      case "chat_started":
        return t("actionChatStarted", { actor });
      case "chat_escalated":
        return t("actionChatEscalated", { actor });
      case "chat_claimed":
        return t("actionChatClaimed", { actor });
      case "chat_unclaimed":
        return t("actionChatUnclaimed", { actor });
      case "chat_closed":
        return t("actionChatClosed", { actor });
      case "chat_summarized":
        return t("actionChatSummarized", { actor });
      case "kb_faq_created":
        return t("actionKbFaqCreated", { actor, target });
      case "kb_faq_updated":
        return t("actionKbFaqUpdated", { actor, target });
      case "kb_faq_deleted":
        return t("actionKbFaqDeleted", { actor, target });
      case "kb_article_created":
        return t("actionKbArticleCreated", { actor, target });
      case "kb_article_updated":
        return t("actionKbArticleUpdated", { actor, target });
      case "kb_article_deleted":
        return t("actionKbArticleDeleted", { actor, target });
      case "sla_target_created":
        return t("actionSlaTargetCreated", { actor });
      case "sla_target_updated":
        return t("actionSlaTargetUpdated", { actor });
      case "sla_target_deleted":
        return t("actionSlaTargetDeleted", { actor });
      case "sla_settings_updated":
        return t("actionSlaSettingsUpdated", { actor });
      case "feedback_submitted":
        return t("actionFeedbackSubmitted", { actor });
      default:
        return entry.action;
    }
  }

  // "Referring to a person or ticket" — the entry's own target when it has
  // one (the ticket that was created, the account that was
  // activated/deactivated/created, ...), falling back to the actor for
  // actions with no distinct target (login/logout/availability). Null (no
  // link, plain card) only for a failed login against an email with no
  // matching account — there's nothing to navigate to.
  function entryHref(entry: AuditLogEntry): string | null {
    if (entry.targetId) {
      switch (entry.targetType) {
        case "Ticket":
          return `/tickets/${entry.targetId}`;
        case "Conversation":
          return `/chats/${entry.targetId}`;
        case "User": {
          const userTarget = entry.target as AuditActor | null;
          return userTarget?.role === "customer" ? `/customers/${entry.targetId}` : `/admin/users/${entry.targetId}`;
        }
        // TicketCategory, SlaTarget, SlaSystemSettings, Faq, HelpArticle and
        // Feedback have no dedicated detail page to link to — the entry
        // still renders, just as a plain (non-clickable) card.
        default:
          break;
      }
    }
    if (entry.actor) return entry.actor.role === "customer" ? `/customers/${entry.actor.id}` : `/admin/users/${entry.actor.id}`;
    return null;
  }

  function dayHeaderLabel(date: Date): string {
    if (isToday(date)) return t("today");
    if (isYesterday(date)) return t("yesterday");
    return format(date, "MMMM d, yyyy");
  }

  // Group the current page's entries (already newest-first) by local
  // calendar date, preserving order within each group.
  const groups: { key: string; date: Date; entries: AuditLogEntry[] }[] = [];
  for (const entry of data.entries) {
    const date = new Date(entry.createdAt);
    const key = format(date, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      groups.push({ key, date, entries: [entry] });
    }
  }

  const hasActiveFilter = Boolean(q || category || dateFrom || dateTo);

  return (
    <div className="flex min-h-[calc(100vh-57px)]">
      <StaffSidebar active="auditLog" />
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight md:text-2xl">{t("heading")}</h1>
        </div>

        <AuditLogFilterBar />

        {data.entries.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">{hasActiveFilter ? t("noResults") : t("empty")}</p>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <div key={group.key} className="flex gap-4">
                {/* Left rail: date header, per the chosen "grouped-by-day
                    timeline" UI direction. */}
                <div className="w-20 shrink-0 pt-1 text-end sm:w-28">
                  <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {dayHeaderLabel(group.date)}
                  </span>
                </div>
                <div className="min-w-0 flex-1 border-s border-border ps-4">
                  <div className="flex flex-col gap-3">
                    {group.entries.map((entry) => {
                      const href = entryHref(entry);
                      const cardClass = cn(
                        "flex items-start gap-3 rounded-xl border border-border bg-card/50 p-3",
                        href && "transition-colors hover:border-primary/40 hover:bg-card"
                      );
                      const card = (
                        <>
                          <span
                            className={cn("mt-1.5 size-2 shrink-0 rounded-full", CATEGORY_ACCENT[entry.category])}
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm">{actionLine(entry)}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span>{format(new Date(entry.createdAt), "p")}</span>
                              {entry.actor?.email && <span>{entry.actor.email}</span>}
                            </div>
                          </div>
                        </>
                      );
                      return href ? (
                        <Link key={entry.id} href={href} className={cardClass}>
                          {card}
                        </Link>
                      ) : (
                        <div key={entry.id} className={cardClass}>
                          {card}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4">
          <ListPagination total={data.total} page={data.page} limit={data.limit} hrefForPage={hrefForPage} />
        </div>
      </main>
    </div>
  );
}
