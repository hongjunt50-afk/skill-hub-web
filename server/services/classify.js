// Functional auto-classification. Keyword rules over name + description;
// manual overrides (state) take precedence at the scanner level.
//
// The base 11 categories are built-in; the user can add custom category names
// at runtime (stored in data/categories.json via /api/categories). Auto rules
// only ever pick built-in categories; custom ones are assigned manually.

import { readState } from "./state.js";

export const BUILTIN_CATEGORIES = [
  "视频/动画", "图像/设计", "音频/语音", "代码/开发", "文档/写作",
  "知识库/记忆", "搜索/信息", "媒体素材", "自动化/工作流", "系统/环境", "其它/未分类"
];
export const UNCLASSIFIED = "其它/未分类";
export const PROTECTED_CATEGORIES = new Set([UNCLASSIFIED]);

// synchronously usable variant for hot paths (built-ins only)
const RULES = [
  ["视频/动画", ["video", "视频", "animation", "动画", "motion", "remotion", "slideshow", "hyperframes", "剪辑", "成片", "footage", "kinetic", "film", "影片", "montage", "storyboard", "分镜", "lottie", "转场"]],
  ["图像/设计", ["image", "图像", "图片", "photo", "设计", "logo", "icon", "图标", "poster", "海报", "photon", "figma", "vector", "矢量", "mockup", "photoshop", "修图", "配色", "palette", "impeccable", "frontend", "前端", "css", "tailwind", "landing page", "落地页", "illustration", "插画", "svg", "diagram", "图表"]],
  ["音频/语音", ["audio", "音频", "music", "音乐", "voice", "配音", "speech", "tts", "语音", "song", "bgm", "sfx", "sound", "podcast", "播客", "audiocraft", "混音", "音效"]],
  ["代码/开发", ["code", "代码", "coding", "debug", "调试", "refactor", "重构", "test", "测试", "git", "repo", "api", "sdk", "cli", "dev", "programming", "开发", "脚本", "script", "deploy", "部署", "docker", "server", "服务", "review", "审查", "security", "安全", "reverse", "逆向", "compiler", "编译", "database", "数据库", "sql", "性能", "performance", "优化", "algorithm", "算法", "python", "typescript", "rust", "unity", "android", "ios", "windows", "linux"]],
  ["文档/写作", ["doc", "文档", "writing", "写作", "cv", "简历", "resume", "report", "报告", "ppt", "presentation", "演示", "pdf", "excel", "xlsx", "word", "docx", "slide", "论文", "paper", "latex", "summarize", "总结", "翻译", "translate", "comic", "漫画", "小说", "novel", "blog", "博客", "copywriting", "文案", "邮件", "email", "newsletter"]],
  ["知识库/记忆", ["knowledge", "知识库", "memory", "记忆", "kb", "retrieval", "检索", "note", "笔记", "zk", "obsidian", "distill", "蒸馏"]],
  ["搜索/信息", ["search", "搜索", "find", "查找", "lookup", "news", "新闻", "research", "调研", "scrape", "爬", "crawl", "fetch", "browse", "web", "网页", "extract", "提取", "scraping"]],
  ["媒体素材", ["stock", "素材", "asset", "下载", "download", "pexels", "pixabay", "音效包", "sample", "采样", "素材库", "wallpaper", "壁纸"]],
  ["自动化/工作流", ["workflow", "工作流", "automation", "自动化", "schedule", "定时", "agent", "代理", "pipeline", "orchestrate", "cron", "relay", "接力", "hook", "mcp", "prompt", "提示词", "路由", "router", "browser-use", "computer use", "gui", "桌面控制", "desktop"]],
  ["系统/环境", ["system", "系统", "env", "环境", "install", "安装", "setup", "配置", "config", "shell", "终端", "terminal", "file", "文件", "disk", "磁盘", "permission", "权限", "backup", "备份", "update", "更新", "version", "版本", "password", "密码", "secret", "密钥", "credential", "凭证", "1password", "reminder", "提醒", "calendar", "日历", "weather", "天气", "travel", "旅行", "finance", "金融", "股票"]]
];

export function classifyAuto(name, description) {
  const hay = `${name} ${description}`.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [category, keywords] of RULES) {
    let score = 0;
    for (const kw of keywords) if (hay.includes(kw)) score += kw.length > 3 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = category; }
  }
  return best || UNCLASSIFIED;
}

// ---- dynamic category list (built-ins + user-added) ----

export async function listCategories() {
  const doc = await readState("categories");
  const custom = (doc.names || []).filter((n) => typeof n === "string" && n.trim());
  return [...BUILTIN_CATEGORIES, ...custom.filter((n) => !BUILTIN_CATEGORIES.includes(n))];
}

export async function addCategory(name) {
  const clean = String(name || "").trim();
  if (!clean || clean.length > 40) return { ok: false, error: `非法分类名: ${clean}`, code: "error.category.invalid" };
  const doc = await readState("categories");
  doc.names ??= [];
  const all = await listCategories();
  if (all.includes(clean)) return { ok: true, added: false, categories: all };
  doc.names.push(clean);
  await (await import("./state.js")).writeState("categories", doc);
  return { ok: true, added: true, categories: await listCategories() };
}

export async function removeCategory(name) {
  if (PROTECTED_CATEGORIES.has(name) || BUILTIN_CATEGORIES.includes(name)) {
    return { ok: false, error: `内置分类不可删除: ${name}`, code: "error.category.builtin" };
  }
  const doc = await readState("categories");
  doc.names ??= [];
  const before = doc.names.length;
  doc.names = doc.names.filter((n) => n !== name);
  if (doc.names.length === before) return { ok: false, error: `未登记的自定义分类: ${name}`, code: "error.category.unknown" };
  await (await import("./state.js")).writeState("categories", doc);
  // skills manually assigned to this category fall back to auto
  const ov = await readState("overrides");
  let reverted = 0;
  for (const [key, cat] of Object.entries(ov.manual || {})) {
    if (cat === name) { delete ov.manual[key]; reverted++; }
  }
  if (reverted > 0) await (await import("./state.js")).writeState("overrides", ov);
  return { ok: true, removed: name, reverted };
}
