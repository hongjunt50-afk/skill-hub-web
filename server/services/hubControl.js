// Online/offline control. The single source of truth for visibility is the
// $excludedSkills array inside build-skill-hub.ps1 (line ~34). This service
// edits that array (with backup), invokes the script, and verifies the
// filesystem before/after.
//
// Offline: add name → powershell -File build-skill-hub.ps1 -Apply
//   (sweeps hub junction, then dangling-cleans agent junctions, rebuilds indexes)
// Online: remove name → powershell ... -Apply -SyncAgents
//   (re-creating an existing skill is a "pre-existing gap"; -SyncAgents is what
//   backfills agent junctions)

import { spawnSync } from "node:child_process";
import { readFile, writeFile, copyFile, lstat, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BUILD_SCRIPT, GEN_CATALOG, ROUTER_VERIFY, HUB, scanAll } from "./scanner.js";
import { getSettings } from "./settings.js";
import { readState, writeState, audit } from "./state.js";

export const HARD_TRIGGER_SKILLS = new Set([
  "ponytail",
  "systematic-debugging",
  "verification-before-completion",
  "coding-hard-triggers"
]);

const EXCLUDED_BLOCK_RE = /\$excludedSkills\s*=\s*@\(([^)]*)\)/;

function renderExcludedBlock(names) {
  if (names.length === 0) return "$excludedSkills = @()";
  const body = names.map((n) => `    '${n}'`).join(",\n");
  return `$excludedSkills = @(\n${body}\n)`;
}

async function readScriptExcluded() {
  const text = await readFile(BUILD_SCRIPT, "utf8");
  const m = EXCLUDED_BLOCK_RE.exec(text);
  if (!m) throw new Error("build script: $excludedSkills block not found");
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return { text, names };
}

async function writeScriptExcluded(names) {
  const { text } = await readScriptExcluded();
  const updated = text.replace(EXCLUDED_BLOCK_RE, () => renderExcludedBlock(names));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(BUILD_SCRIPT, `${BUILD_SCRIPT}.bak-web-${ts}`);
  await writeFile(BUILD_SCRIPT, updated, "utf8");
}

function runBuild(args) {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BUILD_SCRIPT, ...args],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }
  );
  if (res.error) throw res.error;
  return { status: res.status, stdout: String(res.stdout || ""), stderr: String(res.stderr || "") };
}

async function runPostSteps() {
  const steps = [];
  const gen = spawnSync("python", ["-X", "utf8", GEN_CATALOG], { encoding: "utf8", timeout: 60_000 });
  steps.push({ step: "gen-skill-catalog", ok: gen.status === 0, output: String(gen.stdout || gen.stderr || "").slice(-500) });
  const [routerPy, sub] = ROUTER_VERIFY;
  const ver = spawnSync("python", ["-X", "utf8", routerPy, sub], { encoding: "utf8", timeout: 60_000, cwd: "F:\\AI\\tools\\skill-router" });
  steps.push({ step: "router-verify", ok: ver.status === 0, output: String(ver.stdout || ver.stderr || "").slice(-500) });
  return steps;
}

async function snapshotFor(name) {
  const { roots } = await scanAll({ includeCustomRoots: false });
  const hub = roots[0].skills.find((s) => s.name === name);
  return {
    hubJunction: !!(hub?.linked),
    inHub: !!hub,
    loadable: hub?.loadable ?? false,
    zcode: hub?.agentLinks?.zcode ?? false,
    codex: hub?.agentLinks?.codex ?? false
  };
}

async function indexContains(name) {
  try {
    const idx = await readFile("F:\\AI\\skills\\hub\\INDEX.md", "utf8");
    return idx.includes(`\`${name}\``) || idx.includes(name);
  } catch { return null; }
}

// Agent junctions must always point at the hub, never at upstream (build script
// invariant). After an offline cycle the leftover agent junction is dangling or
// stale-pointing; build-skill-hub.ps1 only creates *missing* links and defers
// stale ones to repoint-agents-to-hub.ps1, which still carries legacy D:\ai-use
// paths. So repair here: rmdir the broken junction (link only) and mklink /J to
// the hub entry, then re-verify.
async function repairAgentJunction(name) {
  const want = join(HUB, name);
  const targets = [
    ["zcode", "F:\\AI\\agents\\zcode\\skills"],
    ["codex", join(homedir(), ".codex", "skills")]
  ];
  const actions = [];
  for (const [label, root] of targets) {
    const dest = join(root, name);
    let st = null;
    try { st = await lstat(dest); } catch {}
    if (!st) {
      const mk = spawnSync("cmd", ["/c", "mklink", "/J", dest, want], { encoding: "utf8" });
      actions.push({ root: label, action: mk.status === 0 ? "created" : "create-failed", detail: String(mk.stderr || mk.stdout || "").trim() });
      continue;
    }
    if (!st.isSymbolicLink()) { actions.push({ root: label, action: "skipped-real-dir" }); continue; }
    const cur = String(await readlink(dest).catch(() => "")); 
    if (cur.replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "") === want.toLowerCase()) continue;
    const rm = spawnSync("cmd", ["/c", "rmdir", dest], { encoding: "utf8" });
    if (rm.status !== 0) { actions.push({ root: label, action: "rmdir-failed", detail: String(rm.stderr || "").trim() }); continue; }
    const mk = spawnSync("cmd", ["/c", "mklink", "/J", dest, want], { encoding: "utf8" });
    actions.push({ root: label, action: mk.status === 0 ? "repointed" : "repoint-failed", detail: String(mk.stderr || mk.stdout || "").trim() });
  }
  return actions;
}

