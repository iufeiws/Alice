# Voice Call 浏览器前端界面设计

本文档定义 voice call 的浏览器通话界面。视觉参考见同目录示例图：`273c30ea-63cb-49b0-b618-73817df566f4.png`。

## 设计目标

- 首屏展示待拨打状态，由用户触发拨打动作；拨打期间用于加载 TTS、WebRTC、角色资源等后台服务。
- 适配手机浏览器优先，同时在桌面浏览器中保持居中窄屏电话界面。
- 让用户明确知道当前通话状态、Alice 是否在说话、麦克风是否打开、扬声器是否打开。
- 交互控制保持少而稳定；示例图底部三枚控制键目前只代表控制区占位，不代表最终一定使用静音、挂断、扬声器。
- 页面只负责通话展示和控制，不承载聊天历史、调试日志或配置入口。

## 页面结构

```text
VoiceCallPage
  AppBar
    CollapseButton
    CallStatus
    MoreButton
  CharacterStage
    CharacterImage
    DecorativeFrame
  CallEntry
    CallButton
    PreloadStatus
  AudioActivity
    Waveform
    Local/Remote speaking state overlay
  CallControls
    PlaceholderActionButton
    PrimaryActionButton
    PlaceholderActionButton
  Permission/ErrorOverlay
```

## 视觉规格

整体风格参考示例图：

- 背景：深色低对比纹理或纯色底，避免大面积亮色。
- 主色：暖金色用于边框、文字和普通按钮图标；红色用于通话中状态点、波形峰值和危险操作按钮。
- 角色区域：居中大图，带细边框；图片应占据主要视觉面积。
- 音频波形：放在角色图下方，用于表达当前语音活动，并支持用户与 LLM/Alice 同时说话时的叠加显示。
- 底部控制：三枚圆形按钮等距排列；当前只是占位控制区，具体功能待通话产品流程确定。
- 装饰元素只服务于氛围，不应影响按钮命中区域和状态可读性。

建议 CSS token：

```css
:root {
  --call-bg: #151311;
  --call-panel: #211d19;
  --call-gold: #d7aa77;
  --call-gold-muted: #8b6847;
  --call-red: #d94b4b;
  --call-red-dark: #7f1f1f;
  --call-text: #f0d0aa;
  --call-text-muted: #b8926b;
}
```

## 布局

移动端按 `100dvh` 布局，避免地址栏收起造成高度跳动。

```text
top safe area
app bar:        64px
status gap:     8px
character:      min(72vw, 58dvh)
waveform:       68px
controls:       128px
bottom safe area
```

规则：

- 根容器使用 `min-height: 100dvh`。
- 页面最大宽度建议为 `480px`，桌面端居中显示。
- `CharacterStage` 使用稳定 `aspect-ratio: 1 / 1.08` 或基于角色图资源的固定比例。
- 底部控制区高度固定，按钮状态变化不能导致布局位移。
- 任何文本都不得覆盖角色脸部、波形或控制按钮。

## 顶部状态栏

顶部左侧是收起按钮，中间是状态，右侧是更多菜单。

状态文案：

| 状态 | 主文案 | 副文案 |
| --- | --- | --- |
| `idle` | 准备通话 | 点击拨打后开始 |
| `preloading` | 准备中 | 正在加载语音服务 |
| `permission_required` | 需要麦克风权限 | 点击允许后继续 |
| `connecting` | 连接中 | 正在建立通话 |
| `ringing` | 呼叫中 | 等待 Alice 接听 |
| `connected` | 通话中 | `mm:ss` |
| `reconnecting` | 重连中 | 保持页面打开 |
| `ended` | 已挂断 | 通话已结束 |
| `error` | 通话异常 | 简短错误原因 |

待拨打状态不启动 WebRTC 通话计时。用户点击拨打后进入 `preloading`，用于预热 TTS、WebRTC peer、角色资源和必要的后端 session。通话中状态左侧显示红色小圆点。计时从 WebRTC connected 或服务端确认 `call.started` 后开始，以服务端状态为准。

## 角色舞台

