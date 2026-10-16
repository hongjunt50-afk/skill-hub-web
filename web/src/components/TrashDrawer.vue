<script setup>
import { ref } from "vue";
import { api } from "../api.js";

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(["close", "toast", "changed"]);

const items = ref(null);
const loaded = ref(false);
const confirmPurge = ref(null); // {id, name, input:""}
const busy = ref(false);

async function load() {
  items.value = (await api.trash()).items;
  loaded.value = true;
}
async function restore(id) {
  busy.value = true;
  try {
    await api.restoreTrash(id);
    emit("toast", "已恢复到原位置");
    emit("changed");
    await load();
  } catch (e) { emit("toast", "恢复失败: " + e.message); }
  busy.value = false;
}
async function purge() {
  if (!confirmPurge.value) return;
  busy.value = true;
  try {
    await api.purgeTrash(confirmPurge.value.id, confirmPurge.value.input);
    emit("toast", "已彻底删除");
    confirmPurge.value = null;
    emit("changed");
    await load();
  } catch (e) { emit("toast", "删除失败: " + e.message); }
  busy.value = false;
}
defineExpose({ load });
</script>

<template>
  <div v-if="open" class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <div class="drawer-head">
        <strong>回收站 <span class="muted" v-if="items">({{ items.length }})</span></strong>
        <button class="pill" @click="emit('close')">关闭</button>
      </div>
      <p class="muted">删除的技能先进回收站（原样保留），恢复即可找回；只有在这里再次确认才会彻底删除。Hub 共享技能是 junction 视图，不进回收站——用「下线」控制可见性。超过 30 天的条目会标黄提醒（不自动清理）。</p>
      <p v-if="loaded && !items.length" class="muted">（回收站是空的）</p>
      <div v-for="it in (items || [])" :key="it.id" class="trash-card" :class="{ stale: it.stale }">
        <div class="rec-head">
          <strong>{{ it.name }}</strong>
          <span class="badge" v-if="it.stale">超过 30 天</span>
          <span class="muted">{{ it.deletedAt.slice(0, 10) }}</span>
        </div>
        <p class="muted" v-if="it.description">{{ it.description.slice(0, 120) }}</p>
        <p class="muted">原位置：{{ it.fromPath }}</p>
        <div class="actions" v-if="confirmPurge?.id !== it.id">
          <button class="pill" :disabled="busy" @click="restore(it.id)">恢复</button>
          <button class="pill danger" :disabled="busy" @click="confirmPurge = { id: it.id, name: it.name, input: '' }">彻底删除…</button>
        </div>
        <div class="actions purge" v-else>
          <span class="muted">输入技能名确认：</span>
          <input v-model="confirmPurge.input" type="text" :placeholder="it.name" />
          <button class="pill danger" :disabled="busy || confirmPurge.input !== it.name" @click="purge">确认彻底删除</button>
          <button class="pill" @click="confirmPurge = null">取消</button>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.trash-card { border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 16px; margin: 10px 0; }
.trash-card.stale { border-color: #f3e2c8; background: #fffaf3; }
.rec-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.actions input { flex: 1; min-width: 140px; }
</style>
