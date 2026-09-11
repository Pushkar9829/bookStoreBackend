import { Router } from "express";
import { z } from "zod";
import {
  Lead,
  LeadActivity,
  Customer,
  CustomerAddress,
  CustomerPrice,
  User,
} from "../models";
import { LEAD_SOURCES, LEAD_STATUSES, CUSTOMER_TYPES } from "../models/crm";
import { requirePermission, orgId } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { upload } from "../middleware/upload";
import { parsePagination, paged, sortObject } from "../utils/pagination";
import { AppError, NotFoundError } from "../utils/errors";
import { parseSpreadsheet } from "../utils/spreadsheet";
import { writeAudit, notify } from "../services/audit";
import { teamUserIds } from "../utils/scope";
import { toPaise } from "../utils/money";
import { hashPassword } from "../services/auth.service";
import { Role } from "../models";
import { createOrderFromLines } from "../services/order.service";

export const crmRouter = Router();

async function leadQuery(req: Parameters<typeof orgId>[0]) {
  const q: Record<string, unknown> = { organizationId: orgId(req) };
  if (typeof req.query.storeId === "string" && req.query.storeId) q.storeId = req.query.storeId;
  else if (req.user!.roleKey !== "super_admin" && req.user!.storeId) q.storeId = req.user!.storeId;
  const ids = await teamUserIds(req.user!);
  if (ids) q.ownerId = { $in: ids };
  if (typeof req.query.status === "string") q.status = req.query.status;
  if (typeof req.query.source === "string") q.source = req.query.source;
  if (typeof req.query.ownerId === "string") q.ownerId = req.query.ownerId;
  return q;
}

crmRouter.get("/leads", requirePermission("leads.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search, sort } = parsePagination(req);
    const q = await leadQuery(req);
    if (search) {
      (q as { $or?: unknown }).$or = [
        { name: new RegExp(search, "i") },
        { company: new RegExp(search, "i") },
        { phone: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
      ];
    }
    const [data, total] = await Promise.all([
      Lead.find(q)
        .populate("ownerId", "name email")
        .populate("storeId", "name code")
        .sort(sortObject(sort))
        .skip(skip)
        .limit(pageSize),
      Lead.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

const leadSchema = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  storeId: z.string().optional(),
  ownerId: z.string().optional(),
  followUpAt: z.string().optional(),
});

async function addActivity(
  organizationId: string,
  leadId: string,
  type: string,
  message: string,
  createdBy?: string,
  meta?: unknown
) {
  await LeadActivity.create({ organizationId, leadId, type, message, createdBy, meta });
}

crmRouter.post("/leads", requirePermission("leads.manage"), validate(leadSchema), async (req, res, next) => {
  try {
    const ownerId = req.body.ownerId || (req.user!.roleKey === "sales_rep" ? req.user!.id : undefined);
    const lead = await Lead.create({
      organizationId: orgId(req),
      storeId: req.body.storeId || req.user!.storeId,
      source: req.body.source || "sales_representative",
      status: ownerId ? "assigned" : "new",
      ownerId,
      name: req.body.name,
      company: req.body.company || "",
      phone: req.body.phone || "",
      email: req.body.email || "",
      address: req.body.address || "",
      notes: req.body.notes || "",
      followUpAt: req.body.followUpAt,
      createdBy: req.user!.id,
    });
    await addActivity(orgId(req), lead._id.toString(), "created", `Lead created (${lead.source})`, req.user!.id);
    if (ownerId) {
      await addActivity(orgId(req), lead._id.toString(), "assigned", "Lead assigned", req.user!.id);
      await notify({
        organizationId: orgId(req),
        userId: ownerId,
        type: "lead_assigned",
        title: "New lead assigned",
        body: lead.name,
        entityType: "Lead",
        entityId: lead._id.toString(),
      });
    }
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "lead.create",
      entity: "Lead",
      entityId: lead._id.toString(),
      next: lead.toObject(),
      req,
    });
    res.status(201).json(lead);
  } catch (e) {
    next(e);
  }
});

crmRouter.get("/leads/:id", requirePermission("leads.read"), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, organizationId: orgId(req) })
      .populate("ownerId", "name email")
      .populate("storeId", "name")
      .populate("convertedToCustomerId")
      .populate("convertedToOrderId");
    if (!lead) throw new NotFoundError("Lead");
    const activities = await LeadActivity.find({ leadId: lead._id }).populate("createdBy", "name").sort({ createdAt: 1 });
    res.json({ ...lead.toObject(), activities });
  } catch (e) {
    next(e);
  }
});

