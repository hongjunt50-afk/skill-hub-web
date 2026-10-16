// Agent rule base: three data sources, all hot-reloaded by mtime.
//   1. conflicts.json (skill-router matrix: route rules + Chinese skill_signals) — read-only reuse
//   2. Chinese skill catalog (干什么/何时用 two-column corpus) — read-only, best-effort parse
//   3. agent-rules.json (accumulated mappings maintained by the model + user) — read/write
//
// Scorer: Node port of router.py keyword_fallback semantics
// (CJK 2-gram +1, English word ≥3 chars ×2, matrix route hit = direct verdict).

import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "./settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_FILE = join(__dirname, "..", "data", "agent-rules.json");

// Optional machine-specific corpus paths (both empty by default):
//   routerConflictsPath — skill-router conflicts.json (route matrix + Chinese signals)
//   genCatalog          — Chinese two-column skill catalog (干什么/何时用)
// All degrade gracefully: absent files simply yield empty matrix/catalog.
async function corpusPaths() {
  const s = await getSettings();
  return {
    conflicts: s.routerConflictsPath || "",
    catalog: s.genCatalog || ""
  };
}

const cache = {
  matrix: { mtime: 0, data: null },
  catalog: { mtime: 0, data: null }
};

async function mtimeOf(path) {
  try { return (await stat(path)).mtimeMs; } catch { return 0; }
}

async function loadMatrix() {
  const P = await corpusPaths();
  const mt = P.conflicts ? await mtimeOf(P.conflicts) : 0;
  if (cache.matrix.data && cache.matrix.mtime === mt && cache.matrix.path === P.conflicts) return cache.matrix.data;
  if (!P.conflicts) { cache.matrix = { mtime: 0, path: "", data: { skill_signals: {}, conflicts: [] } }; return cache.matrix.data; }
  try {
    const doc = JSON.parse(await readFile(P.conflicts, "utf8"));
    cache.matrix = { mtime: mt, path: P.conflicts, data: doc };
  } catch { cache.matrix = { mtime: mt, path: P.conflicts, data: { skill_signals: {}, conflicts: [] } }; }
  return cache.matrix.data;
}

// parse the catalog's Chinese two-column tables: | `name` | 干什么 | 何时用 |
export async function loadCatalog() {
  const P = await corpusPaths();
  const mt = P.catalog ? await mtimeOf(P.catalog) : 0;
  if (cache.catalog.data && cache.catalog.mtime === mt && cache.catalog.path === P.catalog) return cache.catalog.data;
  const map = new Map();
  if (P.catalog) {
    try {
      const text = await readFile(P.catalog, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = /^\|\s*`([a-z0-9-]+)`\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
        if (m && m[2] !== "干什么") map.set(m[1], { what: m[2], when: m[3] });
      }
    } catch {}
  }
  cache.catalog = { mtime: mt, path: P.catalog, data: map };
  return cache.catalog.data;
}

export async function loadUserRules() {
  try {
    const doc = JSON.parse(await readFile(RULES_FILE, "utf8"));
    if (doc && typeof doc === "object") return { version: 1, mappings: [], categoryHints: {}, ...doc };
  } catch {}
  return { version: 1, mappings: [], categoryHints: {} };
}

export async function saveUserRules(doc) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(dirname(RULES_FILE), { recursive: true });
  const tmp = RULES_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await fs.rename(tmp, RULES_FILE);
}

export async function recordObservation(query, skillName, source) {
  const fs = await import("node:fs/promises");
  const line = JSON.stringify({ ts: new Date().toISOString(), query, skill: skillName, source }) + "\n";
  await fs.appendFile(join(__dirname, "..", "data", "agent-observations.jsonl"), line, "utf8");
}

