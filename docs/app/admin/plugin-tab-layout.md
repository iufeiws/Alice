# 后台管理器 Plugin 标签页通用规范

本文档定义后台管理器 `Plugin` 标签页的通用布局、接口和接入规则。Plugin 页必须是通用插件管理系统，不围绕任何真实插件硬编码；真实插件只能作为 registry entry 接入。

## 目标

- 用同一套页面管理所有本地插件的启用状态、配置、资源和运行信息。
- 新增插件时只新增插件元数据、配置 schema、资源 schema 和处理器。
- Plugin 页卡片布局、Config 面板布局和通用 API 路由不因新增插件而改变。
- 所有 API key 配置复用后台已保存的 API preset，插件配置只保存 preset 名称或 id。
- 插件资源统一保存到 `assets/plugin/{plugin_id}/...`。

## 页面入口

后台管理器主导航新增：

```text
Plugin
```

`Plugin` 是一等管理对象，不作为 `Settings` 的子页。

## 总体布局

整体参考 `chrome://extensions/` 的“所有扩展程序”页：顶部工具栏 + 搜索 + 插件卡片网格。

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Plugin                                           [Search plugins]   │
│ [Developer mode switch]                                             │
│ [Load unpacked] [Pack plugin] [Update]                               │
├─────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────┐ ┌──────────────────────────┐           │
│ │ icon  Plugin Example     │ │ icon  Voice Example      │           │
│ │       description        │ │       description        │           │
│ │ ID: plugin-example       │ │ ID: plugin-voice-example │           │
│ │ Enabled · Healthy        │ │ Missing config           │           │
│ │ [Config]  [Reload] <on>  │ │ [Config]  [Reload] <off> │           │
│ └──────────────────────────┘ └──────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

推荐宽度：

| 区域 | 宽度 | 说明 |
| --- | --- | --- |
| 页面内容 | 最大 1200-1440px | 居中容器，避免宽屏下卡片过散 |
| 插件卡片 | 360-420px | 展示名称、描述、id、按钮和开关 |
| 网格间距 | 16-20px | 保持后台页密度 |

移动端降级为单列；`Config` 进入全屏配置面板。

## 顶部工具栏

顶部包含：

- 页面标题：`Plugin`
- 搜索输入：按插件名称、id、类型、状态、描述过滤。
- Developer mode 开关。

Developer mode 关闭时只显示普通操作：`Config` 和开关。

Developer mode 打开时显示：

- `Load unpacked`
- `Pack plugin`
- `Update`
- 插件 id
- 配置来源
- 最近加载时间
- `Reload`
- 错误堆栈入口

## 插件卡片

每张卡片显示：

- 插件图标，来自插件元数据。
- 插件名称。
- 插件描述。
- 插件 id。
- 状态和健康状态。
- `Config` 按钮。
- `Reload` 按钮，Developer mode 打开时显示。
- 启用开关。

卡片结构：

```text
┌────────────────────────────────────┐
│ [icon] Plugin Example              │
│        Short plugin description.   │
│                                    │
│ ID: plugin-example                 │
│ Enabled · Healthy                  │
│                                    │
│ [Config]  [Reload]       <switch> │
└────────────────────────────────────┘
```

开关必须使用真实滑块控件。下面字符只用于说明圆点位置，不是界面文案：

```text
[   O]  enabled
[O   ]  disabled
```

实现时应使用 checkbox/switch 组件或 CSS 轨道 + 圆点，启用时圆点在右侧，禁用时圆点在左侧；不要把 `[   O]` 或 `[O   ]` 作为字符串渲染到界面。

## Config 面板

点击卡片上的 `Config` 后，当前插件扩充为整个 Plugin 主面板；卡片网格退到后面。不要在卡片下方 inline 展开。

```text
← Plugin

Plugin Example
plugin-example · tool · local
<switch>

Configuration
Runtime
Recent events
```

配置页规则：

- 顶部有返回入口：`← Plugin`。
- 面板占用整个 Plugin 主内容区域。
- 不使用 modal，除非移动端空间不足。
- 返回后恢复插件卡片网格和搜索状态。
- 配置表单由插件 schema 驱动渲染。

## 通用配置控件

配置表单只使用通用控件类型：

| 控件 | 用途 |
| --- | --- |
| `switch` | 启用、禁用或布尔配置；真实滑块控件，启用圆点在右、禁用圆点在左，不渲染字面字符 |
| `text` | 普通短文本 |
| `textarea` | 长文本，例如 prompt |
| `select` | 普通枚举选择 |
| `apiPresetSelect` | 已保存 API preset 下拉 |
| `fileUpload` | 单文件上传 |
| `folderUpload` | 文件夹上传 |
| `readonly` | 只读状态或派生值 |

API key 规则：

- 插件配置只保存 preset 名称或 id。
- 插件配置不保存 API key、baseURL 等密钥字段。
- `apiPresetSelect` 的选项来自后台统一 API preset 存储。

## 通用资源规则

插件资源统一保存到：

```text
assets/plugin/{plugin_id}/...
```

规则：

