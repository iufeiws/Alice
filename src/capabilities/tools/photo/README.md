# Photo Tool 说明

Media tools 供 ChatAgent 使用。当前实现暴露一个 LLM 工具：

- `selfie`：生成并发送一张 Alice 自拍/照片到当前聊天会话。

## Selfie 工具说明

`selfie` 接收以下输入，其中 `pose` 必填，其余参数可选：

```json
{
  "pose": "lean close to the camera and smile shyly",
  "expression": "shy smile",
  "hair": "long straight hair",
  "composition": "medium close-up"
}
```

未提供的参数使用 Photo 配置中 Main Prompt 分组的默认值。`expression` 和 `hair` 有值时，分别以 `表情: {arg}\n` 和 `发型: {arg}\n` 写入主 prompt；`composition` 直接写入主 prompt。默认值为：姿势、表情和发型为空，构图为“镜头距离为超近景, 一臂距离, 人物占画面80%以上”。

调用后，工具会：

1. 从以下来源构造图片 prompt：
   - 主 prompt profile 中的 Alice 角色特征。
   - 当前日常 shell personality 与 outfit。
   - `assets/selfie/references/selfie-prompt.txt`。
2. 默认由内置 API executor 直接调用 Image API `/v1/images/edits`，并使用低质量、小尺寸、单张输出配置。`codex` 模式会启动一次 ephemeral Codex CLI 会话，让新会话使用 `$alice-selfie-fast` 和内置 `image_gen` 生图。
3. 按以下顺序传入参考图：
   - `assets/selfie/references/alice-character-reference.jpg`
   - `memory-files/shell/outfits/*.jpg` 中当前 outfit 对应图片
   - `assets/selfie/references/magic-library-reference.jpg`
5. 如果当前 outfit 图片缺失，不直接失败；只传角色和图书馆参考图，并把服装信息作为文字写入 prompt。
6. `codex` 模式由新会话返回 Codex 生成图路径，再由 photo tool 脚本复制到临时工作目录并写入 `assets/generated/selfies/selfie_{datetime}.jpg`。
7. 通过当前渠道的 image output 路径发送生成图片。

Selfie profile 的 `returnImageToLLM` 默认关闭。关闭时即使当前模型支持图片，也只通过渠道发送图片并向模型返回图片路径；开启后且模型支持图片时，才会把生成图片作为工具后续附件回传给模型。

生成图片目录故意被 git 忽略。参考图和 prompt 模板是源码资产，应提交。

## Admin 配置

管理后台的 Plugins 页面会显示 `Photo` 插件。配置文件位于：

```text
config/plugin/photo/config.json
```

`selfieMode` 支持：

- `openai`：直接调用 OpenAI Image API。
- `openaiRelay`：调用 OpenAI 兼容中转路由，使用独立的 key、base URL 和图像构筑参数。
- `codex`：启动 ephemeral Codex CLI 会话，使用 `$alice-selfie-fast` 约束新会话立即调用内置 `image_gen`，并由 photo tool 脚本搬运返回的生成图。

`codex` 模式的生图行为、速度约束和图像参数集中定义在 `src/capabilities/skills/external/alice-selfie-fast/SKILL.md`。photo tool 只负责构造任务 prompt、传参考图、启动新会话、解析生成图路径和搬运文件。

API key 可以在 Configure 页面填写，保存后不会在 config 响应里回显明文；空值表示保留当前 key。Selfie 的主 prompt 模板和四个默认参数位于 Configure 页面 `Main Prompt` 分组。

## Image API 配置说明

工具默认使用快速、小尺寸、低质量输出：

```text
SELFIE_IMAGE_API_MODEL=gpt-image-2
SELFIE_IMAGE_API_SIZE=768x1024
SELFIE_IMAGE_API_QUALITY=low
SELFIE_IMAGE_API_MODERATION=low
SELFIE_IMAGE_API_OUTPUT_FORMAT=jpeg
SELFIE_IMAGE_API_OUTPUT_COMPRESSION=45
SELFIE_IMAGE_API_TIMEOUT_MS=120000
```

`openai` 使用 `SELFIE_IMAGE_API_KEY` 或 `OPENAI_API_KEY`，以及 `SELFIE_IMAGE_API_BASE_URL` 或 `OPENAI_BASE_URL`。
`openaiRelay` 使用 `SELFIE_IMAGE_API_RELAY_KEY`、`SELFIE_IMAGE_API_RELAY_BASE_URL` 和 `SELFIE_IMAGE_API_RELAY_*` 构筑参数。

认证优先使用 `SELFIE_IMAGE_API_KEY`，缺失时回退到 `OPENAI_API_KEY`。

可选 base URL 覆盖：

```text
SELFIE_IMAGE_API_BASE_URL=https://api.openai.com/v1
SELFIE_IMAGE_API_RELAY_BASE_URL=https://relay.example/v1
```

如果 `SELFIE_IMAGE_API_BASE_URL` 未配置，会先使用 `OPENAI_BASE_URL`，再回退到 OpenAI 默认 `/v1` base URL。

实现会使用进程里存在的代理环境变量：

```text
HTTPS_PROXY
https_proxy
HTTP_PROXY
http_proxy
```

## 保护规则

Agent loop 不按 tool name 拦截已经暴露的 `selfie` 调用。是否暴露工具由 request 构筑阶段决定；成本、频率和参数限制应由工具自身或上游可见性策略处理。

工具会要求输出目录位于项目 `assets/` 内，并检查生成文件扩展名和 `SELFIE_MAX_BYTES`。

## 手动测速

运行独立 API 测试，不把它接入 Agent 工具：

```bash
npm run test:selfie-api -- "靠近镜头，轻轻歪头，露出有点害羞的表情"
```

测试输出写入：

```text
assets/generated/selfies/api-tests/
```
