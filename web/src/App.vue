<script setup>
import { ref, computed, onMounted } from "vue";
import { api } from "./api.js";
import SkillRow from "./components/SkillRow.vue";
import AgentDrawer from "./components/AgentDrawer.vue";
import TrashDrawer from "./components/TrashDrawer.vue";
import SettingsDrawer from "./components/SettingsDrawer.vue";

const skills = ref(null);
const status = ref(null);
const error = ref("");
const query = ref("");
const sourceFilter = ref("");
const catFilter = ref("");
const expandedCats = ref(new Set());
const detail = ref(null);
const detailLoading = ref(false);
const toast = ref("");
const allCategories = ref([]);

// agent assistant + trash
const showAgent = ref(false);
const agentDrawer = ref(null);
const showTrash = ref(false);
const trashDrawer = ref(null);
const showSettings = ref(false);
const settingsDrawer = ref(null);

// category manager
const showCatMgr = ref(false);
const newCatName = ref("");
const catMgrBusy = ref(false);

// folder picker
const showRootPicker = ref(false);
const browse = ref(null);
const browseBusy = ref(false);
const pickedPath = ref("");

const SOURCES = ["自研", "Hermes·内置", "Hermes·运行期", "Hermes·可选池", "Codex·系统", "Codex", "Agents 目录", "Unity 五件套", "知识缓存", "归档区", "其它来源"];

async function load() {
  error.value = "";
  try {
    const params = {};
    if (query.value) params.query = query.value;
    if (sourceFilter.value) params.source = sourceFilter.value;
    if (catFilter.value) params.category = catFilter.value;
    skills.value = await api.skills(params);
    if (!catFilter.value && expandedCats.value.size === 0) {
      for (const c of skills.value.categories) expandedCats.value.add(c.name);
    }
  } catch (e) { error.value = e.message; }
}
async function loadStatus() {
  try { status.value = await api.status(); } catch { status.value = null; }
}
async function loadCategories() {
  try { allCategories.value = (await api.categories()).categories; } catch {}
}
function showToast(msg) {
  toast.value = msg;
  setTimeout(() => { toast.value = ""; }, 6000);
}
function toggleCat(name) {
  if (expandedCats.value.has(name)) expandedCats.value.delete(name);
  else expandedCats.value.add(name);
}
async function openDetail(s) {
  detailLoading.value = true;
  detail.value = { name: s.name, loading: true };
  try { detail.value = await api.detail(s.rootKey, s.name); }
  catch (e) { detail.value = { name: s.name, error: e.message }; }
  detailLoading.value = false;
}
async function onCategoryChange(s, cat) {
  try {
    await api.setCategory(s.rootKey, s.name, cat);
    showToast(`「${s.name}」分类已${cat === "auto" ? "恢复自动" : "改为 " + cat}`);
    await load();
  } catch (e) { showToast("失败: " + e.message); }
}
async function onVisibility(s, online) {
  const action = online ? "上线" : "下线";
  const what = online
    ? `将重建 hub junction，并回填 zcode / codex 两个 Agent 目录的 junction，重建索引`
    : `将从 hub 与 zcode / codex 两个 Agent 目录移除 junction（上游文件不动），重建索引`;
  if (!confirm(`确认${action}「${s.name}」？\n\n${what}`)) return;
  try {
    const r = await api.setVisibility(s.name, online);
    if (r.ok) showToast(`「${s.name}」已${action}`);
    else showToast(`「${s.name}」${action}后存在问题: ${(r.problems || []).join("；")}`);
    await Promise.all([load(), loadStatus()]);
  } catch (e) { showToast("失败: " + e.message); }
}

