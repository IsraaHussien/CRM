import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Star, CheckCircle2 } from "lucide-react";
import { SESSION_COOKIE, REFRESH_COOKIE, API_URL } from "@/lib/auth";
import { peekJwtPayload } from "@/lib/jwt";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FeedbackForm } from "./FeedbackForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Feedback");
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

interface FeedbackResponse {
  eligible: boolean;
  feedback: { rating: number; comment: string | null; createdAt: string } | null;
}

// customer-portal Story 39: reached either from the "rate your experience"
// resolution email or the in-app "Rate this" entry points on the
// ticket-detail / chat-detail pages. Auth pattern mirrors every other
// customer-facing detail page this session touched (tickets/[id]/page.tsx).
export default async function FeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ parentType: string; id: string }>;
  searchParams: Promise<{ _refreshed?: string }>;
}) {
  const { parentType, id } = await params;
  if (parentType !== "ticket" && parentType !== "conversation") {
    notFound();
  }

  const { _refreshed } = await searchParams;
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  if (!accessToken) {
    if (hasRefreshToken && !_refreshed) {
      redirect(`/api/session/refresh?next=/feedback/${parentType}/${id}`);
    }
    redirect("/");
  }

  const { role } = peekJwtPayload(accessToken);
  if (role !== "customer") {
    redirect("/dashboard");
  }

  const t = await getTranslations("Feedback");

  const res = await fetch(`${API_URL}/api/v1/feedback/${parentType}/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (res.status === 401) {
    if (!_refreshed) {
      redirect(`/api/session/refresh?next=/feedback/${parentType}/${id}`);
    }
    redirect("/login");
  }
  if (res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    redirect("/tickets");
  }

  const data: FeedbackResponse = await res.json();
  const backHref = parentType === "ticket" ? "/tickets" : "/chats";
  const backLabel = parentType === "ticket" ? t("backToTickets") : t("backToChats");

  return (
    <main className="flex min-h-[calc(100vh-57px)] items-center justify-center p-4 md:p-8">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col gap-4 p-6">
          <h1 className="text-xl font-bold tracking-tight">{t("heading")}</h1>

          {data.feedback ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle2 className="size-10 text-success" />
              <p className="font-medium">{t("thanksHeading")}</p>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((value) => (
                  <Star
                    key={value}
                    className={cn(
                      "size-5",
                      data.feedback!.rating >= value ? "fill-primary text-primary" : "text-muted-foreground"
                    )}
                  />
                ))}
              </div>
              {data.feedback.comment && (
                <p className="text-sm text-muted-foreground">&ldquo;{data.feedback.comment}&rdquo;</p>
              )}
            </div>
          ) : !data.eligible ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <p className="font-medium">{t("notEligibleHeading")}</p>
              <p className="text-sm text-muted-foreground">{t("notEligibleBody")}</p>
            </div>
          ) : (
            <FeedbackForm parentType={parentType} parentId={id} />
          )}

          <Button asChild variant="ghost" size="sm" className="self-start">
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