角色舞台展示 Alice 的当前通话形象。首版立绘是静态资源，不要求口型动画；立绘变化由 LLM tool call 选择展示框中的静态立绘或表情资源。

首版建议状态：

| 状态 | 表现 |
| --- | --- |
| idle | 默认待拨打静态立绘。 |
| preloading | 保持静态立绘，可显示轻量加载状态。 |
| listening | 通话中的静态立绘，边框状态可弱高亮。 |
| user_speaking | 波形响应本地麦克风输入，角色保持 listening。 |
| llm_portrait_changed | LLM tool call 指定新的静态立绘或表情资源。 |
| alice_speaking | 角色图保持当前静态立绘；波形高亮远端输出。 |
| interrupted | 停止远端输出状态，回到 listening。 |
| disconnected | 图片降低亮度，显示连接状态。 |

图片资源要求：

- 首屏必须有可见角色图，不使用纯渐变、抽象图或空占位。
- 角色图使用 `object-fit: cover` 或 `contain`，按资源裁切效果选择其一。
- 立绘切换由后端或 LLM tool call 下发资源 id，前端负责预加载和淡入切换。
- 具体动画效果后续再定；首版不把口型、Live2D、视频或 canvas 动画作为必需能力。
- 如后续接入 Live2D、视频或 canvas，仍保持同一舞台尺寸和控制区位置。

## 音频波形

波形用于展示实时语音活动，不作为音量设置控件。波形必须支持叠加显示，因为可能存在用户说话和 LLM/Alice 输出同时发生的情况。

输入来源：

- 本地麦克风：`AnalyserNode` 读取 local audio track。
- Alice 语音：远端 WebRTC audio track 进入 Web Audio 后读取输出活动。

显示规则：

- 用户说话时，绘制一层本地麦克风波形。
- Alice/LLM 说话时，绘制一层远端输出波形。
- 两者同时发生时，两层波形叠加显示，可以用上下镜像、不同颜色、透明度或前后景层次区分。
- 静默时保留低幅度点线，避免看起来像断线。
- 连接中或权限未授予时显示非活动状态。

实现建议：

- 使用 canvas 绘制，避免大量 DOM 节点更新。
- canvas 内部维护至少两条声源轨：`localUser` 和 `remoteAlice`。
- `requestAnimationFrame` 驱动，页面隐藏时暂停绘制。
- 波形容器固定高度，活动幅度只改变绘制内容，不改变布局。

## 底部控制

底部三枚按钮目前是控制区占位，示例图中的静音、挂断、扬声器不能视为最终功能确认。当前设计只要求保留稳定的三按钮布局，以便后续替换为正式控制项。

可选控制项示例：

| 控件 | 默认状态 | 点击行为 |
| --- | --- | --- |
| 静音 | 麦克风打开 | 切换 local audio track `enabled`；发送 `mute_changed` 控制状态。 |
| 挂断 | 通话中 | 发送 `hangup`，关闭 peer connection，进入 ended。 |
| 扬声器 | 扬声器打开 | 移动端尽量切换输出设备；不可用时只切换远端 audio muted。 |
| 打断 | Alice 输出中 | 发送 `interrupt`，停止远端播放队列。 |
| 重拨 | 已结束 | 重新进入拨打和预载入流程。 |
| 录音提示 | 通话中 | 展示或切换合规提示状态，具体产品需求待定。 |

按钮规则：

- 主操作按钮建议始终居中；如果最终采用挂断，它应位于中间且视觉权重最高。
- 图标优先使用现有 icon 库；没有时再用内联 SVG。
- 每个图标按钮必须有 `aria-label`。
- 文案标签固定在按钮下方，具体文本随最终功能确定。
- 任何控制项状态切换后，图标和标签状态都要可区分。

## 权限与错误

麦克风权限弹层在页面内呈现，不跳转。

权限未授权：

- 展示标题：`需要麦克风权限`
- 展示操作按钮：`开启麦克风`
- 用户点击后调用 `navigator.mediaDevices.getUserMedia({ audio: true })`

常见错误：

