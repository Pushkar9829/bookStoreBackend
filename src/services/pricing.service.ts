import { Customer, CustomerPrice, Product } from "../models";
import { AppError, NotFoundError } from "../utils/errors";

type ResolveInput = {
  organizationId: string;
  customerId: string;
  productId: string;
  storeId?: string;
  qty?: number;
};

function inWindow(rule: { effectiveFrom?: Date | null; effectiveTo?: Date | null }, now: Date) {
  if (rule.effectiveFrom && rule.effectiveFrom > now) return false;
  if (rule.effectiveTo && rule.effectiveTo < now) return false;
  return true;
}

/** Specificity: customer+product > customer+category > group+product > group+category > default */
export async function resolvePrice(input: ResolveInput): Promise<{
  unitPrice: number;
  source: string;
  taxPercent: number;
  product: InstanceType<typeof Product>;
}> {
  const product = await Product.findOne({
    _id: input.productId,
    organizationId: input.organizationId,
    status: "active",
  });
  if (!product) throw new NotFoundError("Product");

  const customer = await Customer.findOne({
    _id: input.customerId,
    organizationId: input.organizationId,
  });
  if (!customer) throw new NotFoundError("Customer");

  const qty = input.qty ?? 1;
  const now = new Date();
  const rules = await CustomerPrice.find({
    organizationId: input.organizationId,
    minQty: { $lte: qty },
    $or: [{ productId: product._id }, { categoryId: product.categoryId }, { productId: { $exists: false } }],
  }).sort({ minQty: -1 });

  const eligible = rules.filter((r) => inWindow(r, now));

  const score = (r: (typeof eligible)[0]) => {
    let s = 0;
    if (r.customerId && r.customerId.toString() === customer._id.toString()) s += 80;
    else if (r.customerGroup && r.customerGroup === customer.group) s += 40;
    else if (r.customerId || r.customerGroup) return -1;
    if (r.productId && r.productId.toString() === product._id.toString()) s += 20;
    else if (r.categoryId && product.categoryId && r.categoryId.toString() === product.categoryId.toString()) s += 10;
    else if (r.productId || r.categoryId) return -1;
    if (r.storeId) {
      if (input.storeId && r.storeId.toString() === input.storeId) s += 5;
      else return -1;
    }
    s += Math.min(r.minQty, 9);
    return s;
  };

  let best: (typeof eligible)[0] | undefined;
  let bestScore = -1;
  for (const r of eligible) {
    const s = score(r);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }

  if (best) {
    return { unitPrice: best.price, source: "customer_price", taxPercent: product.taxPercent, product };
  }
  return { unitPrice: product.defaultPrice, source: "default", taxPercent: product.taxPercent, product };
}

export async function resolveMany(
  organizationId: string,
  customerId: string,
  lines: { productId: string; qty: number }[],
  storeId?: string
) {
  const out = [];
  for (const line of lines) {
    const r = await resolvePrice({
      organizationId,
      customerId,
      productId: line.productId,
      storeId,
      qty: line.qty,
    });
    out.push({ ...line, ...r });
  }
  return out;
}

export function assertOwnCustomer(customerId: string, authCustomerId?: string) {
  if (authCustomerId && authCustomerId !== customerId) {
    throw new AppError("Cannot access another customer's pricing", 403, "PRICE_PRIVACY");
  }
}
