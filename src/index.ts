import { createApp } from "./app";
import { connectDb } from "./config/db";
import { env } from "./config/env";

async function main() {
  await connectDb();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`Meridian API listening on http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
