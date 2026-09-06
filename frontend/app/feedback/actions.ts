"use server";

import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { API_URL, SESSION_COOKIE } from "@/lib/auth";
import { refreshSession } from "@/lib/session";

export interface SubmitFeedbackState {
  error: string | null;
}

// customer-portal Story 39: same getBearerToken/401-retry-once shape as
// every other Server Action touched this session (tickets/[id]/actions.ts).
async function getBearerToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) return token;
  return refreshSession();
}

export async function submitFeedback(
  parentType: "ticket" | "conversation",
  parentId: string,
  input: { rating: number; comment?: string }
): Promise<SubmitFeedbackState> {
  const t = await getTranslations("Feedback");
  const token = await getBearerToken();
  if (!token) {
    return { error: t("errorGeneric") };
  }

  const doFetch = (bearer: string) =>
    fetch(`${API_URL}/api/v1/feedback/${parentType}/${parentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(input),
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const refreshedToken = await refreshSession();
    if (!refreshedToken) {
      return { error: t("errorGeneric") };
    }
    res = await doFetch(refreshedToken);
  }

  if (!res.ok) {
    if (res.status === 409) return { error: t("errorAlreadySubmitted") };
    if (res.status === 403) return { error: t("errorNotEligible") };
    return { error: t("errorGeneric") };
  }

  return { error: null };
}
