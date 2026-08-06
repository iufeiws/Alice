# 工具目录归纳:拆散 sandbox/、归位 file/ 与 shell/

## 文档状态

- 状态:**已实施并验证**(2026-08-05)。协议确认结果:Read/Write/Edit/Bash 使用 Alice 静态定义(大写工具名、Pi 容器参数名),执行经 `piWorker.executeTool` 转发;Glob 保持 bash-sandbox;Read 图片处理(attachment/recognizeImage 降级)保留在 file 插件。
- 前置文档:[2026-08-04_bash-sandbox-agent-refactor.md](./2026-08-04_bash-sandbox-agent-refactor.md)(转发工具语义、relay、SubAgent 总体设计)与 [2026-08-05_bash-sandbox-agent-refactor-step2.md](./2026-08-05_bash-sandbox-agent-refactor-step2.md)(SubAgent session 化、both 消息、Memorize 迁移)。
- 范围:仅目录/模块归属与插件结构规范化,不改变工具参数协议、执行语义、SubAgent action 集合。

## 实施记录

- `file/profile.ts`:删除旧 `readTool/editTool/grepTool`(旧 `file_path`/`old_string` 协议),改为按容器协议(`path`/`edits[]`)的静态 `readTool/writeTool/editTool`,保留 `globTool`,新增 `piFileToolNames` 映射。
- `file/src/index.ts`:`createFileTools`(id `"file"`),`bashSandbox/config` 可选 —— Read/Write/Edit 经 `piWorker.executeTool` 转发(含图片 attachment 与 recognizeImage 降级),Glob 走 bash-sandbox;`createGlobTool` 独立导出删除。
- `shell/`(新建):`createShellTools`(id `"shell"`),静态 `bashTool`(`command`/`timeout`),转发容器 `bash`。
- `subagent/`:`sandbox/src/subagent-tool.ts` 移入并规范化,`subAgentTool` 静态定义入 `profile.ts`,执行逻辑零改动。
- `sandbox/` 目录删除。
- `tool-runtime.ts`:`globTools`+`sandboxTools` → `fileTools`+`shellTools`;`subAgentTools` 保留。
- Memorize 路径(`induction.ts`、`admin-memory-runtime.ts`)改用 `createFileTools({ piWorker })` 取 Read/Edit 定义。
- `admin-plugin-runtime.ts` routePreview 文案更新。
- 测试:`pi-worker-runtime.test.ts` 拆分 file/shell 断言;`pi-worker-integration.test.ts` worker 路径改 `infra/bash-sandbox`。
- 验证:`npm run typecheck` 通过;全套 TS 测试通过(3 个失败为 HEAD 上已存在的 pre-existing 失败:`message-runtime-initiated-behavior`、`random-event-store`、`world-wanderer-policy`,与本次改动零交集)。

## 问题

`src/capabilities/tools/sandbox/` 下同时存在两个互不相关的 ToolPlugin:

| 文件 | 插件 id | 本质 |
|---|---|---|
| `sandbox-tool-adapter.ts` | `sandbox_tools` | Read/Write/Edit/Bash 四个容器工具转发(代理只是实现方式,工具本体是 file 与 shell 工具) |
| `subagent-tool.ts` | `subagent` | SubAgent 会话编排(8 个 action) |

两者只共享 `PiWorkerRuntime` 依赖。目录名 `sandbox` 与 `contexts/bash-sandbox` 语义混淆,且结构不符合其他工具目录的规范(`profile.ts` 静态定义 + `src/index.ts` 工厂、一个目录一个插件)。

## 目标结构

```text
src/capabilities/tools/
  file/
    profile.ts          # 保留 globTool;删除 readTool/editTool/grepTool 死导出;新增 pi 工具名映射
    src/index.ts        # createFileTools: id "file" — Read/Write/Edit(容器动态定义)+ Glob(静态定义)
  shell/                # 新建
    profile.ts          # bashToolName 常量与 pi 名映射
    src/index.ts        # createShellTools: id "shell" — Bash(容器动态定义)
  subagent/             # 由 sandbox/ 改名
    profile.ts          # SubAgent 静态 ToolDefinition(oneOf schema 从 listTools 移入)
    src/index.ts        # createSubAgentTool(逻辑不变)
  sandbox/              # 删除
```

## 逐文件变更

### 1. `src/capabilities/tools/file/src/index.ts`

- 将 `sandbox-tool-adapter.ts` 的 Read/Write/Edit 转发逻辑并入,形成单一插件 `createFileTools`(id `"file"`):

```ts
createFileTools(input: {
  bashSandbox: BashSandboxRuntime;        // Glob 执行路径(现有 createGlobTool 逻辑)
  config: BashSandboxConfig;
  piWorker?: PiWorkerRuntime;             // 无则 Read/Write/Edit 不暴露
  recognizeImage?;                        // 图片降级(从 adapter 移入)
  resolveImagePath?;
}): ToolPlugin
```

- `listTools()`:piWorker 存在时返回 `[Read, Write, Edit](容器动态定义映射)` + `[globTool](静态)`;piWorker 不存在时仅 `[globTool]`。与现状等价:piWorker 不可用时 sandbox 适配器不创建,Glob 始终可见。
- `execute()`:Read/Write/Edit → `piWorker.executeTool({ toolName: 小写映射, input: call.input, context })`,含图片 content 的 `llmFollowupAttachments` 与 `convertImages` 降级逻辑;Glob → 现有 `createGlobTool` 的 bash-sandbox 路径。
- 删除 `createGlobTool` 独立导出(其逻辑内联进 `createFileTools`);`globTools` 变量在 tool-runtime 无外部消费者(已核实),安全合并。
- 名称映射表 `exposedToolNames`(read→Read / write→Write / edit→Edit)移入 `profile.ts`。

