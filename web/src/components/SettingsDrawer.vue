<script setup>
import { ref } from "vue";
import { api } from "../api.js";

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(["close", "toast"]);

const form = ref(null);
const busy = ref(false);
const testing = ref(false);
const testResult = ref(null);

async function load() {
  form.value = await api.getSettings();
}
async function save() {
  busy.value = true;
  try {
    form.value = await api.saveSettings(form.value);
    emit("toast", "设置已保存（立即生效）");
  } catch (e) { emit("toast", "保存失败: " + e.message); }
  busy.value = false;
}
async function testLlm() {
  testing.value = true;
  testResult.value = null;
  try {
    await api.saveSettings(form.value);
    const r = await api.testLlm();
    testResult.value = { ok: true, text: `连通正常，模型回复：${r.reply}` };
  } catch (e) { testResult.value = { ok: false, text: e.message }; }
  testing.value = false;
}
function resetLlm() {
  form.value.llmBaseUrl = "";
  form.value.llmApiKey = "";
  form.value.llmModel = "";
}
defineExpose({ load });
</script>

<template>
  <div v-if="open" class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <div class="drawer-head">
        <strong>设置</strong>
        <button class="pill" @click="emit('close')">关闭</button>
      </div>

      <div v-if="form">
        <h4>LLM（内置 Agent 引擎）</h4>
        <p class="muted">任意 OpenAI 兼容 chat 端点均可。留空 = 内置 Agent 走纯规则模式。密钥保存在本机 server/data/settings.json，不会上传。</p>
        <label>API Base URL</label>
        <input v-model="form.llmBaseUrl" type="text" placeholder="https://api.example.com/v1" />
        <label>API Key</label>
        <input v-model="form.llmApiKey" type="text" :placeholder="form.llmKeySet ? `已保存：${form.llmApiKey}（留空保持不变）` : 'sk-...'" />
        <label>模型名</label>
        <input v-model="form.llmModel" type="text" placeholder="例如 deepseek-v4.1-flash / gpt-4o-mini" />
        <div class="row">
          <button class="primary" :disabled="busy" @click="save">保存设置</button>
          <button :disabled="testing" @click="testLlm">{{ testing ? "测试中…" : "保存并测试连通" }}</button>
          <button class="danger" @click="resetLlm">清空（纯规则模式）</button>
        </div>
        <p v-if="testResult" :class="testResult.ok ? 'ok-msg' : 'err'">{{ testResult.text }}</p>

        <h4>技能目录路径</h4>
        <p class="muted">留空使用默认值（~/.skill-hub-web/hub、~/.agents/skills、~/.codex/skills）。本机有 junction 聚合管线的用户才需要改。</p>
        <label>共享技能 Hub 目录</label>
        <input v-model="form.hubPath" type="text" />
        <label>Agents 收件箱目录</label>
        <input v-model="form.agentsDir" type="text" />
        <label>ZCode 技能镜像目录（可选）</label>
        <input v-model="form.zcodeSkills" type="text" />
        <label>Codex 技能目录（可选）</label>
        <input v-model="form.codexSkills" type="text" />

        <h4>Junction 管线集成（可选，进阶）</h4>
        <p class="muted">如果你有一套"hub junction + agent 目录镜像"的构建脚本（本项目作者的 PowerShell 管线），填入路径即可启用「上线/下线」；留空则该按钮返回未配置提示。</p>
        <label>build 脚本路径</label>
        <input v-model="form.buildScript" type="text" />
        <label>中文技能目录路径（可选，增强中文搜索语料）</label>
        <input v-model="form.genCatalog" type="text" />

        <div class="row">
          <button class="primary" :disabled="busy" @click="save">保存全部</button>
        </div>
      </div>
      <p v-else class="muted">加载中…</p>
    </aside>
  </div>
</template>

<style scoped>
label { display: block; font-size: 12.5px; color: var(--ink-2); margin: 10px 0 4px; }
input[type="text"] { width: 100%; }
.row { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
h4 { margin: 18px 0 4px; }
.ok-msg { color: var(--ok); }
.err { color: var(--err); }
</style>
