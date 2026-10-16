# skill-hub-web 技能控制管理系统

一个自托管的 Web 全栈应用，把散落在本机各处的 **Agent 技能**（SKILL.md 目录）集中到一处：按功能自动分类、展开查看触发提示词、中文搜索英文触发词、内置 Agent 按需求推荐技能、上线/下线控制、回收站两阶段删除。

零数据库、零框架锁死：后端 Express（一个进程），前端 Vue 3 + Vite，状态全部存本地 JSON 文件。**默认零配置可跑**——所有环境相关的路径和 API 密钥都能在网页「设置」里改。

## 功能

- **分区浏览**：技能按功能自动归入 11 个内置分类（可自定义新增），类内字母排序；每行展开显示触发词摘要、来源三级链（本体目录 → hub → agent 目录）。
- **智能搜索**：中文需求直接搜英文触发词。三通道级联——路由矩阵（可选）→ 本地评分器（CJK 2-gram + 自定义语料）→ LLM（OpenAI 兼容端点，结果稀薄时才调用）。
- **Agent 助手**：输入需求 → 推荐 1-3 个技能 + 中文理由 → **一键复制即贴提示词**给任意工作 Agent；本地无匹配时给出开源生态兜底建议。
- **AI 自动归类**：设置分类后一键让模型建议归属，勾选确认才写库。
- **规则自进化**：LLM 命中对持续积累，「规则维护」把稳定映射固化为离线规则——**规则由模型维护，但日常使用不依赖在线调用**；LLM 不可达自动降级纯规则模式。
- **上线/下线**（可选集成）：如果你的机器有 junction 聚合管线（本仓库作者的 PowerShell 方案），填入脚本路径即可从网页控制技能在 agent 目录的可见性，含硬触发技能保护与前后断言。
- **回收站**：删除先进回收站（原子 rename），恢复无损；彻底删除需输入技能名二次确认。

## 快速开始

要求：Node.js ≥ 18。

```bash
npm install          # 装后端依赖
cd web && npm install && npm run build && cd ..
npm start            # server/index.js，默认 http://localhost:3210
```

打开 http://localhost:3210，点「设置 → 技能目录路径」把你的 SKILL.md 父目录加进来（默认扫描 `~/.skill-hub-web/hub` 与 `~/.agents/skills`），或用「添加扫描目录」逐级选择文件夹。

### 启用内置 Agent（可选）

设置 → LLM：填任意 **OpenAI 兼容**端点（Base URL / API Key / 模型名），点「保存并测试连通」。不填则智能搜索与推荐走纯规则模式。也可以在启动前复制 `.env.example` 为 `server/.env` 预置。

## 配置优先级

`server/data/settings.json`（网页设置，最高） > `server/.env`（`LLM_*` 三键） > 内置默认值。所有密钥只存本机，`.gitignore` 已排除。

## CLI

`skill-hub-cli.mjs`（与服务共用状态，通过 API 通信）：

```bash
node skill-hub-cli.mjs list [--category 名] [--query 词] [--json]   # 分区总览
node skill-hub-cli.mjs detail <技能名>                              # 分类/触发词/全文/来源链
node skill-hub-cli.mjs categorize <技能名> <分类名|auto>             # 调分类
node skill-hub-cli.mjs categories | category-add <名> | category-delete <名>
node skill-hub-cli.mjs roots | add-root <绝对路径> | remove-root <路径>
node skill-hub-cli.mjs online <技能名> | offline <技能名>            # 需配置 buildScript
node skill-hub-cli.mjs trash | trash-restore <id> | trash-purge <id>
node skill-hub-cli.mjs agent recommend <中文需求>
node skill-hub-cli.mjs status
```

## API

统一 `{code, msg, data}` 包络。主要路由：`GET /api/skills`、`GET /api/skills/:rootKey/:name`、`POST .../category`、`GET|POST|DELETE /api/roots`、`GET|POST|DELETE /api/categories`、`GET /api/browse`、`POST /api/skills/:name/visibility`、`POST /api/skills/:rootKey/:name/trash`、`GET /api/trash`、`POST /api/trash/:id/restore`、`DELETE /api/trash/:id`、`POST /api/agent/search|recommend|auto-categorize|maintain-rules`、`GET|POST /api/settings`、`GET /api/status`。

## 设计要点（给想改代码的你）

- **hub 是只读聚合视图**：本机作者的管线把每个技能做成 junction 指向权威副本，所以对 hub 技能的"删除"被引导为「下线」（改构建脚本 excluded 名单 + 前后文件系统断言）。没有这套管线的机器（buildScript 留空）该功能自动禁用，直接管理文件夹即可。
- **评分器**是 router.py `keyword_fallback` 的 Node 移植：CJK 2-gram +1、英文词 ≥3 字符 ×2、自定义中文信号词 ×3、用户积累映射 ×4；矩阵路由命中 = 直接裁决。
- **所有 LLM 调用**走统一 client：单飞队列 + 2s 节流 + 90s 超时 + 重试 1 次 + 全局降级。
- 审计日志：`server/data/audit.log`（分类/上下线/回收站/设置变更全记录）。

## License

MIT
