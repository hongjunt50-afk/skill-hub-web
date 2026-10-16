<script setup>
import { ref } from "vue";

const props = defineProps({ skill: { type: Object, required: true }, categories: { type: Array, default: () => [] } });
const emit = defineEmits(["detail", "category", "visibility", "trash"]);

const open = ref(false);
const busy = ref(false);



async function changeCat(cat) {
  busy.value = true;
  emit("category", cat);
  busy.value = false;
}
</script>

<template>
  <div class="row" :class="{ open }">
    <button class="row-main" @click="open = !open; emit('detail')">
      <span class="row-arrow">{{ open ? "▾" : "▸" }}</span>
      <span class="row-name">{{ skill.declaredName }}</span>
      <span class="badge">{{ skill.sourceLabel }}</span>
      <span v-if="!skill.linked" class="badge">实体目录</span>
      <span v-if="skill.excluded" class="badge offline">已下线</span>
      <span v-if="skill.categorySource === 'manual'" class="badge manual">手动分类</span>
      <span class="row-desc muted">{{ skill.description.slice(0, 90) }}{{ skill.description.length > 90 ? "…" : "" }}</span>
    </button>
    <div v-if="open" class="row-body">
      <div class="triggers">
        <span class="muted">触发词</span>
        <pre>{{ skill.triggers || skill.description || "（无）" }}</pre>
      </div>
      <div class="chain">
        <span class="muted">来源</span>
        <code>{{ skill.upstreamPath || skill.path }}</code>
        <span v-if="skill.hubPath" class="chain-arrow">→ hub</span>
        <code v-if="skill.hubPath">{{ skill.hubPath }}</code>
        <span v-if="skill.rootKey === 'hub'" class="chain-arrow">→ agents</span>
        <code v-if="skill.rootKey === 'hub'" :class="{ miss: !skill.agentLinks?.zcode }">zcode{{ skill.agentLinks?.zcode ? "✓" : "✗" }}</code>
        <code v-if="skill.rootKey === 'hub'" :class="{ miss: !skill.agentLinks?.codex }">codex{{ skill.agentLinks?.codex ? "✓" : "✗" }}</code>
      </div>
      <div class="controls">
        <label class="muted">分类</label>
        <select :value="skill.category" :disabled="busy" @change="changeCat($event.target.value)">
          <option v-if="skill.categorySource === 'manual'" :value="skill.category">{{ skill.category }}（手动）</option>
          <option v-for="c in props.categories" :key="c" :value="c" :disabled="c === skill.category && skill.categorySource === 'auto'">{{ c }}</option>
          <option value="auto" :disabled="skill.categorySource === 'auto'">恢复自动</option>
        </select>
        <template v-if="skill.rootKey === 'hub' && skill.inPlan !== false">
          <button v-if="!skill.excluded" class="pill danger" @click="emit('visibility', false)">下线</button>
          <button v-if="skill.rootKey !== 'hub'" class="pill danger" @click="emit('trash')">删除</button>
          <button v-else class="pill primary" @click="emit('visibility', true)">上线</button>
        </template>
        <button class="pill" @click="emit('detail')">查看全文</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row { border: 1px solid var(--line); border-radius: var(--radius-sm); margin: 6px 4px; transition: box-shadow .15s ease; }
.row:hover { box-shadow: 0 2px 10px rgba(0,0,0,.06); }
.row-main {
  width: 100%; display: flex; align-items: center; gap: 8px; text-align: left;
  border: 0; border-radius: var(--radius-sm); padding: 9px 14px; background: var(--paper);
}
.row-main:hover { box-shadow: none; }
.row-arrow { color: var(--ink-3); width: 12px; }
.row-name { font-weight: 600; min-width: 170px; }
.row-desc { flex: 1; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-body { padding: 2px 16px 14px 34px; display: flex; flex-direction: column; gap: 10px; }
.triggers pre { margin: 4px 0 0; max-height: 220px; overflow-y: auto; }
.chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.chain code { font-size: 12px; background: var(--paper-2); border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; }
.chain code.miss { color: var(--err); }
.chain-arrow { color: var(--ink-3); font-size: 12px; }
.controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
