import mongoose, { Document, Schema, Types } from "mongoose";

export type FeedbackParentType = "ticket" | "conversation";

/**
 * A customer's post-resolution rating (customer-portal Story 39). One row
 * per (parentType, parentId, customer) — the compound unique index below is
 * what makes a second submission attempt fail cleanly instead of creating a
 * duplicate, per this story's own acceptance criterion.
 */
export interface IFeedback extends Document {
  parentType: FeedbackParentType;
  parentId: Types.ObjectId;
  customer: Types.ObjectId;
  rating: number;
  comment?: string;
  createdAt: Date;
}

const feedbackSchema = new Schema<IFeedback>(
  {
    parentType: { type: String, enum: ["ticket", "conversation"], required: true },
    parentId: { type: Schema.Types.ObjectId, required: true },
    customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

feedbackSchema.index({ parentType: 1, parentId: 1, customer: 1 }, { unique: true });

export const Feedback = mongoose.model<IFeedback>("Feedback", feedbackSchema);