| 错误 | 展示 |
| --- | --- |
| 麦克风被拒绝 | 请在浏览器设置中允许麦克风访问。 |
| 信令连接失败 | 无法连接通话服务。 |
| WebRTC 建立失败 | 通话连接失败，请重试。 |
| 远端音频播放失败 | 点击页面后继续播放。 |
| 服务端挂断 | Alice 已结束通话。 |

错误弹层应保留 `重试` 和 `退出` 两个动作。重试只重建通话连接，不刷新整个应用。

## 交互流程

进入页面：

```text
load page
  -> render idle call entry
  -> user taps call
  -> render preloading
  -> preload TTS/WebRTC/portrait assets/backend session
  -> request microphone after user action if needed
  -> open signaling WebSocket
  -> create RTCPeerConnection
  -> add local audio track
  -> exchange offer/answer/ICE
  -> receive remote audio track
  -> connected
```

挂断：

```text
tap hangup
  -> send { type: "hangup", reason: "manual" }
  -> stop local tracks
  -> close peer connection
  -> close signaling socket
  -> render ended
```

打断 Alice：

```text
user starts speaking while alice_speaking
  -> detect barge-in from local analyser or VAD
  -> send { type: "interrupt", reason: "barge_in" }
  -> stop remote output speaking state
  -> keep call connected
```

## 前端状态模型

```ts
type VoiceCallPhase =
  | "idle"
  | "preloading"
  | "permission_required"
  | "connecting"
  | "ringing"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

type SpeakingSide = "none" | "user" | "alice";
type SpeakingLayer = "localUser" | "remoteAlice";

type VoiceCallUiState = {
  phase: VoiceCallPhase;
  speakingSide: SpeakingSide;
  activeSpeakingLayers: SpeakingLayer[];
  muted: boolean;
  speakerEnabled: boolean;
  elapsedSeconds: number;
  errorMessage?: string;
};
```

状态来源优先级：

1. 服务端 signaling status。
2. WebRTC connection state。
3. LLM tool call 下发的立绘状态。
4. 本地 media permission state。
5. 本地和远端 analyser 推导的 speaking layers。

UI 不应把 ASR partial 或内部 debug 状态直接展示给用户。需要调试时放到开发者面板或 admin 页面。

## 无障碍与浏览器兼容

- 所有按钮提供 `aria-label`。
- 危险操作或主操作按钮使用 `button` 元素，不用 `div` 模拟。
- 状态变化通过 `aria-live="polite"` 暴露给辅助技术。
- 移动端点击目标不小于 `48px`。
- 支持 iOS Safari、Android Chrome、桌面 Chrome。
- `setSinkId` 不可用时，扬声器按钮降级为远端音频静音切换，并在更多菜单中显示设备切换不可用。

## 实现边界

- 主音频必须通过 WebRTC track，不通过 WebSocket chunk 或 HTTP 音频 URL。
- 页面不保存原始音频。
- 页面不直接写 `messages`、`message_logs` 或其他持久消息表。
- 通话 session id、call id 和连接状态由 voice call plugin 或 API 返回。
- 浏览器页面只发送控制事件：`hello`、`offer`、`ice`、`interrupt`、`hangup` 和必要的 UI 状态；最终按钮功能未确定时，不应为了匹配示例图额外固化控制协议。

## 首版验收

- 打开通话页后能看到完整角色舞台、顶部状态、拨打入口、波形和三枚占位控制按钮。
- 点击拨打后进入预载入状态，用于加载 TTS、WebRTC、立绘等后台服务。
- 授权麦克风后能建立 WebRTC 连接，并显示 `通话中` 与计时。
- 三枚底部按钮作为占位控制区稳定展示；最终功能确定前，不把静音、挂断、扬声器作为必选验收项。
- 如果最终采用静音、挂断或扬声器，对应按钮必须实际影响 local audio track、连接生命周期或远端音频播放状态。
- 用户和 Alice/LLM 说话时波形有明显活动反馈；两者同时说话时能叠加展示。
- LLM tool call 能驱动静态立绘切换；首版不要求口型动画。
- 移动端和桌面端布局不重叠、不跳动，角色图和控制按钮始终可见。