export async function setVisibility(name, online) {
  const S = await getSettings();
  if (!S.buildScript) {
    return { ok: false, error: "未配置构建脚本（buildScript）——本机没有 junction 管线时，请直接管理技能文件夹，或先在设置里配置 buildScript 路径", code: "error.build.notConfigured" };
  }
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { ok: false, error: `非法技能名: ${name}`, code: "error.name.invalid" };
  }
  if (!online && HARD_TRIGGER_SKILLS.has(name)) {
    return { ok: false, error: `「${name}」是四端硬触发技能，禁止下线`, code: "error.skill.protected" };
  }

  const before = await snapshotFor(name);
  const scriptState = await readScriptExcluded();
  const inScriptList = scriptState.names.includes(name);
  if (online && !inScriptList && !before.inHub) {
    return { ok: false, error: `上游与 hub 中均不存在「${name}」，无法上线`, code: "error.skill.missing" };
  }
  if (online === !inScriptList) {
    return { ok: true, changed: false, before, after: before, msg: "状态未变化" };
  }

  const nextNames = online ? scriptState.names.filter((n) => n !== name) : [...scriptState.names, name];
  await writeScriptExcluded(nextNames);
  // mirror to data/excluded.json for fast reads
  const stateExcluded = await readState("excluded");
  stateExcluded.names = nextNames;
  await writeState("excluded", stateExcluded);

  let build;
  try {
    build = runBuild(online ? ["-Apply", "-SyncAgents"] : ["-Apply"]);
  } catch (e) {
    // rollback the script edit so state stays consistent
    await writeScriptExcluded(scriptState.names);
    return { ok: false, error: `build 脚本执行失败: ${e.message}`, code: "error.build.failed" };
  }
  if (build.status !== 0) {
    await writeScriptExcluded(scriptState.names);
    runBuild(online ? ["-Apply"] : ["-Apply", "-SyncAgents"]).catch(() => {});
    await audit("visibility-rollback", { name, online, stdout: build.stdout.slice(-800) });
    return { ok: false, error: `build 脚本退出码 ${build.status}，已回滚名单`, code: "error.build.failed", output: build.stdout.slice(-2000) };
  }

  const after = await snapshotFor(name);
  const indexHas = await indexContains(name);

  // verify the expected filesystem outcome; on mismatch report honestly
  const problems = [];
  let repairs = [];
  if (online) {
    if (!after.hubJunction) problems.push("hub junction 未重建");
    if (!after.zcode) problems.push("zcode junction 未回填");
    if (!after.codex) problems.push("codex junction 未回填");
    if (problems.length > 0 && after.hubJunction) {
      // build created the hub link but left agent junctions stale/dangling:
      // repair them in place (junction-only, always pointing at the hub)
      repairs = await repairAgentJunction(name);
      const afterRepair = await snapshotFor(name);
      problems.length = 0;
      if (!afterRepair.hubJunction) problems.push("hub junction 未重建");
      if (!afterRepair.zcode) problems.push("zcode junction 未回填（修复后）");
      if (!afterRepair.codex) problems.push("codex junction 未回填（修复后）");
      if (problems.length === 0) {
        after.zcode = afterRepair.zcode;
        after.codex = afterRepair.codex;
      }
    }
  } else {
    if (after.hubJunction) problems.push("hub junction 仍存在");
    if (after.zcode) problems.push("zcode junction 仍存在");
    if (after.codex) problems.push("codex junction 仍存在");
  }

  const postSteps = problems.length === 0 ? await runPostSteps() : [];
  await audit("visibility", { name, online, before, after, problems, build: build.stdout.slice(-400) });

  return {
    ok: problems.length === 0,
    changed: true,
    name, online,
    before, after,
    repairs,
    indexStillLists: indexHas,
    problems,
    postSteps,
    buildTail: build.stdout.split("\n").slice(-12).join("\n")
  };
}
