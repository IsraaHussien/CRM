import express, { Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../middleware/auth";
import { hasAnyPermission, isActiveAccount } from "../services/permissions";
import type { PermissionKey } from "../constants/permissions";
import { validateBody, validateParams } from "../middleware/validate";
import { escapeRegex } from "../utils/regex";
import { Faq, IFaq } from "../models/Faq";
import { createFaq, updateFaq, softDeleteFaq } from "../services/faq.service";
import { suggestTranslation, findSimilarFaqs } from "../services/kbAi.service";
import { recordAuditLog } from "../services/auditLog.service";
import {
  faqIdParamsSchema,
  createFaqBodySchema,
  updateFaqBodySchema,
  listFaqsQuerySchema,
  translateFaqFieldBodySchema,
} from "../validation/kbFaq.schema";
import { FAQ_QUESTION_MAX_LENGTH, FAQ_ANSWER_MAX_LENGTH } from "../constants/kb";

// knowledge-base Story 29: admin surface for FAQs, mounted at
// /api/v1/kb/faqs. No draft/published state (product decision, 2026-09-02):
// an FAQ is live for customers as soon as it's created, so kb:faq_create /
// kb:faq_edit / kb:faq_delete are the only gates a write needs — no
// per-field permission split inside PATCH, unlike ticketCategory.routes.ts's
// pattern (which exists there because rename vs. toggle-status need
// different keys; there is only one kind of change here).

const router = express.Router();

// Admin-implicit-pass + live isActive re-check, matching
// requirePermission's own admin branch — do NOT shortcut this to a bare
// role check, or a deactivated admin's still-unexpired token keeps passing
// (see [[feedback_permission_gating_audit]]).
async function callerHasAnyPermission(req: Pick<Request, "user">, keys: PermissionKey[]): Promise<boolean> {
  if (req.user!.role === "admin") return isActiveAccount(req.user!.id);
  return hasAnyPermission(req.user!.id, keys);
}

function toFaqResponse(faq: IFaq) {
  return {
    id: faq.id,
    question: { en: faq.question.en, ar: faq.question.ar },
    answer: { en: faq.answer.en, ar: faq.answer.ar },
    category: faq.category,
    createdAt: faq.createdAt,
    updatedAt: faq.updatedAt,
  };
}

router.get("/", requireAuth, requirePermission("kb:faq_view_list"), async (req: Request, res: Response) => {
  const parsed = listFaqsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { page, limit, q, category, sort } = parsed.data;
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
  if (category) filter.category = category;
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ "question.en": regex }, { "question.ar": regex }, { "answer.en": regex }, { "answer.ar": regex }];
  }

  let sortSpec: Record<string, 1 | -1> = { updatedAt: -1 };
  if (sort) {
    const descending = sort.startsWith("-");
    const key = descending ? sort.slice(1) : sort;
    sortSpec = { [key]: descending ? -1 : 1 };
  }

  const [faqs, total] = await Promise.all([
    Faq.find(filter).sort(sortSpec).skip(skip).limit(limit),
    Faq.countDocuments(filter),
  ]);

  res.status(200).json({ faqs: faqs.map(toFaqResponse), total, page, limit });
});

router.get(
  "/:id",
  requireAuth,
  requirePermission("kb:faq_view_list"),
  validateParams(faqIdParamsSchema),
  async (req: Request<{ id: string }>, res: Response) => {
    const faq = await Faq.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!faq) {
      res.status(404).json({ error: "FAQ not found" });
      return;
    }
    res.status(200).json(toFaqResponse(faq));
  }
);

router.post(
  "/",
  requireAuth,
  requirePermission("kb:faq_create"),
  validateBody(createFaqBodySchema),
  async (req: Request<unknown, unknown, z.infer<typeof createFaqBodySchema>>, res: Response) => {
    const faq = await createFaq({ ...req.body, actorId: req.user!.id });

    await recordAuditLog({
      actor: req.user!.id,
      action: "kb_faq_created",
      targetType: "Faq",
      targetId: faq.id,
      metadata: { question: faq.question.en || faq.question.ar },
      ipAddress: req.ip,
    });

    res.status(201).json(toFaqResponse(faq));
  }
);

router.patch(
  "/:id",
  requireAuth,
  requirePermission("kb:faq_edit"),
  validateParams(faqIdParamsSchema),
  validateBody(updateFaqBodySchema),
  async (
    req: Request<{ id: string }, unknown, z.infer<typeof updateFaqBodySchema>>,
    res: Response
  ) => {
    const faq = await updateFaq(req.params.id, { ...req.body, actorId: req.user!.id });
    if (!faq) {
      res.status(404).json({ error: "FAQ not found" });
      return;
    }

    await recordAuditLog({
      actor: req.user!.id,
      action: "kb_faq_updated",
      targetType: "Faq",
      targetId: faq.id,
      ipAddress: req.ip,
    });

    res.status(200).json(toFaqResponse(faq));
  }
);

router.delete(
  "/:id",
  requireAuth,
  requirePermission("kb:faq_delete"),
  validateParams(faqIdParamsSchema),
  async (req: Request<{ id: string }>, res: Response) => {
    const faq = await softDeleteFaq(req.params.id, req.user!.id);
    if (!faq) {
      res.status(404).json({ error: "FAQ not found" });
      return;
    }

    await recordAuditLog({
      actor: req.user!.id,
      action: "kb_faq_deleted",
      targetType: "Faq",
      targetId: faq.id,
      ipAddress: req.ip,
    });

    res.status(200).json({ id: faq.id, deleted: true });
  }
);

// Reachable by either create-only or edit-only authors — see
// services/permissions.ts's hasAnyPermission.
router.post(
  "/ai/translate",
  requireAuth,
  validateBody(translateFaqFieldBodySchema),
  async (req: Request<unknown, unknown, z.infer<typeof translateFaqFieldBodySchema>>, res: Response) => {
    if (!(await callerHasAnyPermission(req, ["kb:faq_create", "kb:faq_edit"]))) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }
    const { field, from, to, text } = req.body;
    const maxLength = field === "question" ? FAQ_QUESTION_MAX_LENGTH : FAQ_ANSWER_MAX_LENGTH;
    const translation = await suggestTranslation({ text, from, to, kind: field, maxLength });
    res.status(200).json({ translation });
  }
);

router.get(
  "/:id/ai/duplicates",
  requireAuth,
  requirePermission("kb:faq_view_list"),
  validateParams(faqIdParamsSchema),
  async (req: Request<{ id: string }>, res: Response) => {
    const faq = await Faq.findOne({ _id: req.params.id, isDeleted: { $ne: true } });
    if (!faq) {
      res.status(404).json({ error: "FAQ not found" });
      return;
    }
    const duplicates = await findSimilarFaqs({ question: faq.question, excludeId: faq.id });
    res.status(200).json({ duplicates });
  }
);

export default router;
