import express, { Request, Response } from "express";
import { Types } from "mongoose";
import { requireAuth, requireRole } from "../middleware/auth";
import { validateBody, validateParams } from "../middleware/validate";
import { Feedback } from "../models/Feedback";
import { Ticket } from "../models/Ticket";
import { Conversation } from "../models/Conversation";
import { feedbackParentTypeParamSchema, feedbackBodySchema } from "../validation/feedback.schema";
import { recordAuditLog } from "../services/auditLog.service";

const router = express.Router();

type ParentType = "ticket" | "conversation";

async function loadEligibleParent(
  parentType: ParentType,
  parentId: string,
  customerId: string
): Promise<{ found: boolean; owned: boolean; eligible: boolean }> {
  if (!Types.ObjectId.isValid(parentId)) return { found: false, owned: false, eligible: false };
  if (parentType === "ticket") {
    const ticket = await Ticket.findById(parentId).select("customer status");
    if (!ticket) return { found: false, owned: false, eligible: false };
    return {
      found: true,
      owned: String(ticket.customer) === customerId,
      eligible: ticket.status === "closed",
    };
  }
  const conversation = await Conversation.findById(parentId).select("customer status");
  if (!conversation) return { found: false, owned: false, eligible: false };
  return {
    found: true,
    owned: String(conversation.customer) === customerId,
    eligible: conversation.status === "resolved",
  };
}

// customer-portal Story 39: self-scoped, so requireRole("customer") is
// enough — no permission-key concept for a customer, ownership checked
// per-request against the parent's own customer field. "404, not 403" for
// someone else's item, same as GET /tickets/:id (ticket.routes.ts) — no
// existence leak either way.
router.get(
  "/:parentType/:parentId",
  requireAuth,
  requireRole("customer"),
  validateParams(feedbackParentTypeParamSchema),
  async (req: Request<{ parentType: ParentType; parentId: string }>, res: Response) => {
    const { parentType, parentId } = req.params;
    const check = await loadEligibleParent(parentType, parentId, req.user!.id);
    if (!check.found || !check.owned) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const existing = await Feedback.findOne({ parentType, parentId, customer: req.user!.id }).select(
      "rating comment createdAt"
    );
    res.status(200).json({
      eligible: check.eligible,
      feedback: existing
        ? { rating: existing.rating, comment: existing.comment ?? null, createdAt: existing.createdAt }
        : null,
    });
  }
);

router.post(
  "/:parentType/:parentId",
  requireAuth,
  requireRole("customer"),
  validateParams(feedbackParentTypeParamSchema),
  validateBody(feedbackBodySchema),
  async (req: Request<{ parentType: ParentType; parentId: string }>, res: Response) => {
    const { parentType, parentId } = req.params;
    const check = await loadEligibleParent(parentType, parentId, req.user!.id);
    if (!check.found || !check.owned) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!check.eligible) {
      res.status(403).json({ error: "This isn't resolved yet" });
      return;
    }
    try {
      const feedback = await Feedback.create({
        parentType,
        parentId,
        customer: req.user!.id,
        rating: req.body.rating,
        comment: req.body.comment,
      });

      await recordAuditLog({
        actor: req.user!.id,
        action: "feedback_submitted",
        targetType: "Feedback",
        targetId: feedback.id,
        metadata: { parentType, parentId, rating: feedback.rating },
        ipAddress: req.ip,
      });

      res
        .status(201)
        .json({ rating: feedback.rating, comment: feedback.comment ?? null, createdAt: feedback.createdAt });
    } catch (err) {
      // Compound unique index (parentType, parentId, customer) — a second
      // submission attempt fails cleanly rather than creating a duplicate.
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: "You've already submitted feedback for this" });
        return;
      }
      throw err;
    }
  }
);

export default router;
