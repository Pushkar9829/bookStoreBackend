import { Router } from "express";
import { SalesTarget, IncentiveRule, Incentive, User, Order, Lead, Store } from "../models";
import { requirePermission, orgId } from "../middleware/auth";
import { performanceForUser, calculateIncentives } from "../services/performance.service";
import { notify, writeAudit } from "../services/audit";
import { toPaise } from "../utils/money";
import { NotFoundError } from "../utils/errors";

export const salesRouter = Router();

function period(req: { query: Record<string, unknown> }) {
  const now = new Date();
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { from, to };
}

salesRouter.get("/performance", requirePermission("sales.performance"), async (req, res, next) => {
  try {
    const { from, to } = period(req);
    const userId = typeof req.query.userId === "string" ? req.query.userId : req.user!.id;
    const perf = await performanceForUser({ organizationId: orgId(req), userId, from, to });
    const incentive = await Incentive.findOne({
      organizationId: orgId(req),
      userId,
      periodStart: { $lte: to },
      periodEnd: { $gte: from },
    }).sort({ createdAt: -1 });
    res.json({ ...perf, incentive });
  } catch (e) {
    next(e);
  }
});

salesRouter.get("/performance/team", requirePermission("sales.performance"), async (req, res, next) => {
  try {
    const { from, to } = period(req);
    const q: Record<string, unknown> = {
      organizationId: orgId(req),
      roleKey: { $in: ["sales_rep", "sales_manager"] },
    };
    if (typeof req.query.storeId === "string") q.storeId = req.query.storeId;
    if (req.user!.roleKey === "sales_manager") q.managerId = req.user!.id;
    const users = await User.find(q).select("name email storeId roleKey");
    const rows = [];
    for (const u of users) {
      rows.push({
        user: u,
        ...(await performanceForUser({ organizationId: orgId(req), userId: u._id.toString(), from, to })),
      });
    }
    rows.sort((a, b) => b.totalOrderValue - a.totalOrderValue);
    res.json({ data: rows, from, to });
  } catch (e) {
    next(e);
  }
});

salesRouter.get("/targets", requirePermission("sales.targets"), async (req, res, next) => {
  try {
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.userId === "string") q.userId = req.query.userId;
    if (typeof req.query.storeId === "string") q.storeId = req.query.storeId;
    const data = await SalesTarget.find(q).populate("userId", "name").populate("storeId", "name").sort({ periodStart: -1 });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

salesRouter.post("/targets", requirePermission("sales.targets"), async (req, res, next) => {
  try {
    const t = await SalesTarget.create({
      organizationId: orgId(req),
      storeId: req.body.storeId,
      userId: req.body.userId,
      periodStart: req.body.periodStart,
      periodEnd: req.body.periodEnd,
      targetAmount: req.body.priceIsPaise ? req.body.targetAmount : toPaise(req.body.targetAmount),
      targetOrders: req.body.targetOrders || 0,
      notes: req.body.notes || "",
      createdBy: req.user!.id,
    });
    res.status(201).json(t);
  } catch (e) {
    next(e);
  }
});

salesRouter.put("/targets/:id", requirePermission("sales.targets"), async (req, res, next) => {
  try {
    const body: Record<string, unknown> = { ...req.body };
    if (body.targetAmount != null && !body.priceIsPaise) body.targetAmount = toPaise(Number(body.targetAmount));
    delete body.priceIsPaise;
    const t = await SalesTarget.findOneAndUpdate({ _id: req.params.id, organizationId: orgId(req) }, body, { new: true });
    if (!t) throw new NotFoundError("Target");
    res.json(t);
  } catch (e) {
    next(e);
  }
});

salesRouter.get("/incentive-rules", requirePermission("incentives.read"), async (req, res, next) => {
  try {
    const data = await IncentiveRule.find({ organizationId: orgId(req) }).sort({ createdAt: -1 });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

salesRouter.post("/incentive-rules", requirePermission("incentives.manage"), async (req, res, next) => {
  try {
    const rule = await IncentiveRule.create({ ...req.body, organizationId: orgId(req), createdBy: req.user!.id });
    res.status(201).json(rule);
  } catch (e) {
    next(e);
  }
});

salesRouter.put("/incentive-rules/:id", requirePermission("incentives.manage"), async (req, res, next) => {
  try {
    const rule = await IncentiveRule.findOneAndUpdate(
      { _id: req.params.id, organizationId: orgId(req) },
      req.body,
      { new: true }
    );
    res.json(rule);
  } catch (e) {
    next(e);
  }
});

salesRouter.delete("/incentive-rules/:id", requirePermission("incentives.manage"), async (req, res, next) => {
  try {
    const rule = await IncentiveRule.findOneAndDelete({ _id: req.params.id, organizationId: orgId(req) });
    if (!rule) throw new NotFoundError("Rule");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

salesRouter.delete("/targets/:id", requirePermission("sales.targets"), async (req, res, next) => {
  try {
    const t = await SalesTarget.findOneAndDelete({ _id: req.params.id, organizationId: orgId(req) });
    if (!t) throw new NotFoundError("Target");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

salesRouter.get("/incentives", requirePermission("incentives.read"), async (req, res, next) => {
  try {
    const q: Record<string, unknown> = { organizationId: orgId(req) };
    if (typeof req.query.userId === "string") q.userId = req.query.userId;
    if (typeof req.query.status === "string") q.status = req.query.status;
    const data = await Incentive.find(q).populate("userId", "name email").sort({ createdAt: -1 });
    res.json({ data });
  } catch (e) {
    next(e);
  }
});

salesRouter.post("/incentives/calculate", requirePermission("incentives.manage"), async (req, res, next) => {
  try {
    const { from, to } = period(req);
    const userId = req.body.userId as string;
    const doc = await calculateIncentives({ organizationId: orgId(req), userId, from, to });
    await notify({
      organizationId: orgId(req),
      userId,
      type: "incentive_generated",
      title: "Incentive calculated",
      body: `₹${(doc.amount / 100).toLocaleString("en-IN")}`,
      entityType: "Incentive",
      entityId: doc._id.toString(),
    });
    res.json(doc);
  } catch (e) {
    next(e);
  }
});

salesRouter.post("/incentives/:id/status", requirePermission("incentives.approve"), async (req, res, next) => {
  try {
    const inc = await Incentive.findOne({ _id: req.params.id, organizationId: orgId(req) });
    if (!inc) throw new NotFoundError("Incentive");
    inc.status = req.body.status;
    if (req.body.status === "approved") inc.approvedBy = req.user!.id as never;
    if (req.body.status === "paid") inc.paidAt = new Date();
    await inc.save();
    await writeAudit({
      user: req.user,
      organizationId: orgId(req),
      action: "incentive.status",
      entity: "Incentive",
      entityId: inc._id.toString(),
      next: { status: inc.status },
      req,
    });
    res.json(inc);
  } catch (e) {
    next(e);
  }
});

void Order;
void Lead;
void Store;
