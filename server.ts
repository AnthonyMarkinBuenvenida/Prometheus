// App server: the entry point Google AI Studio runs (`npm run dev`, `npm start`), and the local
// dev/preview server. Serves /api/* from server/api.mjs (the only code that sees GEMINI_API_KEY),
// then the React app: Vite middleware in development, the built dist/ in production.
// On Vercel the same API handler runs as functions instead (api/*.mjs).
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--prod")) process.env.NODE_ENV = "production";
// Local secrets. Variables already set in the environment (AI Studio, Cloud Run) take precedence.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

// Imported after .env is loaded: some modules read configuration at load time.
const { handleApi } = await import("./server/api.mjs");
const { SECURITY_HEADERS } = await import("./server/securityHeaders.mjs");

const root = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable("x-powered-by");

if (production) {
  // Every page and API response. The dev server can't send these: React refresh needs inline scripts.
  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
}

app.use((req, res, next) => {
  handleApi(req, res).then((handled: boolean) => {
    if (!handled) next();
  }, next);
});

if (production) {
  const dist = path.join(root, "dist");
  app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y" }));
  app.use(express.static(dist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(path.join(dist, "index.html"));
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Prometheus ${production ? "production" : "dev"} server on http://localhost:${PORT}`);
});
