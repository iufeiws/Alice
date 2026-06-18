# admin-routes.ts 重构计划

目标文件：`src/apps/api/routes/admin-routes.ts`

当前问题很直接：`admin-routes.ts` 有 4517 行，里面不只是 API。它同时做 HTTP 分发、admin 上下文定义、插件 registry、配置读写、资源上传、TTS/ASR 测试、prompt/profile 管理、shell 管理、消息工具预览、Feishu/WeChat 运行控制和一堆容错转换。API 层不应该有这些逻辑。

## 目标

- `admin-routes.ts` 只保留 HTTP 适配：鉴权、路由匹配、读 body、调用应用服务、写 response。
- 业务逻辑移到对应 context/channel/capability 的 admin runtime 里。
- 不再静默 fallback。缺配置、坏输入、旧结构无法确定时直接返回 4xx/5xx；报错比错误运行好。
- 删除永远不会运行或只为猜测旧行为存在的分支。
- 不新增通用框架；先用普通函数和小文件拆开。
- 不新增任何硬编码 prompt。看到现有硬编码 prompt/fallback 文本，迁移前先确认保留意图。

## 非目标

- 不重写 admin UI。
- 不改公开 API 路径，除非删除明确无调用方的死接口。
- 不引入新的路由库、依赖注入容器或插件框架。
- 不为了“以后可能有插件”保留空扩展点。

## 边界规则

`src/apps/api/routes/admin-routes.ts` 允许：

- `createApiRequestHandler(context)`。
- 路由表或最小 `if` 分发。
- `readJsonBody` / `readRawBody`。
- HTTP status 到 JSON/HTML response 的转换。
- `HttpJsonError` / `AssetValidationError` 到 HTTP response 的转换。

`admin-routes.ts` 不允许：

- `fs` / `path` / `child_process` / `module.createRequire` 这类业务文件和进程操作。
- 直接读写 `.env`、`config/plugin/*`、`assets/*`。
- 创建 LLM/TTS/ASR/WeChat/Feishu client。
- 拼 prompt、拼默认测试内容、拼 LLM/tool preview 内容。
- 根据“可能存在的旧配置”默默猜默认值。
- 插件 registry、schema、config patch/validate 逻辑。

## 当前大块

从现有文件看，拆分顺序如下：

| 行段 | 内容 | 去向 |
| --- | --- | --- |
| 451-993 | 70+ 个路由 `if` 分发 | 保留在 route 层，但改成调用 handler map |
| 994-1232 | 通用 plugin API 分发和 payload | `src/apps/api/routes/admin-plugin-routes.ts` 或 plugin admin runtime |
| 1253-1569 | photo/asr/tts/feishu/wechat registry entry | 各插件自己的 admin entry |
| 1572-2247 | photo/asr config、validation、asset upload、test | `capabilities/tools/photo`、`channels/asr` 的 admin runtime |
| 2248-3045 | TTS summary/test/config/migration/assets/schema/events | `channels/tts/src/admin-runtime.ts` |
| 3065-3304 | token usage、prompt profile、memory runtime、tool preview | 各自 context admin runtime |
| 3313-3730 | shell config/order/assets、TTS reference upload/generate | shell admin runtime、TTS admin runtime |
| 3752-3889 | messaging preview/test content | messaging admin runtime；硬编码测试内容先确认后处理 |
| 3893-4077 | LLM preset 和 prompt API profile 存储 | `contexts/llm-gateway` / `contexts/agent-profile` admin runtime |
| 4081-4404 | Feishu/WeChat/agent/core state/config/runtime | channel/runtime admin services |
| 4415-4514 | HTTP 写出和弱类型 parsing helper | 只保留 HTTP 写出；parsing helper 下沉到输入 schema/服务 |

## 拆分计划

### 1. 冻结行为

- 先补一组最小 admin route contract checks，覆盖现有主要路径的 status/body shape。
- 不测实现细节，只测“路由调用哪个 admin service、错误如何返回”。
- 先记录所有现有 endpoint，避免拆分时漏路由。

验收：

- `admin-routes.ts` 拆分前后 endpoint 列表一致。
- 关键失败路径返回 4xx/5xx，不返回成功空对象。

### 2. 把路由分组拆出

先拆文件，不改业务：

- `admin-memory-routes.ts`
- `admin-prompt-routes.ts`
- `admin-plugin-routes.ts`
- `admin-shell-routes.ts`
- `admin-llm-routes.ts`
- `admin-runtime-routes.ts`
- `admin-channel-routes.ts`
- `admin-asset-routes.ts`

每个 route 文件只做：

```ts
if (method/path match) {
  const input = await parseRequest(request);
  return writeJson(response, status, await service.action(input));
}
```

验收：

- `admin-routes.ts` 降到 300 行以内。
- 新 route 文件没有业务默认值、没有 `fs.writeFileSync`、没有 LLM/TTS/ASR client 创建。

### 3. 下沉 admin service

把现在 route 文件里的逻辑搬到已有领域附近：

- memory：已有 `createAdminMemoryRuntime`，补齐 prompt/profile/run-progress 外壳。
- prompt/profile：放到 `contexts/agent-profile/src/application/*admin*`。
- LLM preset：放到 `contexts/llm-gateway/src/*admin*` 或 agent-profile preset store。
- plugin registry：保留一层 registry，但 entry 从各插件导出，不在 API 手写。
- TTS：`channels/tts/src/admin-runtime.ts` 管 config、test、asset、preview。
- ASR：`channels/asr/src/admin-runtime.ts` 管 config、test、asset。
- photo：`capabilities/tools/photo/src/admin-runtime.ts` 管 config。
- shell：`contexts/agent-profile/src/application/shell-admin-runtime.ts` 或现有 shell domain 附近。
- Feishu/WeChat：放到各 channel runtime/admin runtime。