crmRouter.put("/leads/:id", requirePermission("leads.manage"), async (req, res, next) => {
  try {
    const prev = await Lead.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!prev) throw new NotFoundError("Lead");
    if (req.body.status && req.body.status !== prev.status) {
      if (!LEAD_STATUSES.includes(req.body.status)) throw new AppError("Invalid status");
      await addActivity(
        orgId(req),
        prev._id.toString(),
        "status",
        `Status ${prev.status} → ${req.body.status}`,
        req.user!.id,
        { from: prev.status, to: req.body.status }
      );
    }
    const lead = await Lead.findByIdAndUpdate(prev._id, { ...req.body, updatedBy: req.user!.id }, { new: true });
    res.json(lead);
  } catch (e) {
    next(e);
  }
});

crmRouter.post("/leads/:id/assign", requirePermission("leads.assign"), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!lead) throw new NotFoundError("Lead");
    lead.ownerId = req.body.ownerId;
    if (lead.status === "new") lead.status = "assigned";
    await lead.save();
    await addActivity(orgId(req), lead._id.toString(), "assigned", `Assigned to ${req.body.ownerId}`, req.user!.id);
    await notify({
      organizationId: orgId(req),
      userId: req.body.ownerId,
      type: "lead_assigned",
      title: "Lead assigned",
      body: lead.name,
      entityType: "Lead",
      entityId: lead._id.toString(),
    });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "lead.assign",
      entity: "Lead",
      entityId: lead._id.toString(),
      next: { ownerId: req.body.ownerId },
      req,
    });
    res.json(lead);
  } catch (e) {
    next(e);
  }
});

crmRouter.post("/leads/:id/activities", requirePermission("leads.manage"), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!lead) throw new NotFoundError("Lead");
    const activity = await LeadActivity.create({
      organizationId: orgId(req),
      leadId: lead._id,
      type: req.body.type || "note",
      message: req.body.message,
      createdBy: req.user!.id,
    });
    if (req.body.followUpAt) {
      lead.followUpAt = new Date(req.body.followUpAt);
      if (lead.status === "contacted" || lead.status === "assigned") lead.status = "follow_up";
      await lead.save();
    }
    res.status(201).json(activity);
  } catch (e) {
    next(e);
  }
});

crmRouter.post("/leads/import", requirePermission("leads.import"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError("File required");
    const rows = parseSpreadsheet(req.file.path);
    const created = [];
    for (const row of rows) {
      const name = row.name || row.customer || row.contact;
      if (!name) continue;
      const lead = await Lead.create({
        organizationId: orgId(req),
        storeId: req.body.storeId || req.user!.storeId,
        source: "import",
        status: "new",
        ownerId: req.user!.roleKey === "sales_rep" ? req.user!.id : undefined,
        name,
        company: row.company || "",
        phone: row.phone || row.mobile || "",
        email: row.email || "",
        address: row.address || "",
        notes: row.notes || "",
        createdBy: req.user!.id,
      });
      await addActivity(orgId(req), lead._id.toString(), "created", "Imported from spreadsheet", req.user!.id);
      created.push(lead);
    }
    res.status(201).json({ imported: created.length, data: created });
  } catch (e) {
    next(e);
  }
});

