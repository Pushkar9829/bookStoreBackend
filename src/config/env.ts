import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const cookieSecure = process.env.COOKIE_SECURE === "true" || nodeEnv === "production";

export const env = {
  port: Number(process.env.PORT ?? 4100),
  nodeEnv,
  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/meridian"),
  jwtSecret: required("JWT_SECRET", "dev-secret"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "7d",
  clientOrigins: (process.env.CLIENT_URL ?? "http://localhost:5180")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  uploadDir: process.env.UPLOAD_DIR ?? "uploads",
  cookieSecure,
};
