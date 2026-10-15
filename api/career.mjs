// Vercel function for /api/career — all logic lives in server/api.mjs (shared with server.ts).
import { handleApi } from "../server/api.mjs";

export default async function handler(req, res) {
  await handleApi(req, res);
}
