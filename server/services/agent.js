// Built-in agent: recommendation, auto-categorization, rule maintenance.
// All LLM calls degrade gracefully — every exported function returns useful
// rule-based results even when the model is unreachable.

import { llmAvailable, llmChat, llmJson } from "./llmClient.js";
import { agentSearch, loadCatalog, loadUserRules, saveUserRules, readObservations } from "./agentRules.js";
import { scanAll } from "./scanner.js";
import { audit } from "./state.js";

function indexForPrompt(skills) {
  return skills
    .filter((s) => s.loadable)
    .map((s) => `- ${s.name}: ${(s.description || "").replace(/\n/g, " ").slice(0, 140)}`)
    .join("\n");
}

const SYSTEM = "你是本机技能管理平台的内置助手。平台聚合了本机全部 Agent 技能（每个技能有英文名和英文/中文描述）。你只依据给出的技能清单回答，绝不发明不存在的技能名。用简体中文回答。";

// ---- 1a/1c: search & recommend ----

export async function agentRecommend(task) {
  const { roots } = await scanAll({ includeCustomRoots: false });
  const skills = roots[0].skills;
  const llmFn = async (query, all) => {
    const reply = await llmJson([
      { role: "system", content: SYSTEM },
      { role: "user", content: `用户需求：${query}\n\n技能清单：\n${indexForPrompt(all)}\n\n从中选出最匹配该需求的 1-3 个技能。只返回 JSON：{"hits":[{"name":"技能名","reason":"中文理由（为什么这个技能适合该需求，何时用）"}]}。若清单中确实没有匹配项，返回 {"hits":[]}。` }
    ]);
    return (reply.hits || []).filter((h) => all.some((s) => s.name === h.name));
  };

  const { hits, channels, degraded } = await agentSearch(task, skills, { llmFn });

  // recommendation view: top 3 with copyable prompt text
  const recs = hits.slice(0, 3).map((h) => {
    const s = skills.find((x) => x.name === h.name);
    return {
      name: h.name,
      reason: h.reason,
      channel: h.channel,
      category: s?.category,
      sourceLabel: s?.sourceLabel,
      description: s?.description,
      triggers: s?.triggers || s?.description || "",
      promptText: buildPromptText(s, h)
    };
  });

  const noMatch = recs.length === 0;
  return {
    ok: true,
    degraded,
    channels,
    recommendations: recs,
    fallback: noMatch
      ? "本地技能清单中没有匹配项。可以让工作 Agent 使用 find-skills 技能搜索并安装开源 skills.sh 生态的技能；或用 tool-location-confirm 定位外部工具。"
      : null
  };
}

function buildPromptText(s, hit) {
  if (!s) return "";
  const lines = [
    `请使用技能「${s.name}」完成以下任务。`,
    ``,
    `技能说明：${(s.description || "").slice(0, 200)}`,
    hit.reason && hit.reason !== s.description ? `选择理由：${hit.reason}` : null,
    `触发要点：${(s.triggers || s.description || "").slice(0, 300)}`,
    ``
  ].filter((x) => x !== null);
  return lines.join("\n");
}

// alias so search UI and recommend share one implementation
export const agentSearchApi = agentRecommend;

// ---- 1b: auto-categorization ----

export async function autoCategorize(categoryNames, { dryRun = true } = {}) {
  if (!Array.isArray(categoryNames) || categoryNames.length === 0) {
    return { ok: false, error: "分类清单为空" };
  }
  const { roots, overrides } = await scanAll({ includeCustomRoots: false });
  const skills = roots[0].skills.filter((s) => s.loadable && s.categorySource !== "manual");
  const suggestions = [];
  const batches = [];
  for (let i = 0; i < skills.length; i += 25) batches.push(skills.slice(i, i + 25));

  let llmOk = await llmAvailable();
  for (const batch of batches) {
    if (llmOk) {
      try {
        const reply = await llmJson([
          { role: "system", content: SYSTEM },
          { role: "user", content: `把这些技能归类。只能使用以下分类（逐字使用，不要发明）：\n${categoryNames.join("、")}\n\n技能清单：\n${batch.map((s) => `- ${s.name}: ${(s.description || "").slice(0, 120).replace(/\n/g, " ")}`).join("\n")}\n\n只返回 JSON：{"assign":[{"name":"技能名","category":"分类名","confidence":0到1}]}。没有把握的技能不要输出；宁可少输出。` }
        ]);
        for (const a of reply.assign || []) {
          if (!categoryNames.includes(a.category)) continue;
          if (!batch.some((s) => s.name === a.name)) continue;
          suggestions.push({ name: a.name, category: a.category, confidence: Number(a.confidence) || 0.5, via: "llm" });
        }
      } catch { llmOk = false; }
    }
    if (!llmOk) {
      // rule-based fallback: reuse the scanner's auto category, filtered to allowed list
      for (const s of batch) {
        if (categoryNames.includes(s.category)) suggestions.push({ name: s.name, category: s.category, confidence: 0.6, via: "rules" });
      }
    }
  }

  const applied = [];
  if (!dryRun) {
    for (const s of suggestions.filter((x) => x.confidence >= 0.7)) {
      overrides.manual ??= {};
      overrides.manual[`hub:${s.name}`] = s.category;
      applied.push(s);
    }
    await audit("auto-categorize", { applied: applied.length, suggested: suggestions.length });
  }
  return { ok: true, degraded: !llmOk, dryRun, suggestions, applied: applied.length };
}

// ---- 1d: rule maintenance ----

export async function maintainRules({ apply = false } = {}) {
  const rules = await loadUserRules();
  const observations = await readObservations(300);
  const catalog = await loadCatalog();
  const catalogSample = [...catalog.entries()].slice(0, 40).map(([n, v]) => `${n}: ${v.what}`).join("\n");
  if (!observations.length) {
    return { ok: true, diff: null, message: "还没有观察记录（先在智能搜索里用中文查几次）" };
  }
  const reply = await llmJson([
    { role: "system", content: SYSTEM },
    { role: "user", content: `你在维护一个"中文需求→技能"映射规则库。当前规则：\n${JSON.stringify(rules.mappings, null, 1)}\n\n近期观察记录（中文查询→实际命中的技能）：\n${observations.map((o) => `${o.query} → ${o.skill}`).join("\n")}\n\n参考（部分技能的中文用途）：\n${catalogSample}\n\n任务：从观察记录中提炼稳定的映射（同一中文关键词稳定命中同一技能 ≥2 次才提炼），修正错误映射，去掉无效条目。只返回 JSON：\n{"keep":[{"keyword":"中文关键词","skill":"技能名","note":"一句话依据"}],"remove":[被移除的旧映射关键词数组]}\nkeep 里包含全部应存在的映射（旧的+新的）。` }
  ]);
  const proposed = {
    version: rules.version + 1,
    mappings: (reply.keep || []).filter((m) => m.keyword && m.skill),
    removed: reply.remove || []
  };
  if (apply) {
    await saveUserRules(proposed);
    await audit("maintain-rules", { mappings: proposed.mappings.length, removed: proposed.removed.length });
  }
  return { ok: true, applied: apply, diff: { before: rules.mappings, after: proposed.mappings, removed: proposed.removed } };
}
