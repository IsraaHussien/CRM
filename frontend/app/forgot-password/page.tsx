import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthHero } from "@/components/AuthHero";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

// Public, customer-facing page — real per-page SEO metadata, same pattern as
// login/register (see CLAUDE.md's SEO conventions for public pages).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ForgotPassword");
  return { title: t("title"), description: t("description") };
}

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-[calc(100vh-57px)] items-center justify-center p-4 md:p-8">
      <div className="relative w-full max-w-5xl">
        <AuthHero />
        <div className="z-10 mt-6 w-full rounded-3xl border border-border bg-card p-8 shadow-pop ring-1 ring-foreground/10 md:absolute md:end-8 md:top-1/2 md:mt-0 md:w-[380px] md:-translate-y-1/2 md:p-9 animate-in fade-in slide-in-from-bottom-4 duration-500 [animation-delay:100ms] [animation-fill-mode:both]">
          <ForgotPasswordForm />
        </div>
      </div>
    </main>
  );
}
