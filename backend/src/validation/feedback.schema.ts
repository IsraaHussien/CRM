import { z } from "zod";

export const feedbackParentTypeParamSchema = z.object({
  parentType: z.enum(["ticket", "conversation"], { error: 'parentType must be "ticket" or "conversation"' }),
  parentId: z.string(),
});

export const feedbackBodySchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
