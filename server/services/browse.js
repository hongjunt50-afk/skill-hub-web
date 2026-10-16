// Browse server-side directories for the "add scan folder" picker.
// Security: only lists directories, never files; refuses to descend into
// junctions to avoid cycles; no path escapes beyond what the user explicitly
// picks (the picked path still must pass the absolute-path validation in /roots).

import { promises as fs } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

export async function browseDirectories(inputPath) {
  let target = String(inputPath || "").trim();
  if (!target) target = "F:\\";
  target = resolve(target);
  let st;
  try { st = await fs.lstat(target); } catch { return { ok: false, error: `路径不存在: ${target}`, code: "error.path.missing" }; }
  if (!st.isDirectory()) {
    target = dirname(target);
  }
  let entries = [];
  try { entries = await fs.readdir(target, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: `无法读取目录: ${e.message}`, code: "error.path.read" }; }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    // junctions are listed but not descended into (no cycle risk here since we only list one level)
    dirs.push({ name: e.name, link: e.isSymbolicLink() });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(target);
  const home = homedir();
  return {
    ok: true,
    path: target,
    parent: parent === target ? null : parent,
    shortcuts: [
      { label: "F:\\AI\\skills", path: "F:\\AI\\skills" },
      { label: "F:\\AI", path: "F:\\AI" },
      { label: "用户目录", path: home },
      { label: "F:\\", path: "F:\\" }
    ],
    directories: dirs.slice(0, 500)
  };
}
