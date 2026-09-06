"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { submitFeedback } from "../../actions";

interface FeedbackFormProps {
  parentType: "ticket" | "conversation";
  parentId: string;
}

// customer-portal Story 39: 1-5 star picker + optional comment. Same
// useTransition + inline-message pattern as ReopenTicketButton.tsx. On
// success, router.refresh() re-fetches the host Server Component, which
// then renders the read-only receipt instead of this form — same
// revalidate-and-rerender approach the reopen/status actions already rely on.
export function FeedbackForm({ parentType, parentId }: FeedbackFormProps) {
  const t = useTranslations("Feedback");
  const router = useRouter();
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = await submitFeedback(parentType, parentId, {
        rating,
        comment: comment.trim() || undefined,
      });
      if (result.error) {
        setError(result.error);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1" role="radiogroup" aria-label={t("ratingLabel")}>
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={rating === value}
            aria-label={String(value)}
            onClick={() => setRating(value)}
            onMouseEnter={() => setHoverRating(value)}
            onMouseLeave={() => setHoverRating(0)}
            className="p-0.5"
          >
            <Star
              className={cn(
                "size-7",
                (hoverRating || rating) >= value ? "fill-primary text-primary" : "text-muted-foreground"
              )}
            />
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="feedback-comment" className="text-sm font-medium">
          {t("commentLabel")}
        </label>
        <Textarea
          id="feedback-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t("commentPlaceholder")}
          rows={4}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button onClick={handleSubmit} disabled={rating < 1 || pending} className="w-full sm:w-auto">
        {pending ? t("submitPending") : t("submit")}
      </Button>
    </div>
  );
}