### 2. `src/capabilities/tools/file/profile.ts`

- 删除 `readTool`、`editTool`、`grepTool`:容器协议与旧静态定义不同(容器 `path`/`edits[]` vs 旧 `file_path`/`old_string`),且 08-04 决策 3 明确"四个转发工具不手写/复制 description 与 schema";留着是死代码加误导。
- 保留 `globTool`。
- 新增 pi 名映射导出。

### 3. `src/capabilities/tools/shell/`(新建)

- `profile.ts`:`bashToolName = "Bash"`、pi 名映射(bash→Bash)、错误文本。
- `src/index.ts`:`createShellTools({ runtime: PiWorkerRuntime }): ToolPlugin`,id `"shell"`;`listTools()` 从 `runtime.toolDefinitions()` 过滤 `bash` 并映射;`execute()` 转发 `piWorker.executeTool`。Bash 不产出图片 content,不需要降级逻辑。
- 插件 id 用 `shell`:`chat-agent-helpers.ts:140` 与 `prompt-tool-preview-runtime.ts:35` 的 `plugin.id === "shell"` 特判由死分支转为活分支,无需改动。

### 4. `src/capabilities/tools/subagent/`(由 sandbox/ 改名)

- `sandbox/src/subagent-tool.ts` → `subagent/src/index.ts`,逻辑零改动。
- 新增 `subagent/profile.ts`:`SubAgent` 静态 ToolDefinition(description + 现有 oneOf schema 整体移入),`listTools()` 返回 `[subAgentTool]`。
- 目录名说明:sandbox 只是作用域,工具本质是子代理会话编排,故按工具名命名(与 file/shell 同规则)。

### 5. `src/capabilities/tools/messaging/src/tool-runtime.ts`

- import 改为 `file/src/index.js`、`shell/src/index.js`、`subagent/src/index.js`,删除 sandbox 两个 import。
- 构造:`fileTools = createFileTools({ bashSandbox: bashRuntime, config: input.config.bashSandbox, piWorker: input.piWorkerRuntime, recognizeImage: input.recognizeImage, resolveImagePath })`;`shellTools = input.piWorkerRuntime ? createShellTools({ runtime: input.piWorkerRuntime }) : undefined`;`subAgentTools` 不变。
- `toolPlugins` 与返回值:`globTools`/`sandboxTools` → `fileTools`/`shellTools`。

### 6. 清理

- 删除 `src/capabilities/tools/sandbox/` 整个目录。
- `src/contexts/capabilities/src/admin-plugin-runtime.ts:271` routePreview 文案 "Sandbox tool/SubAgent" → "File/Shell tools/SubAgent"(可选文案)。

### 7. 测试

- `tests/contexts/pi-worker/pi-worker-runtime.test.ts`:import 路径改 `file/src/index.js`、`shell/src/index.js`、`subagent/src/index.js`;Read/Write/Edit 映射断言移到 `createFileTools`,Bash 映射断言移到 `createShellTools`,图片 attachment 测试留在 `createFileTools`,SubAgent 断言不变。
- `tests/contexts/pi-worker/pi-worker-integration.test.ts` 引用 `infra/pi-worker/worker.mjs`(旧路径,worker 已在 `infra/bash-sandbox/worker.mjs`)——已单列,若属你未完成部分本次不动。

## 行为变化清单(需确认)

| 项 | 现状 | 归位后 |
|---|---|---|
| Read/Write/Edit/Glob 可见性 | 按 tool.name 查,缺失默认可见 | 不变 |
| Bash 可见性(chat profile,`shell: true`) | 按 "Bash" 查,可见 | 按 `visibleTools.shell` 查,可见 |
| Bash 可见性(talk profile,`shell: false`) | 按 "Bash" 查,默认可见 | 按 `visibleTools.shell` 查,**不可见** |
| 容器未 ready / piWorker 未配置 | Read/Write/Edit/Bash 不暴露,Glob 可见 | 不变 |
| SubAgent action 集合与 oneOf 形态 | 8 action | 不变(仅定义移入 profile.ts) |

talk 场景 Bash 从"可见"变"不可见"是唯一语义变化;step2 决策 17 已确立"容器工具只进 ChatAgent/Core",该变化与之一致,但需明确确认。

## 验证

1. `npm run typecheck`
2. `npm test`(重点:pi-worker-runtime、pi-worker-integration、bash-sandbox、agent-state-subagent-hold)
3. 运行时确认:chat profile 下 Read/Write/Edit/Bash/SubAgent 均出现在 toolNames;talk profile 下无 Bash/SubAgent。

## 非目标

- 不改 Read/Write/Edit/Bash 的参数协议与执行语义(容器动态定义,08-04 决策 1-4)。
- 不恢复旧 Read/Edit/Grep/Bash 实现与兼容 fallback(08-04 决策 6)。
- 不新增 Grep。
- 不动 `tests/capabilities/tools/shell/`(该目录测的是 wardrobe 工具,命名撞车为历史遗留,另议)。
- 不改 SubAgent 的 action 集合、hold 配对、messageTarget 逻辑。
