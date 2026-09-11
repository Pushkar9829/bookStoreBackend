import { Schema, model, Types } from "mongoose";

const inventorySchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", required: true, index: true },
    productId: { type: Types.ObjectId, ref: "Product", required: true, index: true },
    physical: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    damaged: { type: Number, default: 0 },
    inTransit: { type: Number, default: 0 },
    dispatched: { type: Number, default: 0 },
    opening: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 20 },
  },
  { timestamps: true }
);

inventorySchema.index({ storeId: 1, productId: 1 }, { unique: true });
inventorySchema.index({ organizationId: 1, productId: 1 });

inventorySchema.virtual("available").get(function () {
  return (this.physical || 0) - (this.reserved || 0);
});

inventorySchema.set("toJSON", { virtuals: true });
inventorySchema.set("toObject", { virtuals: true });

const inventoryTransactionSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", required: true, index: true },
    productId: { type: Types.ObjectId, ref: "Product", required: true, index: true },
    type: {
      type: String,
      enum: [
        "in",
        "out",
        "adjust",
        "reserve",
        "release",
        "dispatch",
        "transfer_out",
        "transfer_in",
        "damage",
      ],
      required: true,
    },
    qty: { type: Number, required: true },
    refType: { type: String, default: "" },
    refId: { type: Types.ObjectId },
    notes: { type: String, default: "" },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    createdBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

inventoryTransactionSchema.index({ organizationId: 1, createdAt: -1 });

const stockTransferItemSchema = new Schema(
  {
    productId: { type: Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true },
  },
  { _id: false }
);

const stockTransferSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    fromStoreId: { type: Types.ObjectId, ref: "Store", required: true, index: true },
    toStoreId: { type: Types.ObjectId, ref: "Store", required: true, index: true },
    items: [stockTransferItemSchema],
    status: { type: String, enum: ["pending", "in_transit", "received", "cancelled"], default: "pending" },
    notes: { type: String, default: "" },
    createdBy: { type: Types.ObjectId, ref: "User" },
    receivedBy: { type: Types.ObjectId, ref: "User" },
    receivedAt: { type: Date },
  },
  { timestamps: true }
);

export const Inventory = model("Inventory", inventorySchema);
export const InventoryTransaction = model("InventoryTransaction", inventoryTransactionSchema);
export const StockTransfer = model("StockTransfer", stockTransferSchema);
