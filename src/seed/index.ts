import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "../config/db";
import {
  Organization,
  Store,
  Role,
  User,
  SalesTeam,
  ProductCategory,
  Product,
  Inventory,
  Customer,
  CustomerAddress,
  CustomerPrice,
  Lead,
  LeadActivity,
  Order,
  SalesTarget,
  IncentiveRule,
} from "../models";
import { ROLE_KEYS, ROLE_PERMISSIONS } from "../utils/permissions";
import { toPaise } from "../utils/money";
import { createOrderFromLines, confirmOrder } from "../services/order.service";

const PASSWORD = "Admin@123";
const CUSTOMER_PASSWORD = "Customer@123";

async function hash(p: string) {
  return bcrypt.hash(p, 10);
}

async function seed() {
  await connectDb();
  await Promise.all([
    Organization.deleteMany({}),
    Store.deleteMany({}),
    Role.deleteMany({}),
    User.deleteMany({}),
    SalesTeam.deleteMany({}),
    ProductCategory.deleteMany({}),
    Product.deleteMany({}),
    Inventory.deleteMany({}),
    Customer.deleteMany({}),
    CustomerAddress.deleteMany({}),
    CustomerPrice.deleteMany({}),
    Lead.deleteMany({}),
    LeadActivity.deleteMany({}),
    Order.deleteMany({}),
    SalesTarget.deleteMany({}),
    IncentiveRule.deleteMany({}),
  ]);

  const org = await Organization.create({
    name: "ABC Books & Supplies",
    legalName: "ABC Books & Supplies Pvt Ltd",
    email: "ops@abcbooks.example",
    phone: "+91-11-4000-1000",
    gstin: "07AABCU9603R1ZM",
    address: { line1: "Connaught Place", city: "New Delhi", state: "Delhi", pincode: "110001", country: "India" },
    settings: {
      currency: "INR",
      timezone: "Asia/Kolkata",
      lowStockThreshold: 25,
      performanceBasis: "confirmed",
      highValueOrderPaise: toPaise(200000),
    },
  });

  const storeDefs = [
    { code: "DEL", name: "Delhi Store", city: "New Delhi", state: "Delhi", pincode: "110001", phone: "+91-11-4001-1000" },
    { code: "NOI", name: "Noida Store", city: "Noida", state: "Uttar Pradesh", pincode: "201301", phone: "+91-120-4001-1000" },
    { code: "GZB", name: "Ghaziabad Store", city: "Ghaziabad", state: "Uttar Pradesh", pincode: "201001", phone: "+91-120-4002-1000" },
    { code: "LKO", name: "Lucknow Store", city: "Lucknow", state: "Uttar Pradesh", pincode: "226001", phone: "+91-522-4001-1000" },
    { code: "JAI", name: "Jaipur Store", city: "Jaipur", state: "Rajasthan", pincode: "302001", phone: "+91-141-4001-1000" },
  ];
  const stores = await Store.insertMany(
    storeDefs.map((s) => ({
      organizationId: org._id,
      code: s.code,
      name: s.name,
      phone: s.phone,
      email: `${s.code.toLowerCase()}@abcbooks.example`,
      address: { line1: `${s.name} Main Road`, city: s.city, state: s.state, pincode: s.pincode, country: "India" },
      isActive: true,
    }))
  );
  const delhi = stores[0];
  const noida = stores[1];

  const roleDocs: InstanceType<typeof Role>[] = [];
  for (const [key, perms] of Object.entries(ROLE_PERMISSIONS)) {
    const names: Record<string, string> = {
      super_admin: "Super Admin",
      store_manager: "Store Manager",
      sales_manager: "Sales Manager",
      sales_rep: "Sales Representative",
      inventory_manager: "Inventory Manager",
      dispatch_manager: "Dispatch Manager",
      customer: "Customer",
    };
    roleDocs.push(
      await Role.create({
        organizationId: org._id,
        key,
        name: names[key] || key,
        permissions: perms,
        isSystem: true,
      })
    );
  }
  const role = (key: string) => roleDocs.find((r) => r.key === key)!;
  const pwd = await hash(PASSWORD);

  const admin = await User.create({
    organizationId: org._id,
    roleId: role(ROLE_KEYS.SUPER_ADMIN)._id,
    roleKey: ROLE_KEYS.SUPER_ADMIN,
    email: "admin@meridian.local",
    passwordHash: pwd,
    name: "Asha Verma",
    phone: "9810000001",
  });
  const storeMgr = await User.create({
    organizationId: org._id,
    storeId: delhi._id,
    roleId: role(ROLE_KEYS.STORE_MANAGER)._id,
    roleKey: ROLE_KEYS.STORE_MANAGER,
    email: "store.manager@meridian.local",
    passwordHash: pwd,
    name: "Rohit Malhotra",
    phone: "9810000002",
  });
  const salesMgr = await User.create({
    organizationId: org._id,
    storeId: delhi._id,
    roleId: role(ROLE_KEYS.SALES_MANAGER)._id,
    roleKey: ROLE_KEYS.SALES_MANAGER,
    email: "sales.manager@meridian.local",
    passwordHash: pwd,
    name: "Neha Kapoor",
    phone: "9810000003",
    managerId: admin._id,
  });
  const salesRep = await User.create({
    organizationId: org._id,
    storeId: delhi._id,
    roleId: role(ROLE_KEYS.SALES_REP)._id,
    roleKey: ROLE_KEYS.SALES_REP,
    email: "sales.rep@meridian.local",
    passwordHash: pwd,
    name: "Arjun Singh",
    phone: "9810000004",
    managerId: salesMgr._id,
  });
  const invMgr = await User.create({
    organizationId: org._id,
    storeId: delhi._id,
    roleId: role(ROLE_KEYS.INVENTORY_MANAGER)._id,
    roleKey: ROLE_KEYS.INVENTORY_MANAGER,
    email: "inventory@meridian.local",
    passwordHash: pwd,
    name: "Kavita Rao",
    phone: "9810000005",
  });
  const dispMgr = await User.create({
    organizationId: org._id,
    storeId: delhi._id,
    roleId: role(ROLE_KEYS.DISPATCH_MANAGER)._id,
    roleKey: ROLE_KEYS.DISPATCH_MANAGER,
    email: "dispatch@meridian.local",
    passwordHash: pwd,
    name: "Imran Qureshi",
    phone: "9810000006",
  });

  await SalesTeam.create({
    organizationId: org._id,
    storeId: delhi._id,
    name: "Delhi Sales",
    headId: salesMgr._id,
    memberIds: [salesMgr._id, salesRep._id],
  });

  const cats = await ProductCategory.insertMany(
    ["Books", "Stationery", "Educational", "Office", "Bags"].map((name) => ({
      organizationId: org._id,
      name,
      slug: name.toLowerCase(),
    }))
  );
  const byName = (n: string) => cats.find((c) => c.name === n)!;

  const products = await Product.insertMany([
    {
      organizationId: org._id,
      sku: "BK-N10-SCI",
      name: "NCERT Science Class 10",
      categoryId: byName("Books")._id,
      productType: "book",
      isbn: "9788174506368",
      publisher: "NCERT",
      author: "NCERT",
      unit: "pcs",
      taxPercent: 0,
      defaultPrice: toPaise(500),
      status: "active",
    },
    {
      organizationId: org._id,
      sku: "BK-N10-MAT",
      name: "NCERT Mathematics Class 10",
      categoryId: byName("Books")._id,
      productType: "book",
      isbn: "9788174506344",
      publisher: "NCERT",
      author: "NCERT",
      unit: "pcs",
      taxPercent: 0,
      defaultPrice: toPaise(480),
      status: "active",
    },
    {
      organizationId: org._id,
      sku: "BK-N12-PHY",
      name: "NCERT Physics Class 12 Part 1",
      categoryId: byName("Books")._id,
      productType: "book",
      isbn: "9788174506313",
      publisher: "NCERT",
      author: "NCERT",
      unit: "pcs",
      taxPercent: 0,
      defaultPrice: toPaise(620),
      status: "active",
    },
    {
      organizationId: org._id,
      sku: "ST-PEN-BLU",
      name: "Ball Pen Blue (Box of 50)",
      categoryId: byName("Stationery")._id,
      productType: "stationery",
      unit: "box",
      taxPercent: 18,
      defaultPrice: toPaise(250),
      status: "active",
    },
    {
      organizationId: org._id,
      sku: "ST-NB-A4",
      name: "A4 Notebook 200 pages",
      categoryId: byName("Stationery")._id,
      productType: "stationery",
      unit: "pcs",
      taxPercent: 12,
      defaultPrice: toPaise(85),
      status: "active",
    },
    {
      organizationId: org._id,
      sku: "ED-KIT-PRI",
      name: "Primary Classroom Kit",
      categoryId: byName("Educational")._id,
      productType: "kit",
      unit: "kit",
      taxPercent: 5,
      defaultPrice: toPaise(3500),
      status: "active",
    },
    {
      organizationId: org._id,
      sku: "OF-A4-REAM",
      name: "A4 Copier Paper (500 sheets)",
      categoryId: byName("Office")._id,
      productType: "office",
      unit: "ream",
      taxPercent: 12,
      defaultPrice: toPaise(320),
      status: "active",
    },
    {
      organizationId: org._id,
      sku: "BG-SCH-01",
      name: "School Backpack 24L",
      categoryId: byName("Bags")._id,
      productType: "bag",
      unit: "pcs",
      taxPercent: 12,
      defaultPrice: toPaise(899),
      status: "active",
    },
  ]);

  const stockMap: Record<string, number[]> = {
    "BK-N10-SCI": [500, 250, 100, 350, 180],
    "BK-N10-MAT": [420, 200, 80, 300, 140],
    "BK-N12-PHY": [200, 90, 40, 160, 70],
    "ST-PEN-BLU": [800, 400, 200, 500, 250],
    "ST-NB-A4": [1000, 600, 300, 700, 400],
    "ED-KIT-PRI": [40, 20, 10, 25, 15],
    "OF-A4-REAM": [300, 180, 90, 220, 110],
    "BG-SCH-01": [120, 80, 40, 90, 60],
  };

  for (const p of products) {
    const qtys = stockMap[p.sku] || [50, 50, 50, 50, 50];
    for (let i = 0; i < stores.length; i++) {
      await Inventory.create({
        organizationId: org._id,
        storeId: stores[i]._id,
        productId: p._id,
        physical: qtys[i],
        reserved: 0,
        opening: qtys[i],
        lowStockThreshold: 25,
      });
    }
  }

  const school = await Customer.create({
    organizationId: org._id,
    storeId: delhi._id,
    salesUserId: salesRep._id,
    customerType: "school",
    group: "schools",
    name: "DPS Noida Procurement",
    company: "Delhi Public School Noida",
    phone: "9811111101",
    email: "customer@schoolxyz.local",
    gstin: "09AABCD1234F1Z5",
    notes: "Annual textbook contract",
  });
  await CustomerAddress.create({
    organizationId: org._id,
    customerId: school._id,
    kind: "shipping",
    name: "Stores Incharge",
    phone: "9811111101",
    line1: "DPS Campus, Sector 30",
    city: "Noida",
    state: "Uttar Pradesh",
    pincode: "201303",
    isDefault: true,
  });
  await User.create({
    organizationId: org._id,
    storeId: delhi._id,
    roleId: role(ROLE_KEYS.CUSTOMER)._id,
    roleKey: ROLE_KEYS.CUSTOMER,
    email: "customer@schoolxyz.local",
    passwordHash: await hash(CUSTOMER_PASSWORD),
    name: "DPS Noida Procurement",
    customerId: school._id,
  });

  const retailer = await Customer.create({
    organizationId: org._id,
    storeId: noida._id,
    salesUserId: salesRep._id,
    customerType: "retailer",
    group: "retail",
    name: "Mehra Book Depot",
    company: "Mehra Book Depot",
    phone: "9811111102",
    email: "mehra@retail.local",
  });

  const sci = products.find((p) => p.sku === "BK-N10-SCI")!;
  const mat = products.find((p) => p.sku === "BK-N10-MAT")!;
  const pens = products.find((p) => p.sku === "ST-PEN-BLU")!;

  await CustomerPrice.insertMany([
    {
      organizationId: org._id,
      customerId: school._id,
      productId: sci._id,
      minQty: 1,
      price: toPaise(400),
      notes: "School contract FY26",
      assignedBy: salesMgr._id,
    },
    {
      organizationId: org._id,
      customerId: school._id,
      productId: mat._id,
      minQty: 1,
      price: toPaise(390),
      notes: "School contract FY26",
      assignedBy: salesMgr._id,
    },
    {
      organizationId: org._id,
      customerId: retailer._id,
      productId: sci._id,
      minQty: 1,
      price: toPaise(450),
      notes: "Retailer slab",
      assignedBy: salesMgr._id,
    },
    {
      organizationId: org._id,
      customerGroup: "schools",
      categoryId: byName("Stationery")._id,
      minQty: 10,
      price: toPaise(220),
      notes: "School stationery slab — overridden per product when present",
      assignedBy: salesMgr._id,
    },
  ]);

  const lead1 = await Lead.create({
    organizationId: org._id,
    storeId: delhi._id,
    source: "referral",
    status: "negotiation",
    ownerId: salesRep._id,
    name: "Principal Sharma",
    company: "St. Mary's School Ghaziabad",
    phone: "9811111199",
    email: "principal@stmarys.example",
    notes: "Interested in 500 science + 500 maths",
    createdBy: salesRep._id,
  });
  await LeadActivity.create({
    organizationId: org._id,
    leadId: lead1._id,
    type: "created",
    message: "Lead created from referral",
    createdBy: salesRep._id,
  });
  await LeadActivity.create({
    organizationId: org._id,
    leadId: lead1._id,
    type: "call",
    message: "Called customer — interested in bulk NCERT order",
    createdBy: salesRep._id,
  });
  await Lead.create({
    organizationId: org._id,
    storeId: noida._id,
    source: "website",
    status: "new",
    name: "Ritu Jain",
    company: "Bright Minds Academy",
    phone: "9822222200",
    email: "ritu@brightminds.example",
    createdBy: admin._id,
  });

  const order = await createOrderFromLines({
    organizationId: org._id.toString(),
    customerId: school._id.toString(),
    salesUserId: salesRep._id.toString(),
    storeId: delhi._id.toString(),
    items: [
      { productId: sci._id.toString(), qty: 100 },
      { productId: mat._id.toString(), qty: 80 },
      { productId: pens._id.toString(), qty: 20 },
    ],
    source: "sales_team",
    createdBy: salesRep._id.toString(),
    notes: "Seed confirmed order",
  });
  await confirmOrder({
    organizationId: org._id.toString(),
    orderId: order._id.toString(),
    user: {
      id: storeMgr._id.toString(),
      organizationId: org._id.toString(),
      roleKey: "store_manager",
      permissions: [],
      name: storeMgr.name,
      email: storeMgr.email,
      roleId: storeMgr.roleId.toString(),
      typ: "staff",
    },
  });

  const now = new Date();
  await SalesTarget.create({
    organizationId: org._id,
    userId: salesRep._id,
    storeId: delhi._id,
    periodStart: new Date(now.getFullYear(), now.getMonth(), 1),
    periodEnd: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
    targetAmount: toPaise(1000000),
    targetOrders: 50,
    createdBy: salesMgr._id,
  });

  await IncentiveRule.create({
    organizationId: org._id,
    name: "Revenue slabs",
    type: "revenue_slab",
    isActive: true,
    config: {
      slabs: [
        { min: 0, max: toPaise(500000), percent: 1 },
        { min: toPaise(500000), max: toPaise(1000000), percent: 2 },
        { min: toPaise(1000000), percent: 3 },
      ],
    },
    createdBy: admin._id,
  });
  await IncentiveRule.create({
    organizationId: org._id,
    name: "100 orders bonus",
    type: "order_count",
    isActive: true,
    config: { threshold: 100, amount: toPaise(5000) },
    createdBy: admin._id,
  });
  await IncentiveRule.create({
    organizationId: org._id,
    name: "Conversion above 25%",
    type: "conversion",
    isActive: true,
    config: { minRate: 25, amount: toPaise(3000) },
    createdBy: admin._id,
  });
  await IncentiveRule.create({
    organizationId: org._id,
    name: "Target hit + exceed",
    type: "target",
    isActive: true,
    config: { onHit: toPaise(10000), onExceedPercent: 0.5 },
    createdBy: admin._id,
  });

  console.log("Seed complete.");
  console.log("Staff login:  admin@meridian.local / Admin@123");
  console.log("Store mgr:    store.manager@meridian.local / Admin@123");
  console.log("Sales mgr:    sales.manager@meridian.local / Admin@123");
  console.log("Sales rep:    sales.rep@meridian.local / Admin@123");
  console.log("Inventory:    inventory@meridian.local / Admin@123");
  console.log("Dispatch:     dispatch@meridian.local / Admin@123");
  console.log("Customer:     customer@schoolxyz.local / Customer@123");
  await disconnectDb();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
