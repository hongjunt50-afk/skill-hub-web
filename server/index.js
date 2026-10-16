// skill-hub-web server — skill ecosystem control panel backend.
// Zero DB; state lives in server/data/*.json. The hub itself is a junction farm
// maintained by F:\AI\docs\scripts\skill-hub\build-skill-hub.ps1; this server
// reads it and delegates online/offline changes to that script.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { apiRouter } from "./routes/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3210);

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ code: 0, msg: "ok", data: { ts: Date.now() } }));
app.use("/api", apiRouter);

// static frontend (built web/dist); absent in dev (vite dev server proxies /api)
const dist = join(__dirname, "..", "web", "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`[skill-hub-web] listening on http://localhost:${PORT}`);
});