export async function readObservations(limit = 200) {
  const fs = await import("node:fs/promises");
  try {
    const text = await readFile(join(__dirname, "..", "data", "agent-observations.jsonl"), "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---- matching helpers (router.py semantics) ----

function whenMatches(when, task) {
  try { return new RegExp(when, "i").test(task); }
  catch { return task.toLowerCase().includes(String(when).toLowerCase()); }
}

function cjkBigrams(text) {
  const out = [];
  const chars = [...text];
  for (let i = 0; i < chars.length - 1; i++) {
    if (/[\u4e00-\u9fff]/.test(chars[i]) && /[\u4e00-\u9fff]/.test(chars[i + 1])) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

function englishWords(text) {
  return [...String(text).toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)].map((m) => m[0]);
}

/**
 * Three-channel cascade search.
 * @param {string} task    the user's (usually Chinese) requirement/query
 * @param {Array}  skills  full scanned skill list [{name, description, triggers, sourceLabel, category, ...}]
 * @returns {{hits: Array, channels: string[], degraded: boolean}}
 */
export async function agentSearch(task, skills, { llmFn = null } = {}) {
  const channels = [];
  const query = String(task || "").trim();
  if (!query) return { hits: [], channels, degraded: false };

  // channel 1: matrix routes (direct verdicts from conflicts.json)
  const matrix = await loadMatrix();
  const hits = [];
  const seen = new Set();
  for (const group of matrix.conflicts || []) {
    for (const route of group.routes || []) {
      if ((route.when || []).some((w) => whenMatches(w, query))) {
        for (const use of [].concat(route.use)) {
          if (!seen.has(use)) { seen.add(use); hits.push({ name: use, reason: `路由矩阵裁决：${group.domain} → ${use}${route.note ? "（" + route.note + "）" : ""}`, score: 100, channel: "matrix" }); }
        }
      }
    }
  }
  if (hits.length > 0) channels.push("matrix");

  // channel 2: rule scorer over all skills (catalog ZH + description + user mappings)
  const catalog = await loadCatalog();
  const userRules = await loadUserRules();
  const signals = matrix.skill_signals || {};
  const qBigrams = new Set(cjkBigrams(query));
  const qWords = englishWords(query);

  const scored = skills.map((s) => {
    let score = 0;
    const zh = catalog.get(s.name);
    const hayParts = [s.name, s.description || "", s.triggers || ""];
    if (zh) hayParts.push(zh.what, zh.when);
    const hay = hayParts.join("\n");
    for (const bg of qBigrams) if (hay.includes(bg)) score += 1;
    for (const w of qWords) if (hay.toLowerCase().includes(w)) score += 2;
    for (const kw of signals[s.name] || []) if (query.includes(kw)) score += 3;
    // user-accumulated mappings: strong signal
    for (const m of userRules.mappings || []) {
      if (m.skill === s.name && (query.includes(m.keyword) || m.keyword && [...qBigrams].some((bg) => m.keyword.includes(bg)))) score += 4;
    }
    if (zh && score > 0) score += 1; // catalog-corroborated skills rank slightly higher
    return { ...s, score, reason: zh ? zh.what : (s.description || "").slice(0, 90), channel: "rules" };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const ruleHits = scored.slice(0, 6);
  if (ruleHits.length > 0) channels.push("rules");

  // merge: matrix verdicts first, then rule hits not already covered
  for (const h of ruleHits) {
    if (!seen.has(h.name)) { seen.add(h.name); hits.push({ name: h.name, reason: h.reason, score: h.score, channel: "rules" }); }
  }

  // channel 3: LLM fallback when thin
  let degraded = false;
  const bestRuleScore = hits.filter((h) => h.channel === "rules")[0]?.score ?? 0;
  if ((hits.length < 3 || bestRuleScore < 6) && llmFn) {
    try {
      channels.push("llm");
      const llmHits = await llmFn(query, skills);
      for (const h of llmHits) {
        if (!seen.has(h.name)) { seen.add(h.name); hits.push({ ...h, channel: "llm" }); }
      }
      for (const h of llmHits) await recordObservation(query, h.name, "llm");
    } catch {
      degraded = true; // LLM unavailable or failed; rule results still stand
    }
  }

  const rank = { matrix: 0, llm: 1, rules: 2 };
  hits.sort((a, b) => (rank[a.channel] ?? 3) - (rank[b.channel] ?? 3) || (b.score ?? 0) - (a.score ?? 0));
  return { hits: hits.slice(0, 8), channels, degraded };
}
