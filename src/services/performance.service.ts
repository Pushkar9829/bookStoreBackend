import { Lead, Order, SalesTarget, IncentiveRule, Incentive, User } from "../models";
import { Types } from "mongoose";
import { Organization } from "../models";

export async function performanceForUser(opts: {
  organizationId: string;
  userId: string;
  from: Date;
  to: Date;
}) {
  const org = await Organization.findById(opts.organizationId);
  const basis = org?.settings?.performanceBasis === "delivered" ? "delivered" : "confirmed";
  const statusMatch =
    basis === "delivered"
      ? { status: "delivered" }
      : { status: { $in: ["confirmed", "inventory_reserved", "processing", "ready_for_dispatch", "dispatched", "in_transit", "delivered"] } };

  const oid = new Types.ObjectId(opts.userId);
  const orgOid = new Types.ObjectId(opts.organizationId);

  const [leadStats] = await Lead.aggregate([
    { $match: { organizationId: orgOid, ownerId: oid, createdAt: { $gte: opts.from, $lte: opts.to } } },
    {
      $group: {
        _id: null,
        assigned: { $sum: 1 },
        converted: { $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] } },
        contacted: {
          $sum: {
            $cond: [{ $in: ["$status", ["contacted", "follow_up", "interested", "negotiation", "converted"]] }, 1, 0],
          },
        },
      },
    },
  ]);

  const [orderStats] = await Order.aggregate([
    {
      $match: {
        organizationId: orgOid,
        salesUserId: oid,
        createdAt: { $gte: opts.from, $lte: opts.to },
        ...statusMatch,
      },
    },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        totalValue: { $sum: "$grandTotal" },
        customers: { $addToSet: "$customerId" },
      },
    },
  ]);

  const assigned = leadStats?.assigned || 0;
  const converted = leadStats?.converted || 0;
  const orders = orderStats?.orders || 0;
  const totalValue = orderStats?.totalValue || 0;
  const customersAcquired = orderStats?.customers?.length || 0;

  const target = await SalesTarget.findOne({
    organizationId: opts.organizationId,
    userId: opts.userId,
    periodStart: { $lte: opts.to },
    periodEnd: { $gte: opts.from },
  }).sort({ periodStart: -1 });

  const targetAmount = target?.targetAmount || 0;
  const achievement = targetAmount ? Math.round((totalValue / targetAmount) * 1000) / 10 : 0;

  return {
    userId: opts.userId,
    from: opts.from,
    to: opts.to,
    leadsAssigned: assigned,
    leadsContacted: leadStats?.contacted || 0,
    leadsConverted: converted,
    conversionRate: assigned ? Math.round((converted / assigned) * 1000) / 10 : 0,
    orders,
    totalOrderValue: totalValue,
    averageOrderValue: orders ? Math.round(totalValue / orders) : 0,
    customersAcquired,
    targetAmount,
    achievement,
  };
}

export async function calculateIncentives(opts: {
  organizationId: string;
  userId: string;
  from: Date;
  to: Date;
}) {
  const perf = await performanceForUser(opts);
  const rules = await IncentiveRule.find({ organizationId: opts.organizationId, isActive: true });
  const breakdown: { rule: string; type: string; amount: number; detail?: unknown }[] = [];
  let total = 0;

  for (const rule of rules) {
    const cfg = (rule.config || {}) as Record<string, unknown>;
    let amount = 0;
    if (rule.type === "revenue_slab") {
      const slabs = (cfg.slabs as { min: number; max?: number; percent: number }[]) || [];
      const revenue = perf.totalOrderValue;
      const slab = [...slabs].reverse().find((s) => revenue >= s.min && (s.max == null || revenue < s.max)) || slabs.find((s) => revenue >= s.min);
      if (slab) amount = Math.round((revenue * slab.percent) / 100);
      breakdown.push({ rule: rule.name, type: rule.type, amount, detail: slab });
    } else if (rule.type === "order_count") {
      const threshold = Number(cfg.threshold || 0);
      const bonus = Number(cfg.amount || 0);
      if (perf.orders >= threshold) amount = bonus;
      breakdown.push({ rule: rule.name, type: rule.type, amount });
    } else if (rule.type === "conversion") {
      const minRate = Number(cfg.minRate || 0);
      const bonus = Number(cfg.amount || 0);
      if (perf.conversionRate >= minRate) amount = bonus;
      breakdown.push({ rule: rule.name, type: rule.type, amount });
    } else if (rule.type === "target") {
      const onHit = Number(cfg.onHit || 0);
      const onExceedPercent = Number(cfg.onExceedPercent || 0);
      if (perf.achievement >= 100) amount += onHit;
      if (perf.achievement > 100 && perf.targetAmount) {
        const extra = perf.totalOrderValue - perf.targetAmount;
        amount += Math.round((extra * onExceedPercent) / 100);
      }
      breakdown.push({ rule: rule.name, type: rule.type, amount });
    }
    total += amount;
  }

  const doc = await Incentive.findOneAndUpdate(
    {
      organizationId: opts.organizationId,
      userId: opts.userId,
      periodStart: opts.from,
      periodEnd: opts.to,
    },
    {
      organizationId: opts.organizationId,
      userId: opts.userId,
      periodStart: opts.from,
      periodEnd: opts.to,
      amount: total,
      status: "pending",
      breakdown: { performance: perf, items: breakdown },
    },
    { upsert: true, new: true }
  );
  return doc;
}

void User;
