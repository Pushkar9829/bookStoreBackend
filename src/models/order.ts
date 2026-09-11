import { Schema, model, Types } from "mongoose";

export const ORDER_STATUSES = [
  "draft",
  "submitted",
  "confirmed",
  "inventory_reserved",
  "processing",
  "ready_for_dispatch",
  "dispatched",
  "in_transit",
  "delivered",
  "cancelled",
  "partially_cancelled",
  "on_hold",
] as const;

export const ORDER_SOURCES = ["sales_team", "portal", "lead_conversion"] as const;

const addressSnapshot = new Schema(
  {
    name: String,
    phone: String,
    line1: String,
    line2: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: "India" },
  },
  { _id: false }
);

const orderItemSchema = new Schema({
  productId: { type: Types.ObjectId, ref: "Product", required: true },
  sku: { type: String, required: true },
  name: { type: String, required: true },
  qty: { type: Number, required: true },
  unitPrice: { type: Number, required: true },
  taxPercent: { type: Number, default: 0 },
  lineTotal: { type: Number, required: true },
  cancelledQty: { type: Number, default: 0 },
  dispatchedQty: { type: Number, default: 0 },
});

const statusHistorySchema = new Schema(
  {
    from: { type: String },
    to: { type: String, required: true },
    changedBy: { type: Types.ObjectId, ref: "User" },
    remarks: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const allocationSchema = new Schema({
  orderItemId: { type: Types.ObjectId, required: true },
  productId: { type: Types.ObjectId, ref: "Product", required: true },
  storeId: { type: Types.ObjectId, ref: "Store", required: true },
  qty: { type: Number, required: true },
  reserved: { type: Boolean, default: false },
});

const orderSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", index: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true, index: true },
    salesUserId: { type: Types.ObjectId, ref: "User", index: true },
    leadId: { type: Types.ObjectId, ref: "Lead", index: true },
    source: { type: String, enum: ORDER_SOURCES, default: "sales_team" },
    status: { type: String, enum: ORDER_STATUSES, default: "draft", index: true },
    items: [orderItemSchema],
    allocations: [allocationSchema],
    statusHistory: [statusHistorySchema],
    totalQty: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    shippingAddress: { type: addressSnapshot },
    billingAddress: { type: addressSnapshot },
    notes: { type: String, default: "" },
    placedAt: { type: Date },
    confirmedAt: { type: Date },
    createdBy: { type: Types.ObjectId, ref: "User" },
    updatedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

orderSchema.index({ organizationId: 1, createdAt: -1 });
orderSchema.index({ organizationId: 1, orderStatus: 1 });

const cartItemSchema = new Schema(
  {
    productId: { type: Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const cartSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true, unique: true },
    items: [cartItemSchema],
  },
  { timestamps: true }
);

export const Order = model("Order", orderSchema);
export const Cart = model("Cart", cartSchema);
