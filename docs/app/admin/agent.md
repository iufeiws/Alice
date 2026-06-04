# Admin Agent Rules

## API Key Configuration

后台管理页里所有 API key 相关配置都必须复用已保存的 API preset。

规则：

- 不在插件配置页、功能配置页或临时表单里直接填写新的 API key。
- 涉及 LLM/API provider 的插件配置应提供 preset 下拉选框。
- preset 下拉选框的数据来源应复用后台已有的 API preset 存储。
- 插件配置只保存 preset 名称或 preset id，不复制保存 API key 明文。
- 如果插件需要固定模型、温度、extra params，应优先从 preset 读取；插件可以只保存自己的覆盖项。
- 新增插件接入后台时，必须先检查是否已有可复用 preset 机制。

目标：

- 避免 API key 散落在多个插件配置文件中。
- 让 key 轮换、脱敏展示和权限边界集中管理。
- 让插件 agent 只声明自己需要哪个 preset，而不是自己管理密钥。

## Plugin Admin Generality

后台 Plugin 管理页必须始终按通用插件系统设计，不能围绕某一个具体插件硬编码。

规则：

- 文档、接口和 UI 都以通用 `plugin_id` 为中心。
- 不把 `japanese-voice`、飞书、微信或任何真实插件写成布局和接口的主设计对象。
- 示例插件只能使用 `plugin-example`、`plugin-voice-example` 这类名字。
- 真实插件只能作为 registry entry 接入通用系统。
- 新增插件时，原则上只新增或修改插件元数据、配置 schema、资源 schema 和处理器。
- 新增插件不应要求修改 Plugin 页的卡片布局、Config 面板布局或通用 API 路由。
- 通用 API 使用 `/admin/api/plugins/:pluginId/...` 形态。
- 不新增硬编码插件专用接口作为主路径；如需兼容旧接口，也只能作为过渡层。
- 配置表单由 schema 驱动渲染，控件类型应是通用元素，例如 `switch`、`select`、`apiPresetSelect`、`textarea`、`fileUpload`、`folderUpload`、`readonly`。
- 开关必须是左右滑动的真实视觉控件，形态参考 `[   O]` / `[O   ]` 的圆点位置；不要把这两个字符串直接渲染到界面。
- 点击 `Config` 后，当前插件应扩充为整个 Plugin 面板；不要在卡片下方 inline 展开。
- 插件资源统一保存到 `assets/plugin/{plugin_id}/...`。
- 资源子路径由插件 resource schema 决定，不能在通用层写死某个插件名。
- 插件配置只保存资源路径，不把大文件内容写进 JSON 配置。
- 所有 API key 继续复用后台已保存的 API preset；插件配置只保存 preset 名称或 id，不保存 key。
- 如果发现实现里需要写 `if pluginId === "某真实插件"`，必须先考虑是否应该抽成 registry/schema/handler。
