"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { CircleAlert, Mail } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { login, type AuthActionState } from "./actions";

const INITIAL_STATE: AuthActionState = { error: null };

// Seeded by `npm run seed:demo` in backend/ (backend/scripts/seed-demo-customer.ts)
// — a real, always-available account so anyone can explore the live app in
// one click, no signup required.
const DEMO_EMAIL = "demo@azmsquad.com";
const DEMO_PASSWORD = "Demo@12345";

// Seeded by `npm run seed:admin` in backend/ (backend/scripts/seed-admin.ts)
// — same one-click-exploration rationale as the demo customer above, for
// staff-side (admin) screens.
const ADMIN_EMAIL = "admin@azmsquad.com";
const ADMIN_PASSWORD = "Admin@12345";

export function LoginForm() {
  const t = useTranslations("Login");
  const tAuth = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE);
  // Controlled inputs: React resets uncontrolled <input>s to empty after every
  // Server Action submission (success or error) — without this, a failed
  // attempt silently blanks the email field, so a retry with just the
  // password fixed ends up submitting an empty email (see CLAUDE.md, "Forms
  // backed by Server Actions").
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">{t("heading")}</h2>
        <p className="text-sm text-muted-foreground">{t("subheading")}</p>
      </div>
      <form action={formAction} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t("email")}</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              className="ps-8"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(state.fieldErrors?.email)}
              required
            />
          </div>
          {state.fieldErrors?.email && <p className="text-sm text-destructive">{state.fieldErrors.email}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t("password")}</Label>
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
            >
              {t("forgotPasswordLink")}
            </Link>
          </div>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(state.fieldErrors?.password)}
            showLabel={tAuth("showPassword")}
            hideLabel={tAuth("hidePassword")}
            required
          />
          {state.fieldErrors?.password && <p className="text-sm text-destructive">{state.fieldErrors.password}</p>}
        </div>
        {state.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={pending} className="transition-transform active:scale-[0.98]">
          {pending ? t("submitPending") : t("submit")}
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              setEmail(DEMO_EMAIL);
              setPassword(DEMO_PASSWORD);
            }}
            className="rounded-xl border border-dashed border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {t("fillDemo")}
          </button>
          <button
            type="button"
            onClick={() => {
              setEmail(ADMIN_EMAIL);
              setPassword(ADMIN_PASSWORD);
            }}
            className="rounded-xl border border-dashed border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            {t("fillAdmin")}
          </button>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          {t("noAccount")}{" "}
          <Link href="/register" className="text-primary underline-offset-4 hover:underline">
            {t("signUp")}
          </Link>
        </p>
      </form>
    </div>
  );
}