验收：

- route 层没有 provider-specific 分支，例如 Bailian/Qwen/Genie/Tencent/OpenAI API。
- route 层没有 `updateEnvFile`。
- route 层没有 `createOpenAICompatibleClient`、`createWeChatILinkClient`、`createConfiguredVoiceSynthesizer`。

### 4. 删掉无意义 fallback

优先处理这些模式：

- `catch { return [] }` / `catch { return {} }`：改成显式错误，除非是读取可选缓存。
- `numberFromUnknown(value, fallback)` 用在用户提交配置时：坏输入返回 400，不吃掉。
- `requiredString(value) || default` 用在保存配置时：必填字段缺失返回 400。
- `?? default...` 用在公开 config view 可以保留；用在运行配置保存和执行路径要移除。
- 旧字段兼容如 `corePresetName`、`remote`、`api_preset`：加一次性迁移或明确删除，不在运行路径长期兼容。
- `normalizeAdminPluginId(pluginId) { return pluginId; }`：删除。
- `wechatPluginEntry` 的 planned placeholder：如果前端没有真实依赖，删除；真实 WeChat 入口从 channel admin entry 提供。
- prompt/test fallback 文本，例如 TTS preview 默认文案、Feishu markdown 测试内容：先确认需求；不确认就删除或要求调用方传入。

验收：

- 保存配置时，非法枚举不再变成默认值。
- 缺少 API preset / key / asset 时返回错误，不走本地或远端 fallback。
- route 层没有无注释的空 `catch`。

### 5. 删除死代码

先用测试和搜索确认调用方，再删：

- 未被引用的 schema/helper，例如只在当前文件内部拼出来但前端不用的 `ttsConfigSchema()`。
- 永远返回原值的 wrapper。
- 重复的 config path/mtime helper，改由各 admin runtime 提供。
- 旧迁移函数：只保留一次性迁移入口，不在每次读取 public config 时迁移。
- 只为“可能旧配置还在”存在的字段镜像。

验收：

- 每个保留 helper 至少有一个直接调用方和清楚职责。
- 删除后 contract checks 仍过。

### 6. 收紧 AdminRoutesContext

`AdminRoutesContext` 现在像全项目对象桶。拆分后改成：

- route 层只拿 `adminServices`。
- 每个 service 自己声明需要的 store/runtime。
- 测试 mock 只 mock 被调用的 service，不再构造整坨 context。

目标形态：

```ts
export type AdminRoutesContext = {
  services: {
    memory: AdminMemoryService;
    prompts: AdminPromptService;
    plugins: AdminPluginService;
    shell: AdminShellService;
    llm: AdminLlmService;
    runtime: AdminRuntimeService;
    channels: AdminChannelService;
    assets: AdminAssetService;
  };
};
```

验收：

- `AdminRoutesContext` 不直接暴露 plugin/channel/store 细节给 route 文件。
- route 测试 fixture 体积明显下降。

## 错误策略

- 用户输入坏：400。
- 资源不存在：404。
- 配置缺失：409 或 400，按“请求本身坏”还是“当前状态不允许”区分。
- 外部服务失败：502。
- 本机执行失败：500。
- 未知路由：404。

禁止：

- 外部服务失败后自动换 provider，除非用户配置里明确启用该 fallback。
- 配置读失败后返回空配置并继续运行。
- JSON parse 失败后尝试补逗号、补大括号继续保存配置。

## Prompt 规则

- API/admin 代码不得新增硬编码 prompt、默认 prompt、测试 prompt。
- prompt 内容只能来自用户保存的配置、已有 prompt store、测试显式输入或经确认的 fixture。
- 发现现有硬编码 prompt/fallback 文案时，先列出来并让用户确认保留、删除还是迁移。

## 最小落地顺序

1. 新增 endpoint snapshot test。
2. 提取 `writeJson`/`writeHtml`/`handleHttpError` 到 HTTP util，保留 route 使用。
3. 拆 `admin-plugin-routes.ts`，但 plugin 业务暂不动。
4. 把 TTS admin 逻辑搬到 `channels/tts/src/admin-runtime.ts`。
5. 把 ASR/photo admin 逻辑搬到各自模块。
6. 把 prompt/LLM preset 逻辑搬到 agent-profile/llm-gateway。
7. 把 Feishu/WeChat runtime/config 搬到 channel admin runtime。
8. 收紧 fallback，删除死 helper。
9. 收紧 `AdminRoutesContext`。

每步只做一种移动或删除，避免“拆文件 + 改行为 + 改测试”混在一起。

## 完成标准

- `admin-routes.ts` 小于 300 行。
- route 文件没有业务 provider 名称。
- route 文件没有 `fs`、`path`、`child_process`、`QRCode`、LLM/TTS/ASR client import。
- route 文件没有 prompt 文本或默认测试内容。
- 保存配置的坏输入都返回错误，不静默默认。
- 每个拆出的 admin runtime 有一个最小测试。
- 无调用方的 placeholder、wrapper、legacy fallback 已删除。
