import { Schema, model, Types } from "mongoose";

export const LEAD_SOURCES = [
  "website",
  "customer_portal",
  "phone",
  "whatsapp",
  "email",
  "sales_representative",
  "walk_in",
  "referral",
  "existing_customer",
  "campaign",
  "import",
  "other",
] as const;

export const LEAD_STATUSES = [
  "new",
  "assigned",
  "contacted",
  "follow_up",
  "interested",
  "negotiation",
  "converted",
  "lost",
  "not_interested",
] as const;

export const CUSTOMER_TYPES = [
  "individual",
  "school",
  "college",
  "institution",
  "corporate",
  "distributor",
  "retailer",
  "other",
] as const;

const leadSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", index: true },
    source: { type: String, enum: LEAD_SOURCES, default: "other", index: true },
    status: { type: String, enum: LEAD_STATUSES, default: "new", index: true },
    ownerId: { type: Types.ObjectId, ref: "User", index: true },
    name: { type: String, required: true },
    company: { type: String, default: "" },
    phone: { type: String, default: "", index: true },
    email: { type: String, default: "" },
    address: { type: String, default: "" },
    notes: { type: String, default: "" },
    followUpAt: { type: Date },
    convertedToCustomerId: { type: Types.ObjectId, ref: "Customer" },
    convertedToOrderId: { type: Types.ObjectId, ref: "Order" },
    convertedBy: { type: Types.ObjectId, ref: "User" },
    convertedAt: { type: Date },
    orderValue: { type: Number, default: 0 },
    createdBy: { type: Types.ObjectId, ref: "User" },
    updatedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

leadSchema.index({ organizationId: 1, leadStatus: 1 });
leadSchema.index({ organizationId: 1, salesUserId: 1 });

const leadActivitySchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    leadId: { type: Types.ObjectId, ref: "Lead", required: true, index: true },
    type: {
      type: String,
      enum: ["created", "assigned", "status", "note", "call", "email", "whatsapp", "follow_up", "converted", "other"],
      default: "note",
    },
    message: { type: String, required: true },
    meta: { type: Schema.Types.Mixed },
    createdBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

const customerSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", index: true },
    salesUserId: { type: Types.ObjectId, ref: "User", index: true },
    customerType: { type: String, enum: CUSTOMER_TYPES, default: "individual", index: true },
    group: { type: String, default: "default", index: true },
    name: { type: String, required: true },
    company: { type: String, default: "" },
    phone: { type: String, default: "", index: true },
    email: { type: String, default: "", lowercase: true },
    gstin: { type: String, default: "" },
    notes: { type: String, default: "" },
    totalOrderValue: { type: Number, default: 0 },
    lastOrderDate: { type: Date },
    outstanding: { type: Number, default: 0 },
    leadId: { type: Types.ObjectId, ref: "Lead" },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Types.ObjectId, ref: "User" },
    updatedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

customerSchema.index({ organizationId: 1, email: 1 });

const customerAddressSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Types.ObjectId, ref: "Customer", required: true, index: true },
    kind: { type: String, enum: ["billing", "shipping"], default: "shipping" },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    line1: { type: String, required: true },
    line2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    pincode: { type: String, default: "" },
    country: { type: String, default: "India" },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Lead = model("Lead", leadSchema);
export const LeadActivity = model("LeadActivity", leadActivitySchema);
export const Customer = model("Customer", customerSchema);
export const CustomerAddress = model("CustomerAddress", customerAddressSchema);
