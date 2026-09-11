import { Schema, model, Types } from "mongoose";

const salesTargetSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", index: true },
    userId: { type: Types.ObjectId, ref: "User", index: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    targetAmount: { type: Number, required: true },
    targetOrders: { type: Number, default: 0 },
    notes: { type: String, default: "" },
    createdBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const incentiveRuleSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ["revenue_slab", "order_count", "conversion", "target"],
      required: true,
    },
    config: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const incentiveSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    ruleId: { type: Types.ObjectId, ref: "IncentiveRule" },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ["pending", "approved", "paid"], default: "pending", index: true },
    breakdown: { type: Schema.Types.Mixed },
    approvedBy: { type: Types.ObjectId, ref: "User" },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

export const SalesTarget = model("SalesTarget", salesTargetSchema);
export const IncentiveRule = model("IncentiveRule", incentiveRuleSchema);
export const Incentive = model("Incentive", incentiveSchema);
