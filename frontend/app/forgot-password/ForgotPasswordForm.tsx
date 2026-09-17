"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { CircleAlert, CircleCheck, Mail } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { requestPasswordReset, type ForgotPasswordActionState } from "./actions";

const INITIAL_STATE: ForgotPasswordActionState = { ok: false, error: null };

export function ForgotPasswordForm() {
  const t = useTranslations("ForgotPassword");
  const [state, formAction, pending] = useActionState(requestPasswordReset, INITIAL_STATE);
  const [email, setEmail] = useState("");

  if (state.ok) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Alert>
          <CircleCheck className="text-success" />
          <AlertDescription>{t("genericSuccess")}</AlertDescription>
        </Alert>
        <Link href="/login" className="text-center text-sm text-primary underline-offset-4 hover:underline">
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <form action={formAction} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t("emailLabel")}</Label>
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
        {state.error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={pending} className="transition-transform active:scale-[0.98]">
          {t("submit")}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="text-primary underline-offset-4 hover:underline">
            {t("backToSignIn")}
          </Link>
        </p>
      </form>
    </div>
  );
}
