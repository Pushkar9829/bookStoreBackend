import { connectDb, disconnectDb } from "../config/db";
import { Organization, Store, Product, Customer, Order, Inventory, User, CustomerPrice, Lead } from "../models";

async function main() {
  await connectDb();
  const org = await Organization.findOne();
  const stores = await Store.countDocuments();
  const products = await Product.countDocuments();
  const customers = await Customer.countDocuments();
  const orders = await Order.find();
  const users = await User.countDocuments();
  const inv = await Inventory.countDocuments();
  const reserved = await Inventory.aggregate([{ $group: { _id: null, r: { $sum: "$reserved" } } }]);
  const prices = await CustomerPrice.countDocuments();
  const leads = await Lead.countDocuments();
  console.log(
    JSON.stringify(
      {
        org: org?.name,
        stores,
        products,
        customers,
        users,
        inv,
        prices,
        leads,
        orders: orders.length,
        orderStatus: orders[0]?.status,
        reserved: reserved[0]?.r || 0,
      },
      null,
      2
    )
  );
  await disconnectDb();
}

main();
