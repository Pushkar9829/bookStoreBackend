import { Schema, model, Types } from "mongoose";

export const DISPATCH_STATUSES = [
  "pending",
  "packed",
  "ready",
  "dispatched",
  "in_transit",
  "delivered",
] as const;

const dispatchItemSchema = new Schema({
  orderItemId: { type: Types.ObjectId, required: true },
  productId: { type: Types.ObjectId, ref: "Product", required: true },
  sku: String,
  name: String,
  qty: { type: Number, required: true },
  storeId: { type: Types.ObjectId, ref: "Store" },
});

const dispatchSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", required: true, index: true },
    orderId: { type: Types.ObjectId, ref: "Order", required: true, index: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true, index: true },
    status: { type: String, enum: DISPATCH_STATUSES, default: "pending", index: true },
    carrier: { type: String, default: "" },
    trackingNumber: { type: String, default: "" },
    packages: { type: String, default: "" },
    shippingAddress: { type: Schema.Types.Mixed },
    items: [dispatchItemSchema],
    dispatchedAt: { type: Date },
    deliveredAt: { type: Date },
    assignedTo: { type: Types.ObjectId, ref: "User" },
    notes: { type: String, default: "" },
    createdBy: { type: Types.ObjectId, ref: "User" },
    updatedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const Dispatch = model("Dispatch", dispatchSchema);
