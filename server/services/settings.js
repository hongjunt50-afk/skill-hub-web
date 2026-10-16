// Runtime settings: single source of truth for all environment-specific paths
// and LLM credentials. Priority (highest wins):
//   1. server/data/settings.json (editable from the web UI)
//   2. server/.env (LLM_* keys; convenient for headless setup)
//   3. built-in defaults (works on any machine with zero config — the app
//      degrades gracefully: hub falls back to ~/.skill-hub-web/hub, the
//      build-script integration simply stays disabled if the file is absent)

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "..", "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const ENV_FILE = join(__dirname, "..", ".env");

const DEFAULTS = {
  // skill roots
  hubPath: join(homedir(), ".skill-hub-web", "hub"),
  agentsDir: join(homedir(), ".agents", "skills"),
  zcodeSkills: "",
  codexSkills: join(homedir(), ".codex", "skills"),
  // build-script integration (this machine's junction pipeline); empty = disabled
  buildScript: "",
  genCatalog: "",
  routerVerify: "",
  skillPlanPath: "",
  countsPath: "",
  // LLM
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "",
  // extra source labels: [[pathPrefix, label], ...]
  sourceLabels: [],
  // optional corpus for the agent rule engine
  routerConflictsPath: "",
  genCatalog: ""
};

let cached = null;

function parseEnv(text) {
  const out = {};
  for (const m of String(text || "").matchAll(/^(LLM_[A-Z_]+)=(.*)$/gm)) out[m[1]] = m[2].trim();
  return out;
}

export async function getSettings() {
  if (cached) return cached;
  const s = { ...DEFAULTS };
  // layer 2: .env
  try {
    const env = parseEnv(await readFile(ENV_FILE, "utf8"));
    if (env.LLM_BASE_URL) s.llmBaseUrl = env.LLM_BASE_URL;
    if (env.LLM_API_KEY) s.llmApiKey = env.LLM_API_KEY;
    if (env.LLM_MODEL) s.llmModel = env.LLM_MODEL;
  } catch {}
  // layer 1: settings.json
  try {
    const doc = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    for (const k of Object.keys(DEFAULTS)) {
      if (Array.isArray(DEFAULTS[k])) { if (Array.isArray(doc[k])) s[k] = doc[k]; continue; }
      if (typeof doc[k] === "string") { if (doc[k] !== "") s[k] = doc[k]; else s[k] = ""; }
    }
  } catch {}
  s.llmReady = !!(s.llmBaseUrl && s.llmApiKey && s.llmModel);
  cached = s;
  return s;
}

export function invalidateSettings() { cached = null; }

// masked view for the UI (never return the raw key)
export function maskSettings(s) {
  const key = s.llmApiKey || "";
  return { ...s, llmApiKey: key ? key.slice(0, 6) + "***" + key.slice(-4) : "", llmKeySet: !!key };
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const merged = { ...current };
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof patch[k] === "string") merged[k] = patch[k].trim();
  }
  // empty llmApiKey means "keep existing" (masked round-trip)
  if (patch.llmApiKey === "" && current.llmApiKey) merged.llmApiKey = current.llmApiKey;
  const doc = {};
  for (const k of Object.keys(DEFAULTS)) doc[k] = merged[k];
  const fs = await import("node:fs/promises");
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await fs.rename(tmp, SETTINGS_FILE);
  invalidateSettings();
  return maskSettings(await getSettings());
}

export async function readEnvFile() {
  try { return parseEnv(await readFile(ENV_FILE, "utf8")); } catch { return {}; }
}