// ---- category manager ----
async function openCatMgr() {
  showCatMgr.value = true;
  await loadCategories();
}
async function addCategory() {
  const name = newCatName.value.trim();
  if (!name) return;
  catMgrBusy.value = true;
  try {
    const r = await api.addCategory(name);
    showToast(r.added ? `分类「${name}」已添加` : `分类「${name}」已存在`);
    newCatName.value = "";
    await loadCategories();
  } catch (e) { showToast("失败: " + e.message); }
  catMgrBusy.value = false;
}
async function removeCategory(name) {
  if (!confirm(`删除分类「${name}」？其中手动归类的技能将恢复自动分类。`)) return;
  catMgrBusy.value = true;
  try {
    const r = await api.removeCategory(name);
    showToast(`分类「${name}」已删除，${r.reverted} 个技能恢复自动`);
    catFilter.value = catFilter.value === name ? "" : catFilter.value;
    await Promise.all([loadCategories(), load()]);
  } catch (e) { showToast("失败: " + e.message); }
  catMgrBusy.value = false;
}
const customCategories = computed(() =>
  (allCategories.value || []).filter((c) => !["视频/动画", "图像/设计", "音频/语音", "代码/开发", "文档/写作", "知识库/记忆", "搜索/信息", "媒体素材", "自动化/工作流", "系统/环境", "其它/未分类"].includes(c)));

// ---- folder picker ----
async function openRootPicker() {
  showRootPicker.value = true;
  await browseTo("");
}
function openSettings() {
  showSettings.value = true;
  settingsDrawer.value?.load();
}
async function openTrash() {
  showTrash.value = true;
  trashDrawer.value?.load();
}
async function onTrash(s) {
  if (!confirm(`将技能「${s.name}」移入回收站？原样保留，可在回收站恢复或彻底删除。`)) return;
  try {
    await api.trashSkill(s.rootKey, s.name);
    showToast(`「${s.name}」已移入回收站`);
    await Promise.all([load(), loadStatus()]);
  } catch (e) { showToast("失败: " + e.message); }
}
function onTrashChanged() {
  load();
  loadStatus();
}
async function browseTo(path) {
  browseBusy.value = true;
  try { browse.value = await api.browse(path); }
  catch (e) { showToast("浏览失败: " + e.message); }
  browseBusy.value = false;
}
function pickDir(path) {
  pickedPath.value = path;
  browseTo(path);
}
async function confirmAddRoot() {
  const path = pickedPath.value || browse.value?.path;
  if (!path) return;
  browseBusy.value = true;
  try {
    const r = await api.addRoot(path);
    showToast(r.added ? `扫描目录已添加: ${path}` : "该目录已在扫描清单中");
    showRootPicker.value = false;
  } catch (e) { showToast("失败: " + e.message); }
  browseBusy.value = false;
}

const statusWarnings = computed(() => status.value?.warnings || []);

onMounted(() => { load(); loadStatus(); loadCategories(); });
</script>

