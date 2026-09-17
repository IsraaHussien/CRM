"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { resetPassword, type ResetPasswordActionState } from "./actions";

const INITIAL_STATE: ResetPasswordActionState = { ok: false, error: null };

export function ResetPasswordForm({ token }: { token: string | null }) {
  const t = useTranslations("ResetPassword");
  const tAuth = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(resetPassword, INITIAL_STATE);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  if (state.ok) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Alert>
          <CircleCheck className="text-success" />
          <AlertDescription>{t("success")}</AlertDescription>
        </Alert>
        <Link href="/login" className="text-center text-sm text-primary underline-offset-4 hover:underline">
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{t("missingToken")}</AlertDescription>
        </Alert>
        <Link href="/forgot-password" className="text-center text-sm text-primary underline-offset-4 hover:underline">
          {t("requestNewLink")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">{t("title")}</h2>
      </div>
      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="token" value={token} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="newPassword">{t("newPasswordLabel")}</Label>
          <PasswordInput
            id="newPassword"
            name="newPassword"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            aria-invalid={Boolean(state.fieldErrors?.newPassword)}
            showLabel={tAuth("showPassword")}
            hideLabel={tAuth("hidePassword")}
            required
          />
          {state.fieldErrors?.newPassword && <p className="text-sm text-destructive">{state.fieldErrors.newPassword}</p>}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmPassword">{t("confirmPasswordLabel")}</Label>
          <PasswordInput
            id="confirmPassword"
            name="confirmPassword"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            aria-invalid={Boolean(state.fieldErrors?.confirmPassword)}
            showLabel={tAuth("showPassword")}
            hideLabel={tAuth("hidePassword")}
            required
          />
          {state.fieldErrors?.confirmPassword && (
            <p className="text-sm text-destructive">{state.fieldErrors.confirmPassword}</p>
          )}
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
      </form>
    </div>
  );
}
