import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { StaffSidebar } from "@/components/StaffSidebar";
import { Button } from "@/components/ui/button";
import { API_URL, REFRESH_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { peekJwtPayload } from "@/lib/jwt";
import { AgentChatPanel, type AgentChatMessage } from "./AgentChatPanel";
import { CustomerChatTranscript } from "./CustomerChatTranscript";

// customer-portal Story 37: a customer landing here now too needs a title
// that isn't staff-voiced, same reasoning as /chats/page.tsx's generateMetadata.
export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const isCustomer = token ? peekJwtPayload(token).role === "customer" : false;
  const t = await getTranslations(isCustomer ? "MyChats" : "AgentChats");
  return { title: t("detailMetaTitle"), robots: { index: false, follow: false } };
}

interface ConversationDetail {
  _id: string;
  status: "ai_handling" | "escalated" | "with_agent" | "resolved";
  assignedAgent: { _id: string; name: string } | null;
}

export default async function ChatDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ _refreshed?: string }>;
}) {
  const { id } = await params;
  const { _refreshed } = await searchParams;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  if (!token) {
    if (hasRefreshToken && !_refreshed) {
      redirect(`/api/session/refresh?next=/chats/${id}`);
    }
    redirect("/");
  }

  const { id: currentUserId, role, permissions: viewerPermissions = [] } = peekJwtPayload(token);
  // ai-features Story 32: agent-only, same shape as tickets/[id]/page.tsx's canSummarize.
  const canSummarize = role === "admin" || viewerPermissions.includes("ai:summarize");

  const res = await fetch(`${API_URL}/api/v1/conversations/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) {
    if (!_refreshed) {
      redirect(`/api/session/refresh?next=/chats/${id}`);
    }
    redirect("/login");
  }
  if (res.status === 403 || res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    redirect("/chats");
  }
  const data: { conversation: ConversationDetail; messages: AgentChatMessage[] } = await res.json();

  if (role === "customer") {
    // customer-portal Story 37: a still-active conversation belongs on the
    // real-time panel, not a read-only history page — only a resolved one
    // renders here.
    if (data.conversation.status !== "resolved") {
      redirect("/chat");
    }
    const t = await getTranslations("MyChats");
    return (
      <main className="min-h-[calc(100vh-57px)] p-4 md:p-8">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="mb-6 text-xl font-bold tracking-tight md:text-2xl">{t("detailHeading")}</h1>
          <CustomerChatTranscript messages={data.messages} currentUserId={currentUserId} />
          {/* customer-portal Story 39: only reachable here since this whole
              branch already requires status === "resolved". */}
          <Button asChild variant="link" size="sm" className="mt-4 px-0">
            <Link href={`/feedback/conversation/${data.conversation._id}`}>{t("rateThisChat")}</Link>
          </Button>
        </div>
      </main>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-57px)]">
      <StaffSidebar active="chats" />
      <main className="flex min-w-0 flex-1 items-center justify-center p-4 md:p-8">
        <AgentChatPanel
          conversationId={data.conversation._id}
          initialStatus={data.conversation.status}
          initialMessages={data.messages}
          initialClaimant={
            data.conversation.assignedAgent
              ? { id: data.conversation.assignedAgent._id, name: data.conversation.assignedAgent.name }
              : null
          }
          token={token}
          currentUserId={currentUserId}
          canSummarize={canSummarize}
        />
      </main>
    </div>
  );
}
