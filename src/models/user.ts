import { Schema, model, Types } from "mongoose";

const roleSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    permissions: [{ type: String }],
    isSystem: { type: Boolean, default: true },
  },
  { timestamps: true }
);

roleSchema.index({ organizationId: 1, key: 1 }, { unique: true });

const userSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", index: true },
    roleId: { type: Types.ObjectId, ref: "Role", required: true },
    roleKey: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    managerId: { type: Types.ObjectId, ref: "User", index: true },
    customerId: { type: Types.ObjectId, ref: "Customer", index: true },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.index({ organizationId: 1, email: 1 }, { unique: true });
userSchema.index({ salesUserId: 1 });

const salesTeamSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    storeId: { type: Types.ObjectId, ref: "Store", index: true },
    name: { type: String, required: true },
    headId: { type: Types.ObjectId, ref: "User" },
    memberIds: [{ type: Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

export const Role = model("Role", roleSchema);
export const User = model("User", userSchema);
export const SalesTeam = model("SalesTeam", salesTeamSchema);
