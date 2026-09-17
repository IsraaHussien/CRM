"use client";

import { useActionState, useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Check, Phone, Mail, KeyRound } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  updatePhone,
  updateEmail,
  changePassword,
  type ContactActionState,
  type ChangePasswordActionState,
} from "./actions";

interface ContactInfo {
  phone: string | null;
  email: string;
  pendingEmail: string | null;
}

const INITIAL_STATE: ContactActionState = { error: null, message: null };
const PASSWORD_INITIAL_STATE: ChangePasswordActionState = { ok: false, error: null };

// Phone and email are two independent Server Actions (Story 5: email changes
// go through a confirm-then-apply flow, phone applies immediately) — they
// can't be merged into a single submit. Each field instead gets its own
// compact inline save affordance (icon button, enabled only once the value
// is actually dirty) rather than two full-width buttons stacked in the card.
export function SettingsForm({ contact }: { contact: ContactInfo }) {
  const t = useTranslations("Settings");
  const tAuth = useTranslations("Auth");
  const [phoneState, phoneAction, phonePending] = useActionState(updatePhone, INITIAL_STATE);
  const [emailState, emailAction, emailPending] = useActionState(updateEmail, INITIAL_STATE);
  const [passwordState, passwordAction, passwordPending] = useActionState(changePassword, PASSWORD_INITIAL_STATE);
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [email, setEmail] = useState(contact.email);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const phoneDirty = phone !== (contact.phone ?? "");
  const emailDirty = email !== contact.email;

  // Controlled inputs get reset to empty after every submission (success or
  // error) by React itself once a Server Action completes — but only the
  // success case should actually clear these fields; on error we want the
  // values to stick around so the user isn't retyping everything. Since
  // they're controlled (not defaultValue), they never auto-blank on their
  // own — this effect is what explicitly clears them once success is
  // confirmed.
  useEffect(() => {
    if (passwordState.ok) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
    }
  }, [passwordState]);

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <Card className="w-full rounded-[28px] rounded-ss-none border-none shadow-pop ring-1 ring-foreground/10">
        <CardHeader className="items-center gap-1 pt-6 text-center">
          <CardTitle className="text-2xl font-bold tracking-tight">{t("heading")}</CardTitle>
          <CardDescription className="text-balance">{t("subheading")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <form action={phoneAction} className="flex flex-col gap-2">
            <Label htmlFor="phone">{t("phone")}</Label>
            <div className="relative">
              <Phone className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="phone"
                name="phone"
                type="tel"
                className="ps-8 pe-9"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <Button
                type="submit"
                size="icon-sm"
                variant="secondary"
                aria-label={t("savePhone")}
                disabled={phonePending || !phoneDirty}
                className="absolute inset-y-0 end-1 my-auto disabled:opacity-0"
              >
                <Check />
              </Button>
            </div>
            {phoneState.error && <p className="text-sm text-destructive">{phoneState.error}</p>}
            {phoneState.message && <p className="text-sm text-muted-foreground">{phoneState.message}</p>}
          </form>

          <form action={emailAction} className="flex flex-col gap-2">
            <Label htmlFor="email">{t("email")}</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                name="email"
                className="ps-8 pe-9"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button
                type="submit"
                size="icon-sm"
                variant="secondary"
                aria-label={t("saveEmail")}
                disabled={emailPending || !emailDirty}
                className="absolute inset-y-0 end-1 my-auto disabled:opacity-0"
              >
                <Check />
              </Button>
            </div>
            {emailState.error && <p className="text-sm text-destructive">{emailState.error}</p>}
            {emailState.message && <p className="text-sm text-muted-foreground">{emailState.message}</p>}
            {contact.pendingEmail && (
              <p className="text-sm text-muted-foreground">{t("pendingEmail", { email: contact.pendingEmail })}</p>
            )}
          </form>
        </CardContent>
        <CardFooter className="border-t-0 bg-transparent pt-1">
          <p className="text-xs text-muted-foreground">{t("currentEmail", { email: contact.email })}</p>
        </CardFooter>
      </Card>

      <Card className="w-full rounded-[28px] rounded-ss-none border-none shadow-pop ring-1 ring-foreground/10">
        <CardHeader className="items-center gap-1 pt-6 text-center">
          <CardTitle className="text-xl font-bold tracking-tight">{t("changePassword.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={passwordAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="currentPassword">{t("changePassword.currentLabel")}</Label>
              <PasswordInput
                id="currentPassword"
                name="currentPassword"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                aria-invalid={Boolean(passwordState.fieldErrors?.currentPassword)}
                showLabel={tAuth("showPassword")}
                hideLabel={tAuth("hidePassword")}
              />
              {passwordState.fieldErrors?.currentPassword && (
                <p className="text-sm text-destructive">{passwordState.fieldErrors.currentPassword}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="newPassword">{t("changePassword.newLabel")}</Label>
              <PasswordInput
                id="newPassword"
                name="newPassword"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                aria-invalid={Boolean(passwordState.fieldErrors?.newPassword)}
                showLabel={tAuth("showPassword")}
                hideLabel={tAuth("hidePassword")}
              />
              {passwordState.fieldErrors?.newPassword && (
                <p className="text-sm text-destructive">{passwordState.fieldErrors.newPassword}</p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmNewPassword">{t("changePassword.confirmLabel")}</Label>
              <PasswordInput
                id="confirmNewPassword"
                name="confirmNewPassword"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                aria-invalid={Boolean(passwordState.fieldErrors?.confirmNewPassword)}
                showLabel={tAuth("showPassword")}
                hideLabel={tAuth("hidePassword")}
              />
              {passwordState.fieldErrors?.confirmNewPassword && (
                <p className="text-sm text-destructive">{passwordState.fieldErrors.confirmNewPassword}</p>
              )}
            </div>
            {passwordState.error && <p className="text-sm text-destructive">{passwordState.error}</p>}
            {passwordState.ok && (
              <p className="text-sm text-muted-foreground">{t("changePassword.success")}</p>
            )}
            <Button type="submit" disabled={passwordPending} className="gap-2">
              <KeyRound className="size-4" />
              {t("changePassword.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
