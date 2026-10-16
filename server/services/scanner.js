// Scanner: walks the hub junction farm (F:\AI\skills\hub) plus the agents-dir
// inbox (~\.agents\skills), resolves junction targets to authoritative upstream
// paths, classifies, and extracts trigger phrases.
//
// Source labels mirror build-skill-hub.ps1 root precedence. The authoritative
// name list is skill-plan.json (written by that script); hub entries absent
// from the plan are still shown (flag inPlan:false).

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promises as fs } from "node:fs";
import { classifyAuto, listCategories, UNCLASSIFIED } from "./classify.js";
import { readState } from "./state.js";

// All environment-specific paths come from settings (data/settings.json, with
// .env LLM_* layer). Defaults make the app run on any machine with zero config.
import { getSettings } from "./settings.js";

export async function paths() { return getSettings(); }
const P = await getSettings();

export const HUB = P.hubPath;
export const AGENTS_DIR = P.agentsDir;
export const ZCODE_SKILLS = P.zcodeSkills; // may be "" on other machines
export const CODEX_SKILLS = P.codexSkills;
const PLAN_PATH = P.skillPlanPath;
const COUNTS_PATH = P.countsPath;
export const BUILD_SCRIPT = P.buildScript; // empty = build-script integration disabled
export const GEN_CATALOG = P.genCatalog;
export const ROUTER_VERIFY = P.routerVerify ? [P.routerVerify, "verify"] : null;

// source labels: longest-prefix-wins mapping from upstream path to display label.
// Users can extend per-machine via data/settings.json sourceLabels: [[prefix, label]]

function buildSourceMap(P) {
  const map = [];
  const skillRoot = P.hubPath.replace(/[\\/]+$/, "");
  // generic labels derived from configured roots
  if (P.zcodeSkills) map.push([P.zcodeSkills, "ZCode 镜像"]);
  if (P.codexSkills) map.push([P.codexSkills, "Codex"]);
  map.push([P.agentsDir, "Agents 目录"]);
  // per-machine extra labels from settings
  for (const [prefix, label] of P.sourceLabels || []) map.push([prefix, label]);
  // legacy F:\AI pipeline labels (kept so this repo still works on the author machine)
  map.push(
    ["F:\\AI\\skills\\mcp-servers\\skills-archive", "归档区"],
    ["F:\\AI\\skills\\mcp-servers\\skills", "自研"],
    ["F:\\AI\\skills\\shared-agent-assets\\skills", "Unity 五件套"],
    ["F:\\AI\\agents\\hermes\\skills", "Hermes·运行期"],
    ["F:\\AI\\agents\\hermes\\hermes-agent\\optional-skills", "Hermes·可选池"],
    ["F:\\AI\\agents\\hermes\\hermes-agent\\skills", "Hermes·内置"],
    ["C:\\Users\\Administrator\\.codex\\skills\\.system", "Codex·系统"],
    ["F:\\MyDeck\\c-drive-ai-data\\.codex\\skills\\.system", "Codex·系统"],
    ["C:\\Users\\Administrator\\.codex\\skills", "Codex"],
    ["F:\\MyDeck\\c-drive-ai-data\\.codex\\skills", "Codex"],
    ["C:\\Users\\Administrator\\.agents\\skills", "Agents 目录"],
    ["F:\\MyDeck\\c-drive-ai-data\\.agents\\skills", "Agents 目录"]
  );
  return map;
}
const SOURCE_MAP = buildSourceMap(P);
SOURCE_MAP.push(["F:\\AI\\skills\\hub", "知识缓存"]); // author-machine hub real dirs

export function sourceLabelFor(upstreamPath) {
  const p = String(upstreamPath || "").replace(/\//g, "\\").toLowerCase();
  let best = null;
  for (const [prefix, label] of SOURCE_MAP) {
    if (p.startsWith(prefix.toLowerCase()) && (!best || prefix.length > best[0].length)) best = [prefix, label];
  }
  return best ? best[1] : "其它来源";
}

// hub real dirs (cache layer) keep their own identity; junctions map to the
// authoritative upstream source
function s_link_label(entryPath, linked, upstreamDir) {
  return linked ? sourceLabelFor(upstreamDir) : "知识缓存";
}

export function parseSkillDoc(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/);
  const map = Object.create(null);
  let body = src;
  let hasFrontmatter = false;
  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1).findIndex((l) => l.trim() === "---");
    if (end >= 0) {
      hasFrontmatter = true;
      for (let i = 1; i <= end; i++) {
        const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        if (/^[>|]/.test(m[2])) {
          const content = [];
          while (i + 1 <= end && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) { i++; content.push(lines[i]); }
          map[m[1]] = content.join("\n").trim();
        } else {
          map[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
        }
      }
      body = lines.slice(end + 2).join("\n");
    }
  }
  return { map, body, hasFrontmatter };
}

const TRIGGER_HEADING = /(trigger|when to use|use when|适用|触发|何时使用|使用时机|invoke|activation)/i;

function extractTriggers(doc) {
  const description = String(doc.map.description || "").trim();
  const lines = String(doc.body || "").split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    if (heading) { if (current) sections.push(current); current = { title: heading[1].trim(), lines: [] }; }
    else if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  const hits = sections.filter((s) => TRIGGER_HEADING.test(s.title)).map((s) => `${s.title}\n${s.lines.join("\n")}`.trim()).filter((s) => s.length > 10);
  return { description, triggers: hits.join("\n\n").slice(0, 2000) };
}

async function dirSet(path) {
  try { return new Set(await fs.readdir(path)); } catch { return new Set(); }
}

