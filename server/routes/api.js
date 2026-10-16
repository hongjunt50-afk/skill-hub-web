import { Router } from "express";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { scanAll, skillDetail, loadCountsDoc, AGENTS_DIR, ZCODE_SKILLS, CODEX_SKILLS, HUB } from "../services/scanner.js";
import { readState, writeState, audit } from "../services/state.js";
import { setVisibility } from "../services/hubControl.js";
import { browseDirectories } from "../services/browse.js";
import { listCategories, addCategory, removeCategory, BUILTIN_CATEGORIES } from "../services/classify.js";
import { agentRecommend, autoCategorize, maintainRules } from "../services/agent.js";
import { moveToTrash, listTrash, restoreFromTrash, purgeTrash } from "../services/trash.js";
import { llmAvailable, invalidateLlmCfg } from "../services/llmClient.js";
import { getSettings, maskSettings, updateSettings, invalidateSettings } from "../services/settings.js";

export const apiRouter = Router();

const ok = (res, data, msg = "ok") => res.json({ code: 0, msg, data });
const fail = (res, status, error, code) => res.status(status).json({ code: code || "error", msg: error, data: null });

apiRouter.get("/skills", async (req, res) => {
  try {
    const { query, category, source, root, visibility } = req.query;
    const { roots } = await scanAll();
    let items = roots.flatMap((r) => r.skills.map((s) => ({ ...s, rootLabel: r.label })));
    if (root) items = items.filter((s) => s.rootKey === root);
    if (category) items = items.filter((s) => s.category === category);
    if (source) items = items.filter((s) => s.sourceLabel === source);
    if (visibility === "online") items = items.filter((s) => s.rootKey !== "hub" || (!s.excluded && s.inPlan !== false));
    if (visibility === "offline") items = items.filter((s) => s.rootKey === "hub" && s.excluded);
    if (query) {
      const q = String(query).toLowerCase();
      items = items.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.triggers.toLowerCase().includes(q));
    }
    // category rollup computed after filtering
    const byCategory = new Map();
    for (const s of items) {
      if (!byCategory.has(s.category)) byCategory.set(s.category, []);
      byCategory.get(s.category).push(s);
    }
    for (const list of byCategory.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    ok(res, {
      total: items.length,
      categories: [...byCategory.entries()].map(([name, skills]) => ({ name, count: skills.length, skills })),
      counts: {
        hub: roots[0].skills.filter((s) => s.loadable).length,
        agentsDir: roots[1].skills.filter((s) => s.loadable).length
      }
    });
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.get("/skills/:rootKey/:name", async (req, res) => {
  try {
    const d = await skillDetail(req.params.rootKey, req.params.name);
    if (!d) return fail(res, 404, "技能不存在", "error.skill.notFound");
    ok(res, d);
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/skills/:rootKey/:name/category", async (req, res) => {
  try {
    const { rootKey, name } = req.params;
    const cat = req.body?.category;
    const state = await readState("overrides");
    state.manual ??= {};
    const key = `${rootKey}:${name}`;
    if (!cat || cat === "auto") delete state.manual[key];
    else {
      if (typeof cat !== "string" || cat.length > 40) return fail(res, 400, "非法分类名", "error.category.invalid");
      state.manual[key] = cat;
    }
    await writeState("overrides", state);
    await audit("category", { key, category: cat || "auto" });
    ok(res, { key, category: cat || "auto" });
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.get("/roots", async (_req, res) => {
  try { ok(res, await readState("customRoots")); } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/roots", async (req, res) => {
  try {
    const raw = String(req.body?.path || "").trim();
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(raw)) return fail(res, 400, `需要绝对路径: ${raw}`, "error.path.absolute");
    const clean = resolve(raw);
    const state = await readState("customRoots");
    state.paths ??= [];
    if (state.paths.some((p) => resolve(p) === clean)) return ok(res, { added: false, path: clean });
    // sanity: must be an existing directory
    try { await fs.access(clean); } catch { return fail(res, 400, `目录不存在: ${clean}`, "error.path.missing"); }
    state.paths.push(clean);
    await writeState("customRoots", state);
    await audit("add-root", { path: clean });
    ok(res, { added: true, path: clean });
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.delete("/roots", async (req, res) => {
  try {
    const clean = resolve(String(req.body?.path || req.query.path || "").trim());
    const state = await readState("customRoots");
    const before = state.paths.length;
    state.paths = state.paths.filter((p) => resolve(p) !== clean);
    if (state.paths.length === before) return fail(res, 404, `未登记的目录: ${clean}`, "error.root.unknown");
    await writeState("customRoots", state);
    await audit("remove-root", { path: clean });
    ok(res, { removed: true });
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/skills/:name/visibility", async (req, res) => {
  try {
    const online = req.body?.online;
    if (typeof online !== "boolean") return fail(res, 400, "body.online 必须是布尔值", "error.body.invalid");
    const result = await setVisibility(req.params.name, online);
    if (!result.ok && result.code) return fail(res, result.code === "error.skill.protected" ? 403 : 400, result.error, result.code);
    ok(res, result, result.changed ? (online ? "已上线" : "已下线") : "状态未变化");
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

// ---- folder browser (for adding scan roots) ----

apiRouter.get("/browse", async (req, res) => {
  try {
    const r = await browseDirectories(req.query.path);
    if (!r.ok) return fail(res, 400, r.error, r.code);
    ok(res, r);
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

// ---- dynamic categories (built-ins + user-added) ----

apiRouter.get("/categories", async (_req, res) => {
  try { ok(res, { categories: await listCategories(), builtin: BUILTIN_CATEGORIES }); }
  catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/categories", async (req, res) => {
  try {
    const r = await addCategory(req.body?.name);
    if (!r.ok) return fail(res, 400, r.error, r.code);
    await audit("category-add", { name: req.body?.name });
    ok(res, r, r.added ? "分类已添加" : "分类已存在");
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.delete("/categories/:name", async (req, res) => {
  try {
    const r = await removeCategory(req.params.name);
    if (!r.ok) return fail(res, 400, r.error, r.code);
    await audit("category-remove", { name: req.params.name, reverted: r.reverted });
    ok(res, r, `分类已删除，${r.reverted} 个技能恢复自动分类`);
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

// ---- runtime settings (API/key/model + paths, editable in web UI) ----

apiRouter.get("/settings", async (_req, res) => {
  ok(res, maskSettings(await getSettings()));
});

apiRouter.post("/settings", async (req, res) => {
  try {
    const r = await updateSettings(req.body || {});
    invalidateLlmCfg();
    await audit("settings-update", { keys: Object.keys(req.body || {}) });
    ok(res, r, "设置已保存");
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/agent/test-llm", async (_req, res) => {
  try {
    invalidateSettings(); invalidateLlmCfg();
    const { llmChat } = await import("../services/llmClient.js");
    const reply = await llmChat([{ role: "user", content: "Reply with just OK" }], { temperature: 0 });
    ok(res, { reply: reply.slice(0, 50) }, "LLM 连通正常");
  } catch (e) { fail(res, 502, String(e.message || e).slice(0, 300)); }
});

// ---- built-in agent ----
// NOTE: these must be registered before generic /skills/:name/visibility style
// routes; Express matches by verb+segment so no shadowing occurs, but the more
// specific /skills/:rootKey/:name/trash is declared here anyway.

apiRouter.get("/agent/status", async (_req, res) => {
  ok(res, { llm: await llmAvailable() });
});

apiRouter.post("/agent/search", async (req, res) => {
  try {
    const q = String(req.body?.q || "").trim();
    if (!q) return fail(res, 400, "缺少查询内容", "error.body.invalid");
    ok(res, await agentRecommend(q));
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/agent/recommend", async (req, res) => {
  try {
    const q = String(req.body?.q || "").trim();
    if (!q) return fail(res, 400, "缺少需求描述", "error.body.invalid");
    ok(res, await agentRecommend(q));
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/agent/auto-categorize", async (req, res) => {
  try {
    const categories = req.body?.categories;
    const dryRun = req.body?.dryRun !== false;
    const r = await autoCategorize(categories, { dryRun });
    if (!r.ok) return fail(res, 400, r.error);
    ok(res, r);
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/agent/maintain-rules", async (req, res) => {
  try {
    ok(res, await maintainRules({ apply: req.body?.apply === true }));
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

// ---- trash (two-stage deletion; writable roots only) ----

apiRouter.post("/skills/:rootKey/:name/trash", async (req, res) => {
  try {
    const r = await moveToTrash(req.params.rootKey, req.params.name);
    if (!r.ok) return fail(res, r.code === "error.root.readonly" ? 403 : 400, r.error, r.code);
    ok(res, r, "已移入回收站");
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.get("/trash", async (_req, res) => {
  try { ok(res, await listTrash()); } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.post("/trash/:id/restore", async (req, res) => {
  try {
    const r = await restoreFromTrash(req.params.id);
    if (!r.ok) return fail(res, 400, r.error, r.code);
    ok(res, r, "已恢复");
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.delete("/trash/:id", async (req, res) => {
  try {
    const r = await purgeTrash(req.params.id, { confirmName: req.body?.confirmName });
    if (!r.ok) return fail(res, r.code === "error.skill.protected" ? 403 : 400, r.error, r.code);
    ok(res, r, "已彻底删除");
  } catch (e) { fail(res, 500, String(e.message || e)); }
});

apiRouter.get("/status", async (_req, res) => {  try {
    const { roots } = await scanAll({ includeCustomRoots: false });
    const hubSkills = roots[0].skills;
    const planEntries = hubSkills.filter((s) => s.inPlan);
    const zcodeJunctions = hubSkills.filter((s) => s.agentLinks?.zcode).length;
    const codexJunctions = hubSkills.filter((s) => s.agentLinks?.codex).length;
    const countsDoc = await loadCountsDoc();
    const live = {
      hubJunctions: hubSkills.filter((s) => s.linked).length,
      hubRealDirs: hubSkills.filter((s) => !s.linked && s.kind === "hub").length,
      planEntries: planEntries.length,
      zcodeVisible: zcodeJunctions,
      codexVisible: codexJunctions,
      agentsInbox: roots[1].skills.filter((s) => s.loadable).length
    };
    const warnings = [];
    if (countsDoc?.counts) {
      const pairs = [
        ["hub_total", live.hubJunctions + live.hubRealDirs],
        ["zcode_visible", live.zcodeVisible],
        ["codex_visible", live.codexVisible],
        ["agents_inbox", live.agentsInbox]
      ];
      for (const [key, actual] of pairs) {
        const recorded = countsDoc.counts[key]?.value;
        if (typeof recorded === "number" && recorded !== actual) {
          warnings.push({ key, recorded, actual, message: `COUNTS.json ${key}=${recorded} 已过期，实测 ${actual}` });
        }
      }
    }
    ok(res, {
      live,
      countsUpdatedAt: countsDoc?._checked_at ?? null,
      warnings,
      paths: { hub: HUB, agentsDir: AGENTS_DIR, zcodeSkills: ZCODE_SKILLS, codexSkills: CODEX_SKILLS }
    });
  } catch (e) { fail(res, 500, String(e.message || e)); }
});
