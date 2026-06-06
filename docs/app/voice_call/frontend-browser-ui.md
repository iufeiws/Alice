# Voice Call 浏览器前端界面设计

本文档定义 voice call 的浏览器通话界面。视觉参考见同目录示例图：`273c30ea-63cb-49b0-b618-73817df566f4.png`。

## 设计目标

- 首屏展示待拨打状态，由用户触发拨打动作；拨打期间用于加载 TTS、WebRTC、角色资源等后台服务。
- 适配手机浏览器优先；通话画面固定为 `9:16`，桌面窗口化时也按显示区域等比居中显示，不拉伸。
- 让用户明确知道当前通话状态、Alice 是否在说话、当前输入模式、是否处于等待状态，以及双方实时话语。
- 交互控制保持少而稳定；顶部承载挂断和画面收缩，底部承载输入模式切换、当前模式主控件和等待。
- 页面只负责通话展示和控制，不承载聊天历史、调试日志或配置入口。

## 页面结构

```text
VoiceCallPage
  DialScreen
    CallButton
    DesktopPopupButton
    PreloadStatus
  CallSurface
    AppBar
      HangupButton
      CallStatus
      CollapseFrameButton
    CharacterStage
      CharacterImage
      DecorativeFrame
    AudioActivity
      Waveform
      Local/Remote speaking state overlay
    RealtimeTranscript
      AliceTranscript
      UserTranscript
    CallControls
      ModeSwitchButton
      TextInput | HoldToTalkButton | RealtimeMuteButton
      WaitButton
  Permission/ErrorOverlay
```

## 视觉规格

整体风格参考示例图：

