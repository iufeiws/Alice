# 后台管理器 Terminal 日志面板设计

本文档定义后台管理页新增一个类似 VS Code Terminal 的可收缩底部终端，并把当前主导航里的 `Message Log`、`Event Log`、`System Log` 移入该终端。

## 背景

当前后台管理页的三类日志是主内容区的一级 tab：

- `Message Log`
- `Event Log`
- `System Log`

这些日志更像运行时观察窗口，不应该和 `Prompt`、`Memory`、`Plugin`、`Tool Preview` 这类主要工作页平级。迁移后，主导航保留业务管理页，日志进入一个全局可见、可收缩的底部终端。

## 目标

- 新增全局底部终端，视觉和交互参考 VS Code Terminal 面板。
- 终端支持展开、收起、最小化三种常用状态。
- 终端内提供 `Active Session`、`Message`、`Event`、`System` 四个 tab。
- 终端每秒自动刷新；右侧暂停按钮只暂停自动刷新，不负责收放。
- 从主导航移除 `Message Log`、`Event Log`、`System Log`。
- 保留现有日志数据源和渲染内容，不改变后端 API。
- 不影响左侧配置面板的现有收缩按钮。

## 非目标

- 不引入真实 shell 命令执行能力。
- 不改日志存储结构。
- 不新增日志搜索、过滤、复制、下载等能力；后续可以作为增强项。
- 不把 `LLM Sessions`、`Prompt Preview` 或 `Plugin Recent Events` 合并进终端。

## 布局

主页面改为三层结构：

```text
┌──────────────────────────────────────────────────────────────┐
│ left admin panel                  main admin workspace        │
│                                                              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ TERMINAL  Active Session | Message | Event | System [_] [^/v]│
│ ──────────────────────────────────────────────────────────── │
│ log line                                                     │
│ log line                                                     │
└──────────────────────────────────────────────────────────────┘
```

终端固定在 admin shell 底部，横跨左侧面板和主内容区。原因是日志是全局运行时观察窗口，不属于某个主 tab，也不应在切换主 tab 时消失。

推荐尺寸：

| 状态 | 高度 | 说明 |
| --- | --- | --- |
| expanded | `32vh`，最小 `220px`，最大 `45vh` | 默认展开高度 |
| collapsed | `38px` | 只显示终端标题栏和当前日志状态 |
| hidden/minimized | `0` 或不渲染内容区 | 由标题栏按钮恢复 |

移动端：

- 终端仍在页面底部。
- 展开高度使用 `40vh`。
- tab 标签可以缩短为 `Msg`、`Event`、`System`，但 accessible label 保留完整名称。

## 交互

标题栏包含：

- 标题：`Terminal`
- tab：`Active Session`、`Message`、`Event`、`System`
- 刷新按钮：立即刷新 Terminal 全部内容。
- 暂停刷新按钮：暂停或恢复每秒自动刷新。
- 展开/收起：点击标题栏空白区域切换，不占用暂停按钮。

默认行为：

- 页面首次加载时终端默认展开。
- 当前 tab 默认 `System`，因为系统日志最适合作为运行时总览。
- 用户点击 `Active Session`、`Message`、`Event`、`System` 时只切换终端内部内容，不切换主内容页。
- `Active Session` 每行显示当前 active LLM session 的最新 message；如果最新 request 还没有对应 response，则显示 `waiting`。
- Terminal 默认每秒自动刷新一次；暂停后保留当前内容，直到用户手动刷新或恢复自动刷新。
- 用户切换主内容 tab 时，终端保持当前展开状态和当前日志 tab。

滚动行为：

- 每个日志 tab 使用独立滚动容器。
- 刷新后保持现有行为：日志滚动到底部。
- 切换终端 tab 时保留各自的 `scrollTop`，避免用户正在查看历史日志时被重置。

## 数据源

继续使用现有接口：

| 终端 tab | 元素 | 接口 |
| --- | --- | --- |
| Active Session | `activeSessionLogs` | `GET /admin/api/llm-requests` |
| Message | `messageLogs` | `GET /admin/api/message-logs` |
| Event | `eventLogs` | `GET /admin/api/message-event-logs` |
| System | `logs` | `GET /admin/api/logs` |

`refreshLogs()` 可以继续一次性刷新三类日志。实现时只移动 DOM 容器和 tab 控制，不改变 API 返回格式。

## 实现入口

主要实现文件：

```text
apps/api/src/admin-html.ts
```

需要调整的位置：

- 主导航：删除 `data-main-tab="messages"`、`data-main-tab="events"`、`data-main-tab="system"` 三个按钮。
- 主内容 section：删除或迁移 `main-messages`、`main-events`、`main-system`。
- `setTabs("main", ...)`：从主 pane 列表移除三个日志 pane。
- 新增终端 DOM：放在 `.shell` 内，作为 `aside` + `main` 的同级或通过 shell grid 的底部区域实现。
- 新增终端 CSS：包含标题栏、内部 tab、展开/收起状态、日志容器高度。
- 新增终端 JS 状态：`activeTerminalTab`、`terminalCollapsed`，以及 tab 绑定事件。
- `refreshLogs()`：继续写入 `logs`、`messageLogs`、`eventLogs` 三个元素。

建议结构：

```html
<div id="adminTerminal" class="admin-terminal">
  <div class="admin-terminal-head">
    <strong>Terminal</strong>
    <button data-terminal-tab="active-session">Active Session</button>
    <button data-terminal-tab="system">System</button>
    <button data-terminal-tab="messages">Message</button>
    <button data-terminal-tab="events">Event</button>
    <button id="terminalRefresh" type="button">Refresh</button>
    <button id="terminalCollapse" type="button">Pause</button>
  </div>
  <div class="admin-terminal-body">
    <div id="terminal-active-session" class="terminal-pane"><div id="activeSessionLogs" class="logs">Loading...</div></div>
    <div id="terminal-system" class="terminal-pane active"><div id="logs" class="logs">Loading...</div></div>
    <div id="terminal-messages" class="terminal-pane"><div id="messageLogs" class="logs">Loading...</div></div>
    <div id="terminal-events" class="terminal-pane"><div id="eventLogs" class="logs">Loading...</div></div>
  </div>
</div>
```

最终实现不需要完全照抄上面的 HTML，但元素 id 应保持兼容，避免重写已有日志刷新逻辑。

## 视觉规范

- 终端背景使用深色，延续现有 `.logs` 的黑底风格。
- 标题栏使用略浅的深色，和主页面白底区分明确。
- 内部 tab 使用紧凑按钮，不使用主页面的大号 `.tab` 视觉。
- 终端整体不使用卡片样式；它是固定工具面板。
- 日志字体继续使用等宽字体。
- 控件文字必须在移动端不溢出。

## 验收标准

- 主导航中不再出现 `Message Log`、`Event Log`、`System Log`。
- 页面底部出现 `Terminal` 面板。
- 终端里可以在 `Active Session`、`Message`、`Event`、`System` 四类内容之间切换。
- `Active Session` 可以显示当前 session 的最新 message；等待 LLM 返回时显示 `waiting`。
- 三类日志内容和迁移前一致。
- 终端可收缩，收缩后不遮挡主内容操作。
- 切换主内容 tab 不会重置终端当前 tab。
- 页面首次加载和点击刷新都能正常调用现有日志接口。
- Terminal 默认每秒自动刷新；点击暂停按钮后停止自动刷新，再点击恢复。
- TypeScript/typecheck 通过。
