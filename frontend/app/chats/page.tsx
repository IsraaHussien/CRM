import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { StaffSidebar } from "@/components/StaffSidebar";
import { API_URL, REFRESH_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { peekJwtPayload } from "@/lib/jwt";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { CustomerChatList, type CustomerChatRow } from "./CustomerChatList";

// customer-portal Story 37: a customer landing here now too (see the
// role branch below) needs a title that isn't staff-voiced.
export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const isCustomer = token ? peekJwtPayload(token).role === "customer" : false;
  const t = await getTranslations(isCustomer ? "MyChats" : "AgentChats");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

interface ConversationRow {
  _id: string;
  customer: { _id: string; name: string };
  assignedAgent: { _id: string; name: string } | null;
  status: "ai_handling" | "escalated" | "with_agent" | "resolved";
  updatedAt: string;
}

const STATUS_KEY: Record<ConversationRow["status"], string> = {
  ai_handling: "statusAiHandling",
  escalated: "statusEscalated",
  with_agent: "statusWithAgent",
  resolved: "statusResolved",
};

const STATUS_BADGE_CLASS: Record<ConversationRow["status"], string> = {
  ai_handling: "border-transparent bg-muted text-muted-foreground",
  escalated: "border-transparent bg-destructive/10 text-destructive",
  with_agent: "border-transparent bg-success/10 text-success",
  resolved: "border-transparent bg-muted text-muted-foreground",
};

// Story 18: minimal staff "Chats" surface — an agent's own assigned live
// chats, or every active one for an admin (Story 20's full unified
// dashboard is a later, separate feature; this is deliberately small).
//
// customer-portal Story 37: one route, role-branched — same "one route,
// role-branched" pattern frontend/app/tickets/page.tsx already established
// for Story 36/60. A customer sees their own conversations, any status
// (CustomerChatList); staff see the existing filtered table below.
export default async function ChatsPage({
  searchParams,
}: {
  searchParams: Promise<{ _refreshed?: string }>;
}) {
  const { _refreshed } = await searchParams;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  if (!token) {
    if (hasRefreshToken && !_refreshed) {
      redirect("/api/session/refresh?next=/chats");
    }
    redirect("/");
  }

  const { role } = peekJwtPayload(token);
  const isCustomer = role === "customer";
  const t = await getTranslations(isCustomer ? "MyChats" : "AgentChats");

  const res = await fetch(`${API_URL}/api/v1/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) {
    if (!_refreshed) {
      redirect("/api/session/refresh?next=/chats");
    }
    redirect("/login");
  }
  if (!res.ok) {
    // Covers 403 too — a staff persona without chats:manage never gets a
    // working link to this page (see lib/staffNav.ts), so reaching it and
    // being turned away belongs on the dashboard, same convention
    // admin/users/page.tsx uses for staff:view_list.
    redirect("/dashboard");
  }
  const data: { conversations: ConversationRow[] } = await res.json();

  if (isCustomer) {
    return (
      <main className="min-h-[calc(100vh-57px)] p-4 md:p-8">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="mb-6 text-xl font-bold tracking-tight md:text-2xl">{t("heading")}</h1>
          <CustomerChatList conversations={data.conversations as CustomerChatRow[]} />
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-57px)]">
      <StaffSidebar active="chats" />
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <h1 className="mb-6 text-xl font-bold tracking-tight md:text-2xl">{t("heading")}</h1>

        {data.conversations.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columnCustomer")}</TableHead>
                  <TableHead>{t("columnStatus")}</TableHead>
                  <TableHead>{t("columnHandledBy")}</TableHead>
                  <TableHead>{t("columnUpdated")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.conversations.map((conversation) => (
                  <TableRow key={conversation._id}>
                    <TableCell>
                      <Link
                        href={`/customers/${conversation.customer._id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {conversation.customer.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_BADGE_CLASS[conversation.status]}>
                        {t(STATUS_KEY[conversation.status])}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {conversation.assignedAgent ? conversation.assignedAgent.name : t("unclaimedRow")}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(conversation.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <Link href={`/chats/${conversation._id}`} className="text-sm font-medium text-primary hover:underline">
                        {t("open")}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </main>
    </div>
  );
}