- 资源子路径由插件 `resourceSchema` 决定。
- 通用层不能写死某个真实插件名。
- 上传接口只返回资源路径。
- 插件配置只保存资源路径，不保存大文件内容。
- 后台必须拒绝路径穿越和插件 assets 根目录之外的路径。

示例：

```text
assets/plugin/plugin-voice-example/model/
assets/plugin/plugin-voice-example/reference.wav
assets/plugin/plugin-voice-example/reference.txt
```

## 插件状态模型

| 状态 | 含义 |
| --- | --- |
| `enabled` | 插件开关打开 |
| `disabled` | 插件开关关闭 |
| `planned` | 设计中或待迁移，不能操作 |
| `external_config` | 当前由环境变量或独立配置文件管理 |
| `missing_config` | 缺少必要配置 |
| `error` | 启用后运行失败 |

健康状态单独展示：

| 健康状态 | 含义 |
| --- | --- |
| `healthy` | 最近加载和运行正常 |
| `degraded` | 可运行但存在非阻断问题 |
| `failing` | 最近执行失败 |
| `unknown` | 尚未运行或无法判断 |

开关状态和健康状态不要混在一个字段里。

## 通用 API

```text
GET    /admin/api/plugins
GET    /admin/api/plugins/:pluginId/config
PATCH  /admin/api/plugins/:pluginId/config
POST   /admin/api/plugins/:pluginId/enable
POST   /admin/api/plugins/:pluginId/disable
POST   /admin/api/plugins/:pluginId/reload
POST   /admin/api/plugins/:pluginId/test
GET    /admin/api/plugins/:pluginId/events
POST   /admin/api/plugins/:pluginId/assets/:assetKey
```

### 列表接口

```ts
type AdminPluginSummary = {
  id: string;
  name: string;
  kind: "channel" | "tool" | "voice" | "presentation";
  status: "enabled" | "disabled" | "planned" | "external_config" | "missing_config" | "error";
  health: "healthy" | "degraded" | "failing" | "unknown";
  description: string;
  configurable: boolean;
  switchable: boolean;
  configSource?: string;
  lastLoadedAt?: string;
  lastUsedAt?: string;
};

type AdminPluginsResponse = {
  plugins: AdminPluginSummary[];
};
```

### 配置接口

```ts
type AdminPluginConfigResponse = {
  plugin: AdminPluginSummary & {
    version?: string;
  };
  configSchema: {
    fields: AdminPluginConfigField[];
  };
  configValue: Record<string, unknown>;
  resourceSchema?: {
    assets: AdminPluginAssetField[];
  };
  apiPresets?: Array<{
    name: string;
    model: string;
    baseURL?: string;
  }>;
  routePreview: string[];
  runtimeAccess: string[];
};

type AdminPluginConfigField = {
  key: string;
  label: string;
  type: "switch" | "text" | "textarea" | "select" | "apiPresetSelect" | "fileUpload" | "folderUpload" | "readonly";
  description?: string;
  assetKey?: string;
  accept?: string;
};

type AdminPluginAssetField = {
  key: string;
  label: string;
  pathPrefix?: string;
  accept?: string;
};
```

### 配置更新

`PATCH /admin/api/plugins/:pluginId/config` 接收局部更新：

```ts
type AdminPluginConfigPatch = Record<string, unknown>;
```

规则：

- 未传字段保持原值。
- `apiPresetSelect` 字段必须引用一个已保存 API preset。
- 大文件通过 assets 上传接口写入，不通过 JSON body 传输。

### 资源上传

```text
POST /admin/api/plugins/:pluginId/assets/:assetKey
```

保存目标必须位于：

```text
assets/plugin/{plugin_id}/...
```

返回：

```ts
type AdminPluginAssetUploadResponse = {
  ok: true;
  assetPath: string;
  configValue: Record<string, unknown>;
};
```

### 事件接口

```ts
type AdminPluginEventsResponse = {
  events: Array<{
    id?: number;
    time?: string;
    level?: "info" | "warn" | "error";
    message: string;
  }>;
};
```

## 错误规则

| HTTP | error | 含义 |
| --- | --- | --- |
| 404 | `plugin_not_found` | 未知插件 id |
| 400 | `plugin_not_configurable` | 插件没有通用配置页 |
| 400 | `plugin_not_switchable` | 插件不能通过通用接口开关 |
| 400 | `invalid_plugin_config` | 配置字段非法 |
| 400 | `invalid_api_preset` | preset 不存在或不可用于当前插件 |
| 400 | `invalid_asset_path` | 资源路径不在插件 assets 目录内 |
| 400 | `invalid_asset_type` | 上传资源类型不符合目标字段 |
| 413 | `asset_too_large` | 上传资源超过大小限制 |
| 500 | `internal_error` | 未预期异常 |

## 示例插件

示例只能使用通用名称，例如：

- `plugin-example`
- `plugin-voice-example`

真实插件不要写成布局、接口或文档主设计对象。真实插件只作为 registry entry 接入通用系统。

## 暂不做

- 插件市场。
- 在线安装第三方插件。
- 插件评分、下载量、作者主页。
- 复杂权限审批流。
- 多租户插件策略。
