import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowUpCircle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { ListPagination } from "@/components/ListPagination";
import { formatDateTime } from "@/lib/utils";
import {
  SOURCE_LABEL_KEY,
  SOURCE_EMOJI,
  SOURCE_BADGE_CLASS,
  type TicketCreationChannel,
} from "@/lib/ticketSource";
import { TicketFilterBar } from "./TicketFilterBar";
import { StatusQuickFilterChips } from "./StatusQuickFilterChips";
import { ReassignAgentMenu } from "./ReassignAgentMenu";

export type { TicketCreationChannel };

export interface StaffTicketRow {
  id: string;
  reference: string;
  subject: string;
  status: "new" | "in_progress" | "answered" | "escalated" | "closed";
  category: string | null;
  priority: "low" | "medium" | "high" | "urgent";
  // Story 63: null on a ticket created before this story shipped.
  createdVia: TicketCreationChannel | null;
  customer: { id: string; name: string; email: string };
  assignedAgent: { id: string; name: string } | null;
  updatedAt: string;
}

interface StaffTicketQueueProps {
  tickets: StaffTicketRow[];
  total: number;
  page: number;
  limit: number;
  // Plan 29: per-status counts scoped by the same category/priority/
  // permission filters as `tickets`, but not by `status` itself — backs the
  // quick-filter chip row above TicketFilterBar.
  statusCounts: Record<StaffTicketRow["status"], number>;
  categories: string[];
  canViewAll: boolean;
  canReassign: boolean;
  canDelete: boolean;
  // Story 25: gates whether the "Assigned to" name links to that agent's
  // account page — never render a link a click would just bounce off of
  // (see frontend/lib/staffNav.ts's convention for this exact reasoning).
  canViewStaffAccount: boolean;
  // Story 25's availability rule: admin/sub-admin may reassign to any
  // active agent regardless of isOnline; a plain agent holding
  // tickets:reassign is restricted to another agent currently online.
  viewerIsUnrestrictedReassigner: boolean;
  currentQuery: string;
  // So a row assigned to the viewer themself can read "You" instead of
  // their own name — seeing your own name in a list you're browsing reads
  // oddly, the same reasoning as any chat/email client's "You" label.
  currentUserId?: string;
}

const STATUS_KEY: Record<StaffTicketRow["status"], string> = {
  new: "statusNew",
  in_progress: "statusInProgress",
  answered: "statusAnswered",
  escalated: "statusEscalated",
  closed: "statusClosed",
};

const PRIORITY_KEY: Record<StaffTicketRow["priority"], string> = {
  low: "priorityLow",
  medium: "priorityMedium",
  high: "priorityHigh",
  urgent: "priorityUrgent",
};

// Semantic status-color tokens per CLAUDE.md's design-system rule — never a
// hardcoded color per feature.
const STATUS_BADGE_CLASS: Record<StaffTicketRow["status"], string> = {
  new: "border-transparent bg-muted text-muted-foreground",
  in_progress: "border-transparent bg-warning/10 text-warning",
  answered: "border-transparent bg-success/10 text-success",
  escalated: "border-transparent bg-destructive/10 text-destructive",
  closed: "border-transparent bg-muted text-muted-foreground",
};

const PRIORITY_BADGE_CLASS: Record<StaffTicketRow["priority"], string> = {
  low: "border-border text-foreground",
  medium: "border-transparent bg-warning/10 text-warning",
  high: "border-transparent bg-destructive/10 text-destructive",
  urgent: "border-transparent bg-destructive/20 text-destructive",
};