crmRouter.post("/leads/:id/convert", requirePermission("leads.convert"), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!lead) throw new NotFoundError("Lead");
    if (lead.status === "converted") throw new AppError("Lead already converted");
    const mode: "customer" | "order" | "both" = req.body.mode || "customer";

    let customer = lead.convertedToCustomerId
      ? await Customer.findById(lead.convertedToCustomerId)
      : await Customer.findOne({ organizationId: orgId(req), email: lead.email, phone: lead.phone });

    if (!customer) {
      customer = await Customer.create({
        organizationId: orgId(req),
        storeId: lead.storeId || req.user!.storeId,
        salesUserId: lead.ownerId || req.user!.id,
        customerType: req.body.customerType || "individual",
        name: lead.name,
        company: lead.company,
        phone: lead.phone,
        email: lead.email?.toLowerCase() || "",
        notes: lead.notes,
        leadId: lead._id,
        createdBy: req.user!.id,
      });
      if (lead.address) {
        await CustomerAddress.create({
          organizationId: orgId(req),
          customerId: customer._id,
          kind: "shipping",
          name: lead.name,
          phone: lead.phone,
          line1: lead.address,
          isDefault: true,
        });
      }
    }

    let order = null;
    if (mode === "order" || mode === "both") {
      const lines = (req.body.items || []) as { productId: string; qty: number }[];
      if (!lines.length) throw new AppError("Items required to create order");
      order = await createOrderFromLines({
        organizationId: orgId(req),
        customerId: customer._id.toString(),
        salesUserId: (lead.ownerId || req.user!.id).toString(),
        leadId: lead._id.toString(),
        storeId: (lead.storeId || req.user!.storeId)?.toString(),
        items: lines,
        source: "lead_conversion",
        createdBy: req.user!.id,
        notes: req.body.notes,
      });
    }

    lead.status = "converted";
    lead.set("convertedToCustomerId", customer._id);
    if (order) lead.set("convertedToOrderId", order._id);
    lead.set("convertedBy", req.user!.id);
    lead.convertedAt = new Date();
    lead.orderValue = order?.grandTotal || 0;
    await lead.save();
    await addActivity(orgId(req), lead._id.toString(), "converted", `Converted (${mode})`, req.user!.id);
    await notify({
      organizationId: orgId(req),
      userId: lead.ownerId?.toString(),
      type: "lead_converted",
      title: "Lead converted",
      body: lead.name,
      entityType: "Lead",
      entityId: lead._id.toString(),
    });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "lead.convert",
      entity: "Lead",
      entityId: lead._id.toString(),
      next: { customerId: customer._id, orderId: order?._id },
      req,
    });
    res.json({ lead, customer, order });
  } catch (e) {
    next(e);
  }
});

crmRouter.get("/customers", requirePermission("customers.read"), async (req, res, next) => {
  try {
    const { page, pageSize, skip, search, sort } = parsePagination(req);
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.storeId === "string" && req.query.storeId) q.storeId = req.query.storeId;
    else if (req.user!.roleKey !== "super_admin" && req.user!.storeId) q.storeId = req.user!.storeId;
    const ids = await teamUserIds(req.user!);
    if (ids) q.salesUserId = { $in: ids };
    if (typeof req.query.customerType === "string") q.customerType = req.query.customerType;
    if (search) {
      q.$or = [
        { name: new RegExp(search, "i") },
        { company: new RegExp(search, "i") },
        { phone: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
      ];
    }
    const [data, total] = await Promise.all([
      Customer.find(q)
        .populate("storeId", "name code")
        .populate("salesUserId", "name")
        .sort(sortObject(sort))
        .skip(skip)
        .limit(pageSize),
      Customer.countDocuments(q),
    ]);
    res.json(paged(data, total, page, pageSize));
  } catch (e) {
    next(e);
  }
});

const customerSchema = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  gstin: z.string().optional(),
  notes: z.string().optional(),
  storeId: z.string().optional(),
  salesUserId: z.string().optional(),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  group: z.string().optional(),
  createPortalUser: z.boolean().optional(),
  portalPassword: z.string().optional(),
});

crmRouter.post("/customers", requirePermission("customers.manage"), validate(customerSchema), async (req, res, next) => {
  try {
    const customer = await Customer.create({
      organizationId: orgId(req),
      storeId: req.body.storeId || req.user!.storeId,
      salesUserId: req.body.salesUserId || req.user!.id,
      customerType: req.body.customerType || "individual",
      group: req.body.group || "default",
      name: req.body.name,
      company: req.body.company || "",
      phone: req.body.phone || "",
      email: (req.body.email || "").toLowerCase(),
      gstin: req.body.gstin || "",
      notes: req.body.notes || "",
      createdBy: req.user!.id,
    });
    if (req.body.createPortalUser && req.body.email) {
      const role = await Role.findOne({ organizationId: orgId(req), key: "customer" });
      if (role) {
        await User.create({
          organizationId: orgId(req),
          storeId: customer.storeId,
          roleId: role._id,
          roleKey: "customer",
          email: req.body.email.toLowerCase(),
          name: customer.name,
          phone: customer.phone,
          passwordHash: await hashPassword(req.body.portalPassword || "Customer@123"),
          customerId: customer._id,
        });
      }
    }
    res.status(201).json(customer);
  } catch (e) {
    next(e);
  }
});

