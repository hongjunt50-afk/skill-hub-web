<script setup>
import { ref, computed } from "vue";
import { api } from "../api.js";

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(["close", "toast", "changed"]);

const tab = ref("recommend");
const need = ref("");
const thinking = ref(false);
const result = ref(null);
const copied = ref("");

async function ask() {
  const q = need.value.trim();
  if (!q) return;
  thinking.value = true;
  result.value = null;
  try { result.value = await api.agentRecommend(q); }
  catch (e) { emit("toast", "Agent 出错: " + e.message); }
  thinking.value = false;
}

async function copyPrompt(text, name) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  copied.value = name;
  setTimeout(() => { copied.value = ""; }, 2000);
  emit("toast", `「${name}」的提示词已复制，可粘贴给工作 Agent`);
}

// rule maintenance
const maintBusy = ref(false);
const maintDiff = ref(null);
async function maintain(apply) {
  maintBusy.value = true;
  try {
    const r = await api.maintainRules(apply);
    if (r.message) emit("toast", r.message);
    else { maintDiff.value = r.diff; if (apply) { emit("toast", "规则已更新（" + (r.diff?.after?.length ?? 0) + " 条映射）"); maintDiff.value = null; } }
    if (apply) emit("changed");
  } catch (e) { emit("toast", "失败: " + e.message); }
  maintBusy.value = false;
}
</script>

<template>
  <div v-if="open" class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <div class="drawer-head">
        <strong>Agent 助手 <span class="muted" v-if="result">({{ result.channels.join(" + ") }}{{ result.degraded ? " · LLM 降级" : "" }})</span></strong>
        <button class="pill" @click="emit('close')">关闭</button>
      </div>

      <div class="tabs">
        <button :class="{ active: tab === 'recommend' }" @click="tab = 'recommend'">技能推荐</button>
        <button :class="{ active: tab === 'rules' }" @click="tab = 'rules'">规则维护</button>
      </div>

      <div v-if="tab === 'recommend'">
        <textarea v-model="need" rows="3" placeholder="用中文描述你的需求，例如：给项目做一个宣传视频 / 把长文章浓缩成摘要卡片…"></textarea>
        <button class="primary ask-btn" :disabled="thinking || !need.trim()" @click="ask">{{ thinking ? "Agent 思考中…" : "问 Agent" }}</button>

        <p v-if="result?.fallback" class="fallback">{{ result.fallback }}</p>
        <div v-for="rec in (result?.recommendations || [])" :key="rec.name" class="rec-card">
          <div class="rec-head">
            <strong>{{ rec.name }}</strong>
            <span class="badge">{{ rec.sourceLabel }}</span>
            <span class="badge" v-if="rec.channel === 'llm'">AI</span>
            <span class="badge" v-if="rec.channel === 'matrix'">矩阵裁决</span>
          </div>
          <p class="rec-reason">{{ rec.reason }}</p>
          <p class="rec-triggers muted" v-if="rec.triggers">触发：{{ rec.triggers.slice(0, 140) }}</p>
          <button class="pill" @click="copyPrompt(rec.promptText, rec.name)">
            {{ copied === rec.name ? "✓ 已复制" : "复制提示词给工作 Agent" }}
          </button>
        </div>
      </div>

      <div v-if="tab === 'rules'">
        <p class="muted">Agent 每次智能搜索都会记录「中文需求 → 命中技能」。稳定命中的映射可固化为离线规则，之后同样的查询不再需要 LLM。</p>
        <button class="primary" :disabled="maintBusy" @click="maintain(false)">{{ maintBusy ? "分析中…" : "生成规则优化建议" }}</button>
        <div v-if="maintDiff" class="diff">
          <h4>建议后的规则（{{ maintDiff.after.length }} 条）</h4>
          <pre>{{ JSON.stringify(maintDiff.after, null, 1).slice(0, 2500) }}</pre>
          <div class="diff-actions">
            <button class="primary" :disabled="maintBusy" @click="maintain(true)">确认应用</button>
            <button @click="maintDiff = null">放弃</button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
textarea { width: 100%; font: inherit; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 10px 12px; resize: vertical; }
.ask-btn { margin: 10px 0; width: 100%; }
.tabs { display: flex; gap: 8px; margin: 10px 0; }
.tabs button { border-radius: 999px; }
.tabs button.active { background: var(--ink); color: #fff; border-color: var(--ink); }
.rec-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; margin: 10px 0; }
.rec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rec-reason { margin: 6px 0 4px; }
.rec-triggers { margin: 0 0 10px; }
.fallback { background: var(--paper-2); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 14px; }
.diff pre { max-height: 300px; overflow-y: auto; }
.diff-actions { display: flex; gap: 10px; margin-top: 10px; }
</style>
