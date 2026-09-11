import { Schema, model, Types } from "mongoose";

const addressSchema = new Schema(
  {
    line1: { type: String, default: "" },
    line2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    pincode: { type: String, default: "" },
    country: { type: String, default: "India" },
    lat: { type: Number },
    lng: { type: Number },
  },
  { _id: false }
);

const organizationSchema = new Schema(
  {
    name: { type: String, required: true },
    legalName: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    gstin: { type: String, default: "" },
    address: { type: addressSchema, default: () => ({}) },
    settings: {
      currency: { type: String, default: "INR" },
      timezone: { type: String, default: "Asia/Kolkata" },
      lowStockThreshold: { type: Number, default: 20 },
      performanceBasis: { type: String, enum: ["confirmed", "delivered"], default: "confirmed" },
      highValueOrderPaise: { type: Number, default: 10000000 },
    },
  },
  { timestamps: true }
);

const storeSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    address: { type: addressSchema, default: () => ({}) },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

storeSchema.index({ organizationId: 1, code: 1 }, { unique: true });

export const Organization = model("Organization", organizationSchema);
export const Store = model("Store", storeSchema);