- 背景：深色低对比纹理或纯色底，避免大面积亮色。
- 主色：暖金色用于边框、文字和普通按钮图标；红色用于通话中状态点、波形峰值和危险操作按钮。
- 角色区域：居中大图，带细边框；图片应占据主要视觉面积。
- 拨打入口：待拨打状态是独立界面，不叠放在立绘或通话控制界面上。
- 角色区域：通话界面的立绘框固定为正方形，并从顶部工具栏下沿开始，不在工具栏和立绘之间留额外垂直间距。
- 音频波形：紧贴角色图下方，用于表达当前语音活动，并支持用户与 LLM/Alice 同时说话时的叠加显示。
- 音频波形底色必须透明，不使用可见面板、卡片、描边或底框。
- 画面比例：默认通话画面为固定 `9:16`；收缩后宽度保持不变，仅压缩高度，整体切换为固定 `4:3`。
- 桌面小窗：待拨打界面可提供桌面小窗入口，目标内容区为 `420x747`，打开后持续尝试校正窗口内容区尺寸。
- 顶部控制：左侧为挂断，右侧为收缩/展开；不再提供全屏按钮。
- 立绘控制：收缩动作由顶部右侧按钮触发；收缩后不是只缩小立绘，而是整体通话画面在原宽度下压缩为 `4:3`。
- 中部展示：展开时声纹位于立绘下方，声纹和底部输入区之间展示双方实时话语；收缩时声纹降低透明度，作为双方实时话语之间的背景。
- 底部控制：固定贴近页面底部，使用三列布局：输入模式切换、当前模式主控件、等待。
- 所有可点击控件使用方框或轻微圆角矩形，不使用圆形按钮。
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
surface:        fixed 9:16, centered in viewport
app bar:        64px
character:      square, min(100%, available viewport width, available height)
waveform:       68px, flush with character bottom
transcript:     flexible, between waveform and controls
controls:       104px, bottom aligned
bottom safe area
```

规则：

- 根容器默认使用固定 `aspect-ratio: 9 / 16`，宽高由当前视口和最大宽度共同约束。
- 桌面端窗口化时，画面尺寸基于显示器可用分辨率计算固定像素尺寸，并居中显示；浏览器窗口大小变化不应让通话画面重新拉伸或改变比例。
- 桌面小窗只能通过用户点击触发；浏览器可能忽略 `resizable=no`、`window.resizeBy()` 或 `moveTo()`，前端会在小窗内基于实际 `innerWidth/innerHeight` 每 5 秒尝试校正内容区尺寸，但不能保证强制锁定系统窗口大小。
- 小窗校正不得只依赖打开时的 `width/height` 参数；必须用实际内容区尺寸做闭环修正，以兼容系统缩放、浏览器边框和页面缩放差异。
- 小窗首次打开后可以按实际 `outerWidth/outerHeight` 移到屏幕最左侧并纵向居中；左侧贴边需要先请求 `screen.availLeft`，再读回实际 `screenX/screenLeft` 计算 shift 并用 `moveBy()` 校正。后续周期性尺寸校正不得自动 `moveTo()`，避免用户移动小窗后被拉回。
- 小窗内容区必须左上对齐通话画面；当浏览器最小窗口宽度大于目标内容区宽度时，不得把通话画面居中到右侧。
- 收缩状态宽度保持展开态宽度不变，仅收缩长边高度到 `width * 3 / 4`，整体保持 `4:3`。
- 收缩状态在视口顶端对齐，不做垂直居中。
- 收缩状态必须使用独立紧凑网格，立绘仍保持 `aspect-ratio: 1 / 1`，不得因 `4:3` 容器变成长方形或消失。
- 页面最大宽度建议为 `480px`，桌面端固定显示；收缩状态不得重新扩大或缩小宽度，只压缩高度。
- 待拨打状态使用独立 `DialScreen`，只承载拨打动作和必要的加载状态；通话工具栏、立绘、声纹和底部控制不作为拨打按钮的背景。
- `CharacterStage` 进入通话界面后紧接 `AppBar`，顶部不留状态 gap。
- `CharacterStage` 使用稳定 `aspect-ratio: 1 / 1`；立绘框必须是正方形。
- 展开状态下 `AudioActivity` 紧接 `CharacterStage`，声纹顶部贴住立绘框底部，不留额外 margin。
- 收缩状态下 `AudioActivity` 与 `RealtimeTranscript` 共用同一行，声纹低透明显示在双方记录中间的背景层。
- 展开状态下 `RealtimeTranscript` 位于声纹和底部控制之间，用弹性高度承接剩余视口。
- `CallControls` 固定在页面底部；底部控制不能随着键盘、模式切换或输入内容发生横向重排。
- 底部控制区高度固定，输入框内容、按钮状态变化不能导致布局位移。
- 任何文本都不得覆盖角色脸部、波形或控制按钮。

## 顶部状态栏

顶部左侧是挂断按钮，中间是状态，右侧是收缩/展开按钮。

顶部按钮：

| 控件 | 行为 |
| --- | --- |
| 挂断 | 发送 `{ type: "hangup", reason: "manual" }`，关闭本地连接并进入 ended。 |
| 收缩/展开 | 切换整体画面比例：展开为 `9:16`，收缩时宽度不变、高度压缩为 `4:3`。 |

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

待拨打状态不显示通话工具栏和通话控制区，也不启动 WebRTC 通话计时。用户点击拨打后进入 `preloading`，用于预热 TTS、WebRTC peer、角色资源和必要的后端 session。通话中状态左侧显示红色小圆点。计时从 WebRTC connected 或服务端确认 `call.started` 后开始，以服务端状态为准。

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
- 首版默认立绘资源为 `docs/app/voice_call/alice-default-portrait.png`，通过 `/voice-call/assets/alice-default-portrait.png` 提供给前端。
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
- canvas 背景保持透明，禁止绘制整块底色；声纹区域不能看起来像一个独立框或卡片。

实现建议：

- 使用 canvas 绘制，避免大量 DOM 节点更新。
- canvas 内部维护至少两条声源轨：`localUser` 和 `remoteAlice`。
- `requestAnimationFrame` 驱动，页面隐藏时暂停绘制。
- 波形容器固定高度，活动幅度只改变绘制内容，不改变布局。

## 通话控制

当前通话界面使用两处控制区：顶部挂断/收缩，底部输入模式控制。

控制项：

| 控件 | 默认状态 | 点击行为 |
| --- | --- | --- |
| 模式切换 | 文字输入 | 在 `长按录音`、`实时录音`、`文字输入` 三种模式间循环；发送 `{ type: "input-mode", mode }`。 |
| 长按录音主控件 | 未按下 | 按下时发送 `{ type: "hold-to-talk", active: true }`，松开/取消时发送 `{ type: "hold-to-talk", active: false }`。 |
| 实时录音主控件 | 未静音 | 点击切换静音；发送 `{ type: "mute", muted: boolean }`，并同步 local audio track `enabled`。 |
| 文字输入主控件 | 空 | `Enter` 发送 `{ type: "text-input", text }` 并清空输入框；`Shift+Enter` 换行。 |
| 等待 | 未等待 | 切换等待状态；发送 `{ type: "wait", active: boolean }`。 |
| 桌面小窗 | 普通页面 | 在用户点击下调用 `window.open()` 打开 `?window=1` 的 `9:16` 小窗，并在新窗口中按当前展开/收缩状态持续尝试 `resizeBy()` 校正内容区尺寸；仅首次打开后移到屏幕最左侧。 |
| 顶部挂断 | 通话中 | 发送 `{ type: "hangup", reason: "manual" }`，关闭 peer connection，进入 ended。 |
| 顶部收缩 | 展开 | 宽度不变，仅压缩高度到 `4:3` 收缩状态；再次点击恢复 `9:16`。 |

按钮规则：

- 等待按钮放在底部右侧，不显示文字标签。
- 等待按钮图标使用纯暂停图标，避免电话方向造成挂断语义或图标错位。
- 模式切换按钮放在底部左侧，不显示文字标签，并显示“下一个模式”的图标：文字输入对应键盘，长按录音对应对讲机，实时录音对应右上方向听筒。
- 当前模式主控件位于底部中间；长按录音显示长按说话键，实时录音显示静音键，文字输入显示输入框。
- 所有底部控件和顶部控件均为方框或轻微圆角矩形，不使用圆形按钮。
- 图标优先使用现有 icon 库；没有时再用内联 SVG。
- 每个图标按钮必须有 `aria-label`。
- 控件不显示外露文字标签；状态变化通过图标状态、`aria-label` 和顶部状态/实时字幕体现。
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
  -> render independent DialScreen
  -> user taps call
  -> render preloading
  -> switch to CallSurface
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
  inputMode: "hold_to_talk" | "realtime_voice" | "text";
  waiting: boolean;
  muted: boolean;
  portraitCollapsed: boolean;
  inputText: string;
  aliceTranscript: string;
  userTranscript: string;
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
- 文字输入使用原生 `textarea`，支持 `Enter` 发送、`Shift+Enter` 换行。
- 移动端输入字号不得低于 `16px`，并设置 viewport 限制，避免 iOS Safari 聚焦输入框时自动缩放。
- 手机收缩状态下聚焦输入框时，页面本身保持锁定在顶部，不应因为浏览器默认滚动把通话画面整体上推；需要在输入聚焦和 visual viewport 变化时复位页面滚动。
- 状态变化通过 `aria-live="polite"` 暴露给辅助技术。
- 移动端点击目标不小于 `48px`。
- 支持 iOS Safari、Android Chrome、桌面 Chrome。
- 不提供全屏按钮；iOS Safari 普通页面无法可靠隐藏浏览器系统栏，固定比例画面应在可见视口内稳定布局。
- 页面刷新、关闭或隐藏时不得发送手动挂断；应发送 `{ type: "hold", reason }`，由后端把通话 session 标记为可恢复或暂停。

## 实现边界

- 主音频必须通过 WebRTC track，不通过 WebSocket chunk 或 HTTP 音频 URL。
- 页面不保存原始音频。
- 页面不直接写 `messages`、`message_logs` 或其他持久消息表。
- 通话 session id、call id 和连接状态由 voice call plugin 或 API 返回。
- 浏览器页面只发送控制事件：`hello`、`offer`、`ice`、`input-mode`、`hold-to-talk`、`mute`、`wait`、`text-input`、`interrupt`、`hold`、`hangup` 和必要的 UI 状态；不通过 WebSocket 发送主音频。

## 首版验收

- 打开通话页后先看到独立拨打界面。
- 点击拨打后能看到完整角色舞台、顶部状态、声纹、实时话语区和底部三列控制。
- 点击拨打后进入预载入状态，用于加载 TTS、WebRTC、立绘等后台服务。
- 授权麦克风后能建立 WebRTC 连接，并显示 `通话中` 与计时。
- 顶部挂断能关闭连接并进入 ended。
- 顶部右侧收缩按钮能在宽度不变的前提下把整体画面从 `9:16` 压缩为 `4:3`，并顶端对齐；再次点击恢复。
- 底部三列控制稳定贴在页面底部，模式切换、输入和等待状态不能造成布局跳动。
- 文字模式下 `Enter` 发送、`Shift+Enter` 换行；长按录音和实时录音模式下中间主控件按各自语义展示。
- 用户和 Alice/LLM 说话时波形有明显活动反馈；两者同时说话时能叠加展示。
- LLM tool call 能驱动静态立绘切换；首版不要求口型动画。
- 移动端和桌面端布局不重叠、不跳动，角色图和控制按钮始终可见。
