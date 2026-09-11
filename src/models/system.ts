import { Schema, model, Types } from "mongoose";

const notificationSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", index: true },
    customerId: { type: Types.ObjectId, ref: "Customer", index: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
    entityType: { type: String, default: "" },
    entityId: { type: Types.ObjectId },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

const auditLogSchema = new Schema(
  {
    organizationId: { type: Types.ObjectId, ref: "Organization", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", index: true },
    action: { type: String, required: true, index: true },
    entity: { type: String, required: true, index: true },
    entityId: { type: String, index: true },
    previous: { type: Schema.Types.Mixed },
    next: { type: Schema.Types.Mixed },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

auditLogSchema.index({ organizationId: 1, createdAt: -1 });

export const Notification = model("Notification", notificationSchema);
export const AuditLog = model("AuditLog", auditLogSchema);
