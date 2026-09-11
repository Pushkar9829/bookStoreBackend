import multer from "multer";
import path from "path";
import fs from "fs";
import { env } from "../config/env";

const dest = path.resolve(process.cwd(), env.uploadDir);
fs.mkdirSync(path.join(dest, "products"), { recursive: true });
fs.mkdirSync(path.join(dest, "imports"), { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, file, cb) => {
    const folder = file.fieldname === "image" ? "products" : "imports";
    cb(null, path.join(dest, folder));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
});