crmRouter.get("/customers/:id", requirePermission("customers.read"), async (req, res, next) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, organizationId: orgId(req) })
      .populate("storeId")
      .populate("salesUserId", "name email");
    if (!customer) throw new NotFoundError("Customer");
    const addresses = await CustomerAddress.find({ customerId: customer._id });
    const prices = await CustomerPrice.find({ customerId: customer._id }).populate("productId", "name sku");
    res.json({ ...customer.toObject(), addresses, prices });
  } catch (e) {
    next(e);
  }
});

crmRouter.put("/customers/:id", requirePermission("customers.manage"), async (req, res, next) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      { ...req.body, updatedBy: req.user!.id },
      { new: true }
    );
    if (!customer) throw new NotFoundError("Customer");
    res.json(customer);
  } catch (e) {
    next(e);
  }
});

crmRouter.post("/customers/:id/addresses", requirePermission("customers.manage"), async (req, res, next) => {
  try {
    const addr = await CustomerAddress.create({
      organizationId: orgId(req),
      customerId: req.params.id,
      ...req.body,
    });
    res.status(201).json(addr);
  } catch (e) {
    next(e);
  }
});

crmRouter.get("/pricing", requirePermission("pricing.read"), async (req, res, next) => {
  try {
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.customerId === "string") q.customerId = req.query.customerId;
    if (typeof req.query.productId === "string") q.productId = req.query.productId;
    const data = await CustomerPrice.find(q)
      .populate("customerId", "name company")
      .populate("productId", "name sku defaultPrice")
      .populate("categoryId", "name")
      .populate("assignedBy", "name")
      .sort({ updatedAt: -1 })
      .limit(200);
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

crmRouter.post("/pricing", requirePermission("pricing.manage"), async (req, res, next) => {
  try {
    const price = await CustomerPrice.create({
      organizationId: orgId(req),
      customerId: req.body.customerId,
      customerGroup: req.body.customerGroup,
      productId: req.body.productId,
      categoryId: req.body.categoryId,
      storeId: req.body.storeId,
      minQty: req.body.minQty || 1,
      price: req.body.priceIsPaise ? req.body.price : toPaise(req.body.price),
      effectiveFrom: req.body.effectiveFrom || new Date(),
      effectiveTo: req.body.effectiveTo,
      notes: req.body.notes || "",
      assignedBy: req.user!.id,
      createdBy: req.user!.id,
    });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "price.assign",
      entity: "CustomerPrice",
      entityId: price._id.toString(),
      next: price.toObject(),
      req,
    });
    res.status(201).json(price);
  } catch (e) {
    next(e);
  }
});

crmRouter.put("/pricing/:id", requirePermission("pricing.manage"), async (req, res, next) => {
  try {
    const updates = { ...req.body, updatedBy: req.user!.id };
    if (typeof updates.price === "number" && !updates.priceIsPaise) updates.price = toPaise(updates.price);
    delete updates.priceIsPaise;
    const prev = await CustomerPrice.findOne({ _id: req.params.id, organizationId: orgId(req) });
    const price = await CustomerPrice.findByIdAndUpdate(req.params.id, updates, { new: true });
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "price.change",
      entity: "CustomerPrice",
      entityId: req.params.id,
      previous: prev?.toObject(),
      next: updates,
      req,
    });
    res.json(price);
  } catch (e) {
    next(e);
  }
});

crmRouter.get("/meta", (_req, res) => {
  res.json({ leadSources: LEAD_SOURCES, leadStatuses: LEAD_STATUSES, customerTypes: CUSTOMER_TYPES });
});

crmRouter.delete("/leads/:id", requirePermission("leads.manage"), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!lead) throw new NotFoundError("Lead");
    if (lead.status === "converted") throw new AppError("Cannot delete a converted lead");
    await LeadActivity.deleteMany({ leadId: lead._id });
    await lead.deleteOne();
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "lead.delete",
      entity: "Lead",
      entityId: req.params.id,
      req,
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

crmRouter.delete("/customers/:id", requirePermission("customers.manage"), async (req, res, next) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      { isActive: false },
      { new: true }
    );
    if (!customer) throw new NotFoundError("Customer");
    res.json(customer);
  } catch (e) {
    next(e);
  }
});

crmRouter.delete("/pricing/:id", requirePermission("pricing.manage"), async (req, res, next) => {
  try {
    const price = await CustomerPrice.findOneAndDelete({ _id: req.params.id, organizationId: orgId(req) });
    if (!price) throw new NotFoundError("Price");
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "price.delete",
      entity: "CustomerPrice",
      entityId: req.params.id,
      req,
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

void User;
