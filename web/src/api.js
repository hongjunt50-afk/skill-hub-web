const j = (r) => r.json().then((d) => { if (!r.ok || d.code !== 0) throw new Error(d.msg || `HTTP ${r.status}`); return d.data; });

async function req(url, opts) {
  const r = await fetch(url, opts);
  return j(r);
}

export const api = {
  skills: (params = {}) => req(`/api/skills?${new URLSearchParams(params)}`),
  detail: (rootKey, name) => req(`/api/skills/${encodeURIComponent(rootKey)}/${encodeURIComponent(name)}`),
  setCategory: (rootKey, name, category) => req(`/api/skills/${encodeURIComponent(rootKey)}/${encodeURIComponent(name)}/category`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category })
  }),
  setVisibility: (name, online) => req(`/api/skills/${encodeURIComponent(name)}/visibility`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ online })
  }),
  trashSkill: (rootKey, name) => req(`/api/skills/${encodeURIComponent(rootKey)}/${encodeURIComponent(name)}/trash`, { method: "POST" }),
  trash: () => req("/api/trash"),
  restoreTrash: (id) => req(`/api/trash/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  purgeTrash: (id, confirmName) => req(`/api/trash/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmName }) }),
  agentRecommend: (q) => req("/api/agent/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q }) }),
  maintainRules: (apply) => req("/api/agent/maintain-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apply }) }),
  getSettings: () => req("/api/settings"),
  saveSettings: (patch) => req("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
  testLlm: () => req("/api/agent/test-llm", { method: "POST" }),
  status: () => req("/api/status"),
  categories: () => req("/api/categories"),
  addCategory: (name) => req("/api/categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
  removeCategory: (name) => req(`/api/categories/${encodeURIComponent(name)}`, { method: "DELETE" }),
  browse: (path) => req(`/api/browse?path=${encodeURIComponent(path || "")}`),
  roots: () => req("/api/roots"),
  addRoot: (path) => req("/api/roots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) }),
  removeRoot: (path) => req(`/api/roots?path=${encodeURIComponent(path)}`, { method: "DELETE" })
};
