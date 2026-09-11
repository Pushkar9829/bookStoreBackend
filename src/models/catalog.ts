import { Schema, model, Types } from "mongoose";

const categorySchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    parentId: { type: Types.ObjectId, ref: "ProductCategory" },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

categorySchema.index({ organizationId: 1, slug: 1 }, { unique: true });

const productSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    sku: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true },
    categoryId: { type: Types.ObjectId, ref: "ProductCategory", index: true },
    productType: { type: String, default: "general" },
    description: { type: String, default: "" },
    isbn: { type: String, default: "" },
    publisher: { type: String, default: "" },
    author: { type: String, default: "" },
    unit: { type: String, default: "pcs" },
    images: [{ type: String }],
    taxPercent: { type: Number, default: 0 },
    defaultPrice: { type: Number, required: true },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    trackInventory: { type: Boolean, default: true },
    createdBy: { type: Types.ObjectId, ref: "User" },
    updatedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

productSchema.index({ organizationId: 1, sku: 1 }, { unique: true });
productSchema.index({ organizationId: 1, name: 1 });

const customerPriceSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    customerId: { type: Types.ObjectId, ref: "Customer", index: true },
    customerGroup: { type: String, index: true },
    productId: { type: Types.ObjectId, ref: "Product", index: true },
    categoryId: { type: Types.ObjectId, ref: "ProductCategory", index: true },
    storeId: { type: Types.ObjectId, ref: "Store", index: true },
    minQty: { type: Number, default: 1 },
    price: { type: Number, required: true },
    effectiveFrom: { type: Date, default: Date.now },
    effectiveTo: { type: Date },
    notes: { type: String, default: "" },
    assignedBy: { type: Types.ObjectId, ref: "User" },
    createdBy: { type: Types.ObjectId, ref: "User" },
    updatedBy: { type: Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

customerPriceSchema.index({ organizationId: 1, customerId: 1, productId: 1 });

export const ProductCategory = model("ProductCategory", categorySchema);
export const Product = model("Product", productSchema);
export const CustomerPrice = model("CustomerPrice", customerPriceSchema);
