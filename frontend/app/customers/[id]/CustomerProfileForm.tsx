"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { CircleAlert, Mail, Phone, User, History } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { InternalStep, type HydratedAttachment, type HydratedNote } from "./InternalStep";
import { AttachmentsGalleryStep } from "./AttachmentsGalleryStep";
import { CustomerHistoryTimeline } from "./CustomerHistoryTimeline";
import { updateProfile, type ProfileActionState, type CustomerTimelineItem } from "./actions";

interface Profile {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  ticketHistoryUrl: string;
  // Present only for a full-staff viewer (Story 7) — absence, not an empty
  // array, is what tells this component to render the read-only gallery
  // instead of the staff "Internal" tab. Never derived from role client-side.
  internalNotes?: HydratedNote[];
  attachments?: HydratedAttachment[];
  idDocument?: HydratedAttachment | null;
}

const INITIAL_STATE: ProfileActionState = { error: null, message: null };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

// Full-width header + tabs shell (Story 7 redesign) — replaces the earlier
// narrow centered-card stepper, which reused the login/register auth-card
// layout for a page that now holds a notes feed, an ID document, and a
// growing attachments list. Tab 2's content depends entirely on whether the
// backend included internalNotes, never a client-side role check (see the
// Profile interface's comment above).
export function CustomerProfileForm({
  profile,
  history,
  initialTab,
}: {
  profile: Profile;
  history?: CustomerTimelineItem[];
  initialTab?: string;
}) {
  const t = useTranslations("CustomerProfile");
  const tNav = useTranslations("Nav");
  const updateProfileForId = updateProfile.bind(null, profile.id);
  const [state, formAction, pending] = useActionState(updateProfileForId, INITIAL_STATE);

  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [tab, setTab] = useState(initialTab ?? "profile");

  const isStaffMode = profile.internalNotes !== undefined;

  return (
    <div className="flex flex-col gap-6">
      {isStaffMode && (
        <nav className="text-sm text-muted-foreground">
          <Link href="/customers" className="hover:text-foreground hover:underline">
            {tNav("customers")}
          </Link>
          <span className="mx-2">/</span>
          <span className="font-medium text-foreground">{profile.name}</span>
        </nav>
      )}
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-card sm:flex-row sm:items-center sm:p-6">
        <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-primary text-lg font-bold text-primary-foreground">
          {initials(profile.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">{profile.name}</h1>
            {isStaffMode && (
              <Badge
                variant="outline"
                className={profile.isActive ? "border-transparent bg-success/10 text-success" : "bg-secondary"}
              >
                {profile.isActive ? t("statusActive") : t("statusInactive")}
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{profile.email}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("createdAt", { date: new Date(profile.createdAt).toLocaleDateString() })}
          </p>
        </div>
        {isStaffMode && (
          <Button variant="outline" size="sm" className="sm:self-start" onClick={() => setTab("history")}>
            <History className="size-4" />
            {t("viewHistory")}
          </Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList variant="line" className="h-auto gap-4 border-b border-border p-0">
          <TabsTrigger
            value="profile"
            className="px-1 pb-2.5 text-sm data-active:text-primary dark:data-active:text-primary after:bg-primary group-data-horizontal/tabs:after:bottom-0"
          >
            {t("stepProfile")}
          </TabsTrigger>
          <TabsTrigger
            value="step2"
            className="px-1 pb-2.5 text-sm data-active:text-primary dark:data-active:text-primary after:bg-primary group-data-horizontal/tabs:after:bottom-0"
          >
            {t(isStaffMode ? "stepInternal" : "stepDocuments")}
          </TabsTrigger>
          {isStaffMode && (
            <TabsTrigger
              value="history"
              className="px-1 pb-2.5 text-sm data-active:text-primary dark:data-active:text-primary after:bg-primary group-data-horizontal/tabs:after:bottom-0"
            >
              {t("stepHistory")}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile" className="pt-6">
          <div className="max-w-xl rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6">
            <form action={formAction}>
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">{t("name")}</Label>
                  <div className="relative">
                    <User className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="name"
                      name="name"
                      className="ps-8"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      aria-invalid={Boolean(state.fieldErrors?.name)}
                      required
                    />
                  </div>
                  {state.fieldErrors?.name && <p className="text-sm text-destructive">{state.fieldErrors.name}</p>}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">{t("email")}</Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      name="email"
                      type="email"
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
                  <Label htmlFor="phone">{t("phone")}</Label>
                  <div className="relative">
                    <Phone className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="phone"
                      name="phone"
                      type="tel"
                      className="ps-8"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      aria-invalid={Boolean(state.fieldErrors?.phone)}
                    />
                  </div>
                  {state.fieldErrors?.phone && <p className="text-sm text-destructive">{state.fieldErrors.phone}</p>}
                </div>
                {state.error && (
                  <Alert variant="destructive">
                    <CircleAlert />
                    <AlertDescription>{state.error}</AlertDescription>
                  </Alert>
                )}
                {state.message && <p className="text-sm text-muted-foreground">{state.message}</p>}
              </div>
              <div className="pt-4">
                <Button type="submit" disabled={pending} className="transition-transform active:scale-[0.98]">
                  {pending ? t("savePending") : t("save")}
                </Button>
              </div>
            </form>
          </div>
        </TabsContent>

        <TabsContent value="step2" className="pt-6">
          {isStaffMode ? (
            <InternalStep
              customerId={profile.id}
              notes={profile.internalNotes ?? []}
              attachments={profile.attachments ?? []}
              idDocument={profile.idDocument ?? null}
            />
          ) : (
            <AttachmentsGalleryStep
              customerId={profile.id}
              attachments={profile.attachments ?? []}
              idDocument={profile.idDocument ?? null}
            />
          )}
        </TabsContent>

        {isStaffMode && (
          <TabsContent value="history" className="pt-6">
            <CustomerHistoryTimeline items={history ?? []} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
