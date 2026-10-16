// Unified LLM client: single-flight queue, throttle, timeout, one retry,
// graceful degradation. Credentials come from the settings layer
// (data/settings.json editable in the web UI, with server/.env as fallback).

import { getSettings, invalidateSettings } from "./settings.js";

let cfg = null;
async function loadCfg() {
  if (cfg) return cfg;
  const s = await getSettings();
  cfg = { baseUrl: s.llmBaseUrl, apiKey: s.llmApiKey, model: s.llmModel };
  cfg.available = !!(cfg.baseUrl && cfg.apiKey && cfg.model);
  return cfg;
}
export function invalidateLlmCfg() { cfg = null; }

export async function llmAvailable() {
  return (await loadCfg()).available === true;
}

// single-flight queue with 2s throttle between calls
let chain = Promise.resolve();
let lastStart = 0;

async function enqueue(fn) {
  const run = chain.then(async () => {
    const gap = Date.now() - lastStart;
    if (gap < 2000) await new Promise((r) => setTimeout(r, 2000 - gap));
    lastStart = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

// deepseek-v4.1-flash is a reasoning model: needs headroom for reasoning_content
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 90_000;

async function callOnce(messages, { temperature = 0.3, jsonMode = false } = {}) {
  const c = await loadCfg();
  const body = { model: c.model, messages, max_tokens: MAX_TOKENS, temperature };
  if (jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(c.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const doc = await res.json().catch(() => { throw new Error(`LLM HTTP ${res.status}: non-JSON body`); });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${JSON.stringify(doc.error || doc).slice(0, 300)}`);
  const msg = doc.choices?.[0]?.message;
  const content = String(msg?.content || "").trim();
  if (!content) throw new Error("LLM returned empty content");
  return content;
}

export async function llmChat(messages, opts = {}) {
  if (!(await llmAvailable())) throw new Error("LLM_NOT_CONFIGURED");
  return enqueue(async () => {
    try { return await callOnce(messages, opts); }
    catch (e) {
      if (e.message === "LLM_NOT_CONFIGURED") throw e;
      // one retry, then surface the failure for caller-side degradation
      return await callOnce(messages, opts);
    }
  });
}

export async function llmJson(messages, opts = {}) {
  const text = await llmChat(messages, { ...opts, jsonMode: true });
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("LLM reply contains no JSON object");
  return JSON.parse(m[0]);
}
