import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthHero } from "@/components/AuthHero";
import { ResetPasswordForm } from "./ResetPasswordForm";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ResetPassword");
  return { title: t("title") };
}

// Public page — reads the token from the URL and hands it to the client
// form, which posts it back to the backend alongside the new password. No
// auth guard: whoever clicks the emailed link is by definition not
// authenticated in this browser.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="flex min-h-[calc(100vh-57px)] items-center justify-center p-4 md:p-8">
      <div className="relative w-full max-w-5xl">
        <AuthHero />
        <div className="z-10 mt-6 w-full rounded-3xl border border-border bg-card p-8 shadow-pop ring-1 ring-foreground/10 md:absolute md:end-8 md:top-1/2 md:mt-0 md:w-[380px] md:-translate-y-1/2 md:p-9 animate-in fade-in slide-in-from-bottom-4 duration-500 [animation-delay:100ms] [animation-fill-mode:both]">
          <ResetPasswordForm token={token ?? null} />
        </div>
      </div>
    </main>
  );
}