async function loadPlan() {
  try {
    // skill-plan.json is written by PowerShell with a UTF-8 BOM
    const text = (await fs.readFile(PLAN_PATH, "utf8")).replace(/^\uFEFF/, "");
    const plan = JSON.parse(text);
    const map = new Map();
    for (const row of plan) if (row?.name) map.set(row.name, row);
    return map;
  } catch { return new Map(); }
}

export async function loadCountsDoc() {
  try { return JSON.parse(await fs.readFile(COUNTS_PATH, "utf8")); } catch { return null; }
}

async function scanDirWithLinks(rootPath, { kind, overrides, plan, cacheRealDirs }) {
  const skills = [];
  let names = [];
  try { names = await fs.readdir(rootPath); } catch { return skills; }
  for (const name of names) {
    if (name === "INDEX.md" || name === "index" || name.startsWith(".")) continue;
    const entryPath = join(rootPath, name);
    let st;
    try { st = await fs.lstat(entryPath); } catch { continue; }
    if (!st.isDirectory() && !st.isSymbolicLink()) continue; // plain files are not skills
    const linked = st.isSymbolicLink();
    if (kind === "hub" && !linked && cacheRealDirs && !cacheRealDirs.has(name)) {
      // real dir in hub that is not one of the known cache-layer skills and not
      // linked: still treat as a skill candidate (cache layer semantics)
    }
    let upstreamDir = entryPath;
    if (linked) {
      try { upstreamDir = await fs.realpath(entryPath); } catch { /* dangling */ }
    }
    const docPath = join(upstreamDir, "SKILL.md");
    let raw = null;
    try { raw = await fs.readFile(docPath, "utf8"); } catch {}
    const doc = raw !== null ? parseSkillDoc(raw) : { map: {}, body: "", hasFrontmatter: false };
    const declaredName = String(doc.map.name || "").trim();
    const loadable = doc.hasFrontmatter && !!declaredName && !!doc.map.description;
    const { description, triggers } = extractTriggers(doc);
    const stateKey = `${kind}:${name}`;
    const manualCategory = overrides.manual?.[stateKey];
    const category = manualCategory || classifyAuto(name, description);
    skills.push({
      name,
      declaredName: declaredName || name,
      loadable,
      kind, // hub | agents-dir | custom:<path>
      rootKey: kind,
      path: docPath,
      hubPath: kind === "hub" ? entryPath : null,
      upstreamPath: kind === "hub" ? upstreamDir : null,
      sourceLabel: kind === "hub" ? (s_link_label(entryPath, linked, upstreamDir)) : "Agents 目录",
      linked,
      description,
      triggers,
      category,
      categorySource: manualCategory ? "manual" : "auto",
      inPlan: plan.has(name),
      planRoot: plan.get(name)?.root ?? null,
      excluded: false // filled by caller
    });
  }
  return skills;
}

export async function scanAll({ includeCustomRoots = true } = {}) {
  const [overrides, excluded, customRoots, plan, categoryOrder] = await Promise.all([
    readState("overrides"),
    readState("excluded"),
    includeCustomRoots ? readState("customRoots") : Promise.resolve({ paths: [] }),
    loadPlan(),
    listCategories()
  ]);
  const excludedSet = new Set(excluded.names || []);

  // know which hub entries are real dirs (cache layer) vs junctions
  const cacheRealDirs = new Set();
  try {
    for (const n of await fs.readdir(HUB)) {
      const st = await fs.lstat(join(HUB, n)).catch(() => null);
      if (st?.isDirectory() && !st.isSymbolicLink() && n !== "index") cacheRealDirs.add(n);
    }
  } catch {}

  const [zcodeSet, codexSet] = await Promise.all([dirSet(ZCODE_SKILLS), dirSet(CODEX_SKILLS)]);

  const roots = [];
  const hubSkills = await scanDirWithLinks(HUB, { kind: "hub", overrides, plan, cacheRealDirs });
  for (const s of hubSkills) {
    s.excluded = excludedSet.has(s.name);
    s.agentLinks = { zcode: zcodeSet.has(s.name), codex: codexSet.has(s.name) };
    if (!s.upstreamPath && s.linked === false && cacheRealDirs.has(s.name)) s.upstreamPath = s.hubPath; // cache-layer real dir
  }
  roots.push({ key: "hub", label: "共享技能 Hub", path: HUB, builtin: true, skills: hubSkills });

  const inboxSkills = await scanDirWithLinks(AGENTS_DIR, { kind: "agents-dir", overrides, plan });
  roots.push({ key: "agents-dir", label: "Agents 目录（下载收件箱）", path: AGENTS_DIR, builtin: true, skills: inboxSkills });

  for (const p of customRoots.paths || []) {
    const kind = `custom:${p}`;
    const skills = await scanDirWithLinks(p, { kind, overrides, plan });
    roots.push({ key: kind, label: p, path: p, builtin: false, skills });
  }

  // group into categories per root (loadable only), keep letter order
  for (const root of roots) {
    const buckets = new Map();
    for (const s of root.skills) {
      if (!s.loadable) continue;
      if (!buckets.has(s.category)) buckets.set(s.category, []);
      buckets.get(s.category).push(s);
    }
    root.categories = categoryOrder.filter((c) => buckets.has(c)).map((c) => ({
      id: c, name: c, count: buckets.get(c).length,
      skills: buckets.get(c).sort((a, b) => a.name.localeCompare(b.name))
    }));
  }
  return { roots, overrides, excluded: excludedSet };
}

export async function skillDetail(rootKey, name) {
  const { roots } = await scanAll();
  const root = roots.find((r) => r.key === rootKey);
  const skill = root?.skills.find((s) => s.name === name);
  if (!skill) return null;
  let body = "";
  try { body = await fs.readFile(skill.path, "utf8"); } catch {}
  return { ...skill, body };
}
