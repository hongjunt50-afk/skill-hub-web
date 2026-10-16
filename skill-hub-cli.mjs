#!/usr/bin/env node
// skill-hub-cli — command-line control for the skill hub web system.
// Shares the same state files as the web UI (server/data/*.json), so changes
// made here show up in the web view immediately.
//
// Usage (from anywhere; default server data dir is resolved from this file):
//   node skill-hub-cli.mjs list [--category 名] [--query 词] [--root hub|agents-dir] [--json]
//   node skill-hub-cli.mjs detail <技能名>
//   node skill-hub-cli.mjs categorize <技能名> <分类名|auto>
//   node skill-hub-cli.mjs categories                       # 列出全部分类
//   node skill-hub-cli.mjs category-add <新分类名>
//   node skill-hub-cli.mjs category-delete <自定义分类名>
//   node skill-hub-cli.mjs roots                            # 扫描目录清单
//   node skill-hub-cli.mjs add-root <绝对路径>
//   node skill-hub-cli.mjs remove-root <绝对路径>
//   node skill-hub-cli.mjs online <技能名> | offline <技能名>
//   node skill-hub-cli.mjs status
//
// The server (port 3210) does the filesystem work; the CLI talks to its API so
// both surfaces stay consistent. Start the server first: 启动.bat / node server/index.js

import { fileURLToPath } from "node:url";

