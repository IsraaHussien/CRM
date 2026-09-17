import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE, REFRESH_COOKIE } from "@/lib/auth";
import { StaffSidebar } from "@/components/StaffSidebar";
import { CustomerProfileForm } from "./CustomerProfileForm";
import { getCustomerHistory } from "./actions";

// Same 401/refresh handling as settings/page.tsx — see that file's comment
// and .squad/plans/auth/02-story-login-customer-agent-or-admin.md for why.
export default async function CustomerProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ _refreshed?: string; tab?: string }>;
}) {
  const { id } = await params;
  const { _refreshed, tab } = await searchParams;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const hasRefreshToken = Boolean(cookieStore.get(REFRESH_COOKIE)?.value);

  if (!token) {
    if (hasRefreshToken && !_refreshed) {
      redirect(`/api/session/refresh?next=/customers/${id}`);
    }
    redirect("/");
  }

  const t = await getTranslations("CustomerProfile");
  const res = await fetch(`${API_URL}/api/v1/customers/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (res.status === 401 && !_refreshed) {
    redirect(`/api/session/refresh?next=/customers/${id}`);
  }

  if (!res.ok) {
    return (
      <main className="flex min-h-[calc(100vh-57px)] items-center justify-center p-8">
        <p className="text-muted-foreground">{t("notFound")}</p>
      </main>
    );
  }

  const profile = await res.json();
  // Same signal CustomerProfileForm itself uses to pick its Tab 2 content —
  // whether the backend included internalNotes, never a client-side role
  // check. Deciding whether to show the staff sidebar here too keeps both
  // decisions driven by the one authoritative source.
  const isStaff = profile.internalNotes !== undefined;

  if (isStaff) {
    const history = await getCustomerHistory(id, token);
    return (
      <div className="flex min-h-[calc(100vh-57px)]">
        <StaffSidebar active="customers" />
        <main className="min-w-0 flex-1 p-4 md:p-8">
          <CustomerProfileForm profile={profile} history={history} initialTab={tab === "history" ? "history" : "profile"} />
        </main>
      </div>
    );
  }

  return (
    <main className="mx-auto min-h-[calc(100vh-57px)] w-full max-w-5xl p-4 md:p-8">
      <CustomerProfileForm profile={profile} />
    </main>
  );
}
