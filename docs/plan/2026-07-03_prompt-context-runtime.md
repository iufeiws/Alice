# Prompt Context Runtime 重构计划

## 目标

把 prompt variable 的语义从独立缓存 runtime 收敛到 API context 边界，形成一个即时读取的 prompt context renderer。

最终效果：

- `apiContextRuntime` 是运行时上下文源数据的统一入口。
- prompt layer 解析仍保持纯函数，只接收 `LLMTextRenderer`。
- prompt variable 按变量名 lazy 读取，不再为了渲染一次性构筑整棵变量树。
- `user` 变量来自 `config.project.username`，也就是 `PROJECT_USERNAME`，不再来自 prompt profile。
- `librarySetting` 覆盖规则只保留一处。

## 当前问题

- `promptVariableRuntime` 和 `apiContextRuntime` 都表达“运行时上下文读取”语义，边界重复。
- `promptVariableRuntime` 持有独立 `userName`，旧设计需要通过 `setUserName()` 和 profile store 同步；当前 profile 已不应包含 username。
- `promptVariableRuntime` 只定时更新时间字段，memory、profile、calendar、daily shell、skills 等上下文变更不会自然反映。
- `getLibrarySetting()` 在 capabilities 和 agent stack 两处重复读取 world-wanderer 配置。
- capabilities runtime 创建 prompt variables，导致 prompt context 读取语义分散在 tool/capability 装配层。

## 目标结构

```text
apiContextRuntime
  ├─ promptProfileStore
  ├─ talkPromptProfileStore
  ├─ coreProfileStore
  ├─ memoryStore
  ├─ diaryStore
  ├─ calendarStore
  ├─ dailyShellStore
  ├─ skillsRegistry
  └─ promptContextRuntime
       ├─ renderText(content)
       ├─ getVariable(name)
       └─ listVariables()

prompt parser / prompt layer
  └─ 只接收 renderer，不直接依赖 apiContextRuntime
```

## 设计

新增 context 侧 renderer：

```ts
type PromptContextRuntime = LLMTextRenderer;

type LLMTextRenderer = {
  renderText(content: string): string;
  getVariable(name: string): LLMTextValue;
  listVariables(): string[];
};
```

语义分工：

- `renderText(content)`：唯一文本渲染入口，prompt layer、tool schema、tool result、TTS prompt 都走这里。
- `getVariable(name)`：按变量名读取值，只读取这个变量依赖的 store。
- `listVariables()`：返回可用变量名，供管理后台预览和调试。

`getVariable()` 每次调用即时读取：

- 当前时间
- `config.project.username`
- daily shell
- core profile appearance
- resolved library setting
- memory snapshot
- latest wake boundary
- calendar context
- available skills

管理后台需要展示变量树时，通过 `listVariables()` 和 `getVariable(name)` 派生 `promptVariableTree(renderer)`；该变量树不是运行时渲染入口。

`prompt-layer.ts`、`build-system-prompt.ts` 等解析层不直接读取 context，只消费 renderer。

## 实施步骤

1. 在 `api-context-runtime.ts` 创建 `promptContextRuntime`，并把 `librarySetting` 和 `available_skills` 构筑逻辑移入 context 边界。
2. 删除 `api-capabilities-runtime.ts` 内的 `createPromptVariableRuntime()` 装配，改为接收 `promptContextRuntime`。
3. 让 admin、chat、talk、tool preview、TTS prompt 都通过 `apiContextRuntime.promptContextRuntime` 渲染。
4. 移除 `PromptVariableRuntime.setUserName()` 同步路径；保存 prompt profile 后返回由 renderer 派生的变量树。
5. 删除不再使用的 `prompt-variable-runtime.ts`，或只在有外部引用时保留兼容类型；本次目标是不保留旧 runtime fallback。
6. 运行类型检查，确认没有隐藏 prompt 拼接、prompt layer 顺序或 tool 可见性行为变化。

## 非目标

- 不改 prompt layer schema。
- 不新增隐藏 prompt 文本。
- 不改变 prompt preview 的消息顺序。
- 不改变 tool 是否可见的判定规则。
- 不新增旧逻辑兼容 fallback。

## 验证

- `npm run typecheck`
- 检查 `promptVariableRuntime` 不再存在运行时装配和调用。
- 检查 `getLibrarySetting` 的 world-wanderer 覆盖逻辑只保留一处业务入口。
- 检查 prompt preview 和实际 LLM request 仍共用同一个 renderer。
