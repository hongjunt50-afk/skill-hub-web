// Trash: two-stage deletion for writable skill roots (agents-dir inbox and
// custom scan roots). Hub skills are junction views — deleting those is
// "offline" (visibility), not trash. Move = atomic rename into data/trash.

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { readFile, rm, rename, readdir, mkdir, access } from "node:fs/promises";
import { parseSkillDoc, AGENTS_DIR } from "./scanner.js";
import { readState, writeState, audit } from "./state.js";

const TRASH_DIR = join(dirname(new URL(import.meta.url, "file://").pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "data", "trash");
const TRASH_INDEX = join(TRASH_DIR, "index.json");

const PROTECTED = new Set(["ponytail", "systematic-debugging", "verification-before-completion", "coding-hard-triggers"]);

function trashId(name, ts) { return `${name}@${ts}`; }
function parseTrashId(id) { const i = id.lastIndexOf("@"); return i > 0 ? { name: id.slice(0, i), ts: id.slice(i + 1) } : null; }

async function ensureTrashDir() { await mkdir(TRASH_DIR, { recursive: true }); }

async function readIndex() {
  try {
    const doc = JSON.parse(await readFile(TRASH_INDEX, "utf8"));
    if (Array.isArray(doc.items)) return doc;
  } catch {}
  return { items: [] };
}

async function writeIndex(doc) {
  await ensureTrashDir();
  const tmp = TRASH_INDEX + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await fs.rename(tmp, TRASH_INDEX);
}

// writable roots allowed for trash operations
export async function writableRoots(includeCustom = true) {
  const roots = [{ key: "agents-dir", path: AGENTS_DIR }];
  if (includeCustom) {
    const custom = await readState("customRoots");
    for (const p of custom.paths || []) roots.push({ key: `custom:${p}`, path: p });
  }
  return roots;
}

export async function moveToTrash(rootKey, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return { ok: false, error: `非法技能名: ${name}`, code: "error.name.invalid" };
  const roots = await writableRoots();
  const root = roots.find((r) => r.key === rootKey);
  if (!root) return { ok: false, error: `该来源不允许删除（hub 是共享 junction 视图，请用「下线」）`, code: "error.root.readonly" };
  const src = join(root.path, name);
  try { await access(src); } catch { return { ok: false, error: `技能目录不存在: ${src}`, code: "error.skill.notFound" }; }
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) return { ok: false, error: `拒绝移入回收站：${src} 是 junction（共享视图链接）`, code: "error.root.readonly" };

  await ensureTrashDir();
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // yyyyMMddHHmmss
  const id = trashId(name, ts);
  const dest = join(TRASH_DIR, id);
  await rename(src, dest);

  // capture a description preview for the trash list
  let description = "";
  try {
    const doc = parseSkillDoc(await readFile(join(dest, "SKILL.md"), "utf8"));
    description = String(doc.map.description || "").slice(0, 160);
  } catch {}

  const index = await readIndex();
  index.items.push({ id, name, fromRoot: rootKey, fromPath: src, deletedAt: new Date().toISOString(), description });
  await writeIndex(index);
  await audit("trash-move", { id, from: src });
  return { ok: true, id };
}

export async function listTrash() {
  const index = await readIndex();
  const items = [];
  for (const it of index.items) {
    let onDisk = false;
    try { await access(join(TRASH_DIR, it.id)); onDisk = true; } catch {}
    const ageDays = Math.floor((Date.now() - new Date(it.deletedAt).getTime()) / 86400000);
    items.push({ ...it, onDisk, ageDays, stale: ageDays > 30 });
  }
  // prune index entries whose folder vanished (manually deleted outside)
  const alive = index.items.filter((it) => items.find((x) => x.id === it.id)?.onDisk);
  if (alive.length !== index.items.length) await writeIndex({ items: alive });
  return { items: items.filter((x) => x.onDisk), trashDir: TRASH_DIR };
}

export async function restoreFromTrash(id) {
  const index = await readIndex();
  const item = index.items.find((x) => x.id === id);
  if (!item) return { ok: false, error: `回收站中不存在: ${id}`, code: "error.trash.notFound" };
  const src = join(TRASH_DIR, id);
  const roots = await writableRoots();
  const root = roots.find((r) => r.key === item.fromRoot) || { path: item.fromPath ? dirname(item.fromPath) : null, key: item.fromRoot };
  if (!root?.path) return { ok: false, error: "原始目录已不可用", code: "error.root.gone" };
  const dest = join(root.path, item.name);
  try { await access(dest); return { ok: false, error: `目标已存在同名技能: ${dest}`, code: "error.trash.conflict" }; } catch {}
  try { await rename(src, dest); } catch (e) { return { ok: false, error: `恢复失败: ${e.message}`, code: "error.trash.restore" }; }
  await writeIndex({ items: index.items.filter((x) => x.id !== id) });
  await audit("trash-restore", { id, to: dest });
  return { ok: true, restoredTo: dest };
}

export async function purgeTrash(id, { confirmName } = {}) {
  const index = await readIndex();
  const item = index.items.find((x) => x.id === id);
  if (!item) return { ok: false, error: `回收站中不存在: ${id}`, code: "error.trash.notFound" };
  if (PROTECTED.has(item.name)) return { ok: false, error: `「${item.name}」是四端硬触发技能，禁止彻底删除（只能恢复）`, code: "error.skill.protected" };
  if (confirmName !== item.name) return { ok: false, error: `二次确认失败：请输入技能名「${item.name}」`, code: "error.trash.confirm" };
  await rm(join(TRASH_DIR, id), { recursive: true, force: true });
  await writeIndex({ items: index.items.filter((x) => x.id !== id) });
  await audit("trash-purge", { id });
  return { ok: true, purged: id };
}
