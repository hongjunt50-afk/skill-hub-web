// Atomic JSON state helpers. All server-writable state lives in server/data/.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, "..", "data");

const FILES = {
  overrides: "overrides.json",
  excluded: "excluded.json",
  customRoots: "custom-roots.json",
  categories: "categories.json"
};

const DEFAULTS = {
  overrides: { version: 1, manual: {} },
  excluded: { version: 1, names: [] },
  customRoots: { version: 1, paths: [] },
  categories: { version: 1, names: [] }
};

export function statePath(kind) {
  if (!FILES[kind]) throw new Error(`unknown state kind: ${kind}`);
  return join(DATA_DIR, FILES[kind]);
}

export async function readState(kind) {
  try {
    const doc = JSON.parse(await fs.readFile(statePath(kind), "utf8"));
    if (doc && typeof doc === "object") return doc;
  } catch {}
  return structuredClone(DEFAULTS[kind]);
}

export async function writeState(kind, doc) {
  const file = statePath(kind);
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function audit(event, detail) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + "\n";
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(join(DATA_DIR, "audit.log"), line, "utf8");
}