const API = process.env.SKILL_HUB_API || "http://localhost:3210/api";

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const doc = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}（服务未启动？先跑 启动.bat）` }));
  if (doc.code !== 0) throw new Error(doc.msg || `HTTP ${res.status}`);
  return doc.data;
}

const [, , cmd, ...rest] = process.argv;
const argOf = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };

function renderList(data) {
  const lines = [];
  for (const cat of data.categories) {
    lines.push(`## ${cat.name}（${cat.count}）`);
    for (const s of cat.skills) {
      const tags = [
        s.categorySource === "manual" ? "手动" : null,
        s.excluded ? "已下线" : null,
        s.sourceLabel
      ].filter(Boolean).join(" · ");
      lines.push(`  ${s.name.padEnd(34)} [${tags}]  ${s.description.replace(/\n/g, " ").slice(0, 80)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  switch (cmd) {
    case "list": {
      const params = {};
      if (rest.includes("--category")) params.category = argOf("--category");
      if (rest.includes("--query")) params.query = argOf("--query");
      if (rest.includes("--root")) params.root = argOf("--root");
      const data = await call("GET", `/skills?${new URLSearchParams(params)}`);
      if (rest.includes("--json")) { console.log(JSON.stringify(data, null, 2)); break; }
      console.log(`共 ${data.total} 个技能\n`);
      console.log(renderList(data));
      break;
    }
    case "detail": {
      const name = rest[0];
      if (!name) throw new Error("用法: detail <技能名>");
      const all = await call("GET", `/skills?query=${encodeURIComponent(name)}`);
      const hit = all.categories.flatMap((c) => c.skills).find((s) => s.name === name);
      if (!hit) throw new Error(`技能不存在: ${name}`);
      const d = await call("GET", `/skills/${encodeURIComponent(hit.rootKey)}/${encodeURIComponent(name)}`);
      console.log(`# ${d.declaredName}`);
      console.log(`root: ${d.rootKey} | 分类: ${d.category}（${d.categorySource}）| 来源: ${d.sourceLabel}`);
      console.log(`本体: ${d.upstreamPath || d.path}`);
      if (d.hubPath) console.log(`Hub:  ${d.hubPath}`);
      if (d.rootKey === "hub") console.log(`Agents: zcode=${d.agentLinks?.zcode ? "✓" : "✗"} codex=${d.agentLinks?.codex ? "✓" : "✗"}`);
      console.log(`\n## 触发词\n\n${d.triggers || d.description || "（无）"}\n`);
      console.log(`## SKILL.md 全文\n\n${d.body}`);
      break;
    }
    case "categorize": {
      const [name, cat] = rest;
      if (!name) throw new Error("用法: categorize <技能名> <分类名|auto>");
      const all = await call("GET", `/skills?query=${encodeURIComponent(name)}`);
      const hit = all.categories.flatMap((c) => c.skills).find((s) => s.name === name);
      if (!hit) throw new Error(`技能不存在: ${name}`);
      await call("POST", `/skills/${encodeURIComponent(hit.rootKey)}/${encodeURIComponent(name)}/category`, { category: cat || "auto" });
      console.log(`已${!cat || cat === "auto" ? "恢复自动分类" : `归入「${cat}」`}: ${name}`);
      break;
    }
    case "categories": {
      const d = await call("GET", "/categories");
      console.log("内置分类:");
      d.builtin.forEach((c) => console.log(`  ${c}`));
      const custom = d.categories.filter((c) => !d.builtin.includes(c));
      console.log("自定义分类:");
      custom.length ? custom.forEach((c) => console.log(`  ${c}`)) : console.log("  （无）");
      break;
    }
    case "category-add": {
      const name = rest[0];
      if (!name) throw new Error("用法: category-add <新分类名>");
      const r = await call("POST", "/categories", { name });
      console.log(r.added ? `已添加分类: ${name}` : `分类已存在: ${name}`);
      break;
    }
    case "category-delete": {
      const name = rest[0];
      if (!name) throw new Error("用法: category-delete <自定义分类名>");
      const r = await call("DELETE", `/categories/${encodeURIComponent(name)}`);
      console.log(`已删除分类: ${name}（${r.reverted} 个技能恢复自动分类）`);
      break;
    }
    case "roots": {
      const d = await call("GET", "/roots");
      console.log("自定义扫描目录:");
      (d.paths || []).length ? (d.paths || []).forEach((p) => console.log(`  ${p}`)) : console.log("  （无，内置: hub + ~/.agents/skills）");
      break;
    }
    case "add-root": {
      const p = rest[0];
      if (!p) throw new Error("用法: add-root <绝对路径>");
      const r = await call("POST", "/roots", { path: p });
      console.log(r.added ? `已添加扫描目录: ${r.path}` : `已存在: ${r.path}`);
      break;
    }
    case "remove-root": {
      const p = rest[0];
      if (!p) throw new Error("用法: remove-root <绝对路径>");
      await call("DELETE", `/roots?path=${encodeURIComponent(p)}`);
      console.log(`已移除扫描目录: ${p}`);
      break;
    }
    case "online":
    case "offline": {
      const name = rest[0];
      if (!name) throw new Error(`用法: ${cmd} <技能名>`);
      const r = await call("POST", `/skills/${encodeURIComponent(name)}/visibility`, { online: cmd === "online" });
      console.log(r.changed ? `已${cmd === "online" ? "上线" : "下线"}: ${name}` : `状态未变化: ${name}`);
      if (r.problems?.length) { console.error("问题: " + r.problems.join("；")); process.exit(1); }
      break;
    }
    case "trash": {
      const d = await call("GET", "/trash");
      if (!d.items.length) console.log("（回收站是空的）");
      else d.items.forEach((it) => console.log(`${it.id}  [${it.deletedAt.slice(0, 10)}]  ${it.name}  ← ${it.fromPath}`));
      break;
    }
    case "trash-restore": {
      const id = rest[0];
      if (!id) throw new Error("用法: trash-restore <id>");
      const r = await call("POST", `/trash/${encodeURIComponent(id)}/restore`);
      console.log("已恢复到: " + r.restoredTo);
      break;
    }
    case "trash-purge": {
      const id = rest[0];
      if (!id) throw new Error("用法: trash-purge <id>（彻底删除，硬触发技能会被拒绝）");
      const confirmName = id.lastIndexOf("@") > 0 ? id.slice(0, id.lastIndexOf("@")) : id;
      const r = await call("DELETE", `/trash/${encodeURIComponent(id)}`, { confirmName });
      console.log("已彻底删除: " + r.purged);
      break;
    }
    case "agent": {
      const q = rest.slice(1).join(" ");
      if (rest[0] !== "recommend" || !q) throw new Error('用法: agent recommend <中文需求>');
      const r = await call("POST", "/agent/recommend", { q });
      for (const rec of r.recommendations) {
        console.log(`推荐: ${rec.name}  [${rec.channel}]  ${rec.reason}`);
        console.log("--- 提示词（复制给工作 Agent）---");
        console.log(rec.promptText);
        console.log("");
      }
      if (r.fallback) console.log(r.fallback);
      break;
    }
    case "status": {
      const d = await call("GET", "/status");
      console.log(JSON.stringify(d.live, null, 2));
      for (const w of d.warnings || []) console.log(`⚠ ${w.message}`);
      break;
    }
    default:
      console.log(`skill-hub-cli — 技能控制管理命令行
用法:
  list [--category 名] [--query 词] [--root hub|agents-dir] [--json]
  detail <技能名>
  categorize <技能名> <分类名|auto>
  categories | category-add <名> | category-delete <名>
  roots | add-root <绝对路径> | remove-root <路径>
  online <技能名> | offline <技能名>
  trash | trash-restore <id> | trash-purge <id>
  agent recommend <中文需求>
  status
（需要服务在线: 启动.bat，或 node server/index.js）`);
  }
}

main().catch((e) => { console.error("错误: " + e.message); process.exit(1); });