<template>
  <div class="layout">
    <header class="topbar">
      <div class="brand">
        <strong>技能控制管理</strong>
        <span v-if="skills" class="muted">{{ skills.counts.hub }} hub · {{ skills.counts.agentsDir }} 收件箱</span>
      </div>
      <input v-model="query" type="text" class="search" placeholder="搜索技能名 / 描述 / 触发词…" @input="load" />
      <select v-model="sourceFilter" @change="load">
        <option value="">全部来源</option>
        <option v-for="s in SOURCES" :key="s" :value="s">{{ s }}</option>
      </select>
      <select v-model="catFilter" @change="load">
        <option value="">全部分类</option>
        <option v-for="c in allCategories" :key="c" :value="c">{{ c }}</option>
      </select>
      <button class="pill" @click="openCatMgr">分类管理</button>
      <button class="pill" @click="openRootPicker">添加扫描目录</button>
      <button class="pill" @click="showAgent = true">Agent 助手</button>
      <button class="pill" @click="openTrash">回收站</button>
      <button class="pill" @click="openSettings">设置</button>
    </header>

    <div v-if="statusWarnings.length" class="warnings">
      <div v-for="w in statusWarnings" :key="w.key" class="warn-item">
        ⚠ {{ w.message }}
      </div>
    </div>

    <p v-if="error" class="err">加载失败: {{ error }}</p>
    <p v-if="!skills && !error" class="muted">加载中…</p>

    <main v-if="skills" class="list">
      <section v-for="cat in skills.categories" :key="cat.name" class="cat">
        <button class="cat-head" @click="toggleCat(cat.name)">
          <span class="cat-arrow">{{ expandedCats.has(cat.name) ? "▾" : "▸" }}</span>
          <strong>{{ cat.name }}</strong>
          <span class="muted">{{ cat.count }}</span>
        </button>
        <div v-if="expandedCats.has(cat.name)" class="cat-body">
          <SkillRow
            v-for="s in cat.skills" :key="s.rootKey + '/' + s.name" :skill="s" :categories="allCategories"
            @detail="openDetail(s)"
            @category="onCategoryChange(s, $event)"
            @visibility="onVisibility(s, $event)"
            @trash="onTrash(s)"
          />
        </div>
      </section>
    </main>

    <!-- 详情抽屉 -->
    <div v-if="detail" class="drawer-mask" @click.self="detail = null">
      <aside class="drawer">
        <div class="drawer-head">
          <strong>{{ detail.name }}</strong>
          <button class="pill" @click="detail = null">关闭</button>
        </div>
        <p v-if="detail.error" class="err">{{ detail.error }}</p>
        <p v-if="detail.loading" class="muted">加载中…</p>
        <template v-if="detail.body">
          <div class="chain">
            <div class="chain-row"><span class="badge dark">本体</span><code>{{ detail.upstreamPath || detail.path }}</code></div>
            <div class="chain-row" v-if="detail.hubPath"><span class="badge">Hub</span><code>{{ detail.hubPath }}</code></div>
            <div class="chain-row" v-if="detail.rootKey === 'hub'">
              <span class="badge">Agent</span>
              <code :class="{ miss: !detail.agentLinks?.zcode }">F:\AI\agents\zcode\skills\{{ detail.name }}</code>
              <code :class="{ miss: !detail.agentLinks?.codex }">…\.codex\skills\{{ detail.name }}</code>
            </div>
          </div>
          <h4>触发词</h4>
          <pre>{{ detail.triggers || detail.description || "（无）" }}</pre>
          <h4>SKILL.md 全文</h4>
          <pre>{{ detail.body }}</pre>
        </template>
      </aside>
    </div>

    <!-- 分类管理 -->
    <div v-if="showCatMgr" class="drawer-mask" @click.self="showCatMgr = false">
      <aside class="drawer">
        <div class="drawer-head">
          <strong>分类管理</strong>
          <button class="pill" @click="showCatMgr = false">关闭</button>
        </div>
        <div class="catmgr-add">
          <input v-model="newCatName" type="text" placeholder="新分类名称…" @keyup.enter="addCategory" />
          <button class="primary" :disabled="catMgrBusy || !newCatName.trim()" @click="addCategory">添加分类</button>
        </div>
        <p class="muted">自定义分类可通过技能行的「分类」下拉手动归类；删除自定义分类时，其中手动归类的技能恢复自动分类。内置分类不可删除。</p>
        <h4>自定义分类</h4>
        <div class="catmgr-list">
          <span v-for="c in customCategories" :key="c" class="catmgr-item">
            {{ c }}
            <button class="pill danger" :disabled="catMgrBusy" @click="removeCategory(c)">删除</button>
          </span>
          <span v-if="!customCategories.length" class="muted">（暂无自定义分类）</span>
        </div>
        <h4>内置分类（{{ allCategories.length - customCategories.length }}）</h4>
        <div class="catmgr-list">
          <span v-for="c in allCategories" :key="'b-' + c" class="badge" v-show="!customCategories.includes(c)">{{ c }}</span>
        </div>
      </aside>
    </div>

    <!-- 添加扫描目录（文件夹选择器） -->
    <div v-if="showRootPicker" class="drawer-mask" @click.self="showRootPicker = false">
      <aside class="drawer drawer-narrow">
        <div class="drawer-head">
          <strong>添加扫描目录</strong>
          <button class="pill" @click="showRootPicker = false">取消</button>
        </div>
        <div class="picker-shortcuts" v-if="browse">
          <button v-for="sc in browse.shortcuts" :key="sc.path" class="pill" @click="pickDir(sc.path)">{{ sc.label }}</button>
        </div>
        <div class="picker-path">
          <input v-model="pickedPath" type="text" placeholder="F:\\path\\to\\skills" />
          <button class="pill" @click="browseTo(pickedPath)">转到</button>
          <button class="primary" :disabled="browseBusy || !(pickedPath || browse?.path)" @click="confirmAddRoot">添加此目录</button>
        </div>
        <p v-if="browse" class="muted">当前: {{ browse.path }}</p>
        <div class="picker-list" v-if="browse">
          <button v-if="browse.parent" class="picker-item" @click="pickDir(browse.parent)">↑ 上一级</button>
          <button v-for="d in browse.directories" :key="d.name" class="picker-item" @click="pickDir(browse.path + '\\' + d.name)">
            📁 {{ d.name }}<span v-if="d.link" class="muted">（junction）</span>
          </button>
          <p v-if="!browse.directories.length" class="muted">（无子目录）</p>
        </div>
      </aside>
    </div>

    <SettingsDrawer ref="settingsDrawer" :open="showSettings" @close="showSettings = false" @toast="showToast" />
    <AgentDrawer :open="showAgent" @close="showAgent = false" @toast="showToast" @changed="load" />
    <TrashDrawer ref="trashDrawer" :open="showTrash" @close="showTrash = false" @toast="showToast" @changed="onTrashChanged" />

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.layout { max-width: 980px; margin: 0 auto; padding: 18px 20px 60px; }
.topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 6px 0 14px; border-bottom: 1px solid var(--line); }
.brand { display: flex; flex-direction: column; min-width: 150px; }
.search { flex: 1; min-width: 220px; }
.warnings { margin: 10px 0; display: flex; flex-direction: column; gap: 6px; }
.warn-item { color: var(--warn); font-size: 12.5px; background: #fffaf3; border: 1px solid #f3e2c8; border-radius: var(--radius-sm); padding: 6px 12px; }
.err { color: var(--err); }
.list { margin-top: 16px; display: flex; flex-direction: column; gap: 14px; }
.cat { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.cat-head {
  width: 100%; display: flex; align-items: center; gap: 10px;
  border: 0; border-radius: 0; padding: 12px 18px; background: var(--paper-2);
  font-size: 15px; text-align: left;
}
.cat-head:hover { box-shadow: none; background: #f2f2f2; }
.cat-body { padding: 6px 10px 10px; }
.cat-arrow { color: var(--ink-3); }
.drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.28); display: flex; justify-content: flex-end; z-index: 40; }
.drawer {
  width: min(680px, 92vw); background: var(--paper); height: 100%;
  overflow-y: auto; padding: 20px 24px 40px; border-radius: 18px 0 0 0;
}
.drawer-head { display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; background: var(--paper); padding: 4px 0 10px; }
.chain { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 4px; }
.chain-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.chain-row code { font-size: 12px; background: var(--paper-2); border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; }
.chain-row code.miss { color: var(--err); text-decoration: line-through; }
h4 { margin: 18px 0 6px; }
.toast {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  background: var(--ink); color: #fff; border-radius: 999px; padding: 8px 22px;
  box-shadow: 0 6px 24px rgba(0,0,0,.25); z-index: 60;
}
.drawer-narrow { width: min(520px, 92vw); }
.catmgr-add { display: flex; gap: 10px; margin: 8px 0; }
.catmgr-add input { flex: 1; }
.catmgr-list { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.catmgr-item { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 6px 3px 14px; }
.picker-shortcuts { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.picker-path { display: flex; gap: 8px; margin: 10px 0; }
.picker-path input { flex: 1; }
.picker-list { display: flex; flex-direction: column; gap: 4px; max-height: 46vh; overflow-y: auto; margin-top: 6px; }
.picker-item {
  text-align: left; border-radius: var(--radius-sm); padding: 8px 14px;
  border: 1px solid var(--line); background: var(--paper);
}
.picker-item:hover { box-shadow: 0 2px 8px rgba(0,0,0,.08); }
</style>