// Story 60: the staff branch of /tickets — filterable/sortable/paginated
// queue. Shares this one route+table with the customer branch (see
// page.tsx); only the permission-gated columns/actions differ, per the
// approved agent/subadmin mockups (attachments/agent-list.png,
// attachments/subadmin-list.png).
export async function StaffTicketQueue({
  tickets,
  total,
  page,
  limit,
  statusCounts,
  categories,
  canViewAll,
  canReassign,
  canDelete,
  canViewStaffAccount,
  viewerIsUnrestrictedReassigner,
  currentQuery,
  currentUserId,
}: StaffTicketQueueProps) {
  const t = await getTranslations("Tickets");

  function hrefForPage(nextPage: number) {
    const params = new URLSearchParams(currentQuery);
    params.set("page", String(nextPage));
    return `/tickets?${params.toString()}`;
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight md:text-2xl">{t("heading")}</h1>
      </div>

      <StatusQuickFilterChips statusCounts={statusCounts} />
      <TicketFilterBar categories={categories} />

      {tickets.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          {/* Mobile (< md): stacked cards, same reasoning as /customers. */}
          <div className="flex flex-col gap-3 md:hidden">
            {tickets.map((ticket) => (
              <Link
                key={ticket.id}
                href={`/tickets/${ticket.id}`}
                className="block rounded-xl border border-border p-4 hover:bg-muted/50"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{ticket.reference}</span>
                  <Badge variant="outline" className={STATUS_BADGE_CLASS[ticket.status]}>
                    {t(STATUS_KEY[ticket.status])}
                  </Badge>
                </div>
                <p className="mt-1 font-medium">{ticket.subject}</p>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{ticket.customer.name}</p>
                <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
                  <Badge variant="outline" className={PRIORITY_BADGE_CLASS[ticket.priority]}>
                    {t(PRIORITY_KEY[ticket.priority])}
                  </Badge>
                  <span>{formatDateTime(ticket.updatedAt)}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* md and up: the real table. */}
          <div className="hidden overflow-hidden rounded-2xl border border-border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columnReference")}</TableHead>
                  <TableHead>{t("columnCustomer")}</TableHead>
                  <TableHead>{t("columnSubject")}</TableHead>
                  <TableHead>{t("columnCategory")}</TableHead>
                  <TableHead>{t("columnPriority")}</TableHead>
                  <TableHead>{t("columnStatus")}</TableHead>
                  <TableHead>{t("columnSource")}</TableHead>
                  {canViewAll && <TableHead>{t("columnAssignedTo")}</TableHead>}
                  <TableHead>{t("columnUpdated")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket) => (
                  <TableRow key={ticket.id} className="group">
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      <Link href={`/tickets/${ticket.id}`} className="hover:underline">
                        {ticket.reference}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/tickets/${ticket.id}`} className="font-medium hover:underline">
                        {ticket.customer.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/tickets/${ticket.id}`} className="hover:underline">
                        {ticket.subject}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{ticket.category ?? t("uncategorized")}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={PRIORITY_BADGE_CLASS[ticket.priority]}>
                        {t(PRIORITY_KEY[ticket.priority])}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_BADGE_CLASS[ticket.status]}>
                        {t(STATUS_KEY[ticket.status])}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {ticket.createdVia ? (
                        <Badge variant="outline" className={`gap-1 ${SOURCE_BADGE_CLASS[ticket.createdVia]}`}>
                          <span aria-hidden="true">{SOURCE_EMOJI[ticket.createdVia]}</span>
                          {t(SOURCE_LABEL_KEY[ticket.createdVia])}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-muted-foreground">
                          {t("sourceUnknown")}
                        </Badge>
                      )}
                    </TableCell>
                    {canViewAll && (
                      <TableCell className="text-sm text-muted-foreground">
                        {(() => {
                          if (!ticket.assignedAgent) return t("unassigned");
                          if (ticket.assignedAgent.id === currentUserId) return t("assignedToYou");
                          return canViewStaffAccount ? (
                            <Link href={`/admin/users/${ticket.assignedAgent.id}/edit`} className="hover:underline">
                              {ticket.assignedAgent.name}
                            </Link>
                          ) : (
                            ticket.assignedAgent.name
                          );
                        })()}
                      </TableCell>
                    )}
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(ticket.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          title={t("escalate")}
                          className="text-warning hover:bg-warning/10 hover:text-warning"
                        >
                          <Link href={`/tickets/${ticket.id}`}>
                            <ArrowUpCircle className="size-4" />
                            <span className="sr-only">{t("escalate")}</span>
                          </Link>
                        </Button>
                        {canReassign && (
                          <ReassignAgentMenu
                            ticketId={ticket.id}
                            currentAgentId={ticket.assignedAgent?.id ?? null}
                            viewerIsUnrestrictedReassigner={viewerIsUnrestrictedReassigner}
                          />
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled
                            title="Coming soon"
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <div className="mt-4">
        <ListPagination total={total} page={page} limit={limit} hrefForPage={hrefForPage} />
      </div>
    </div>
  );
}
