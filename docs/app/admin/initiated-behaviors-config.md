# 后台主动行为配置页

主动行为配置页用于查看和编辑 `src/contexts/initiative` 的行为计划、prompt layers 和运行记录。行为语义见 `docs/core/agent/initiated-behaviors.md`。

## 入口

后台管理页提供 Initiated Behaviors 标签页。页面读取真实 API 返回的行为列表，不在前端维护行为语义。

## 页面内容

列表页展示：

- 行为 id
- kind
- trigger event
- enabled
- dry run
- priority 或 weight
- 最近运行结果
- 配置入口

配置页展示：

- 基础开关和权重。
- prompt layers 编辑器。
- steps 只读结构。
- recent runs。
- 30 分钟响应统计。

## Prompt Layers

行为 prompt profile 文件位于 `src/contexts/initiative/behaviors/`。页面编辑的是可见 layer 数据；运行时使用公共 prompt layer 解析入口构筑 LLM messages。

任何新增固定说明都必须先成为可见 layer，不能在运行时隐藏拼接。

## Run 记录

运行记录写入 initiated behavior run store，记录：

- behavior id
- trigger
- dry run
- result
- session id
- steps result
- 15 分钟内是否收到用户响应

## 边界

后台页面只负责配置和展示，不负责生成行为语义、不绕过 ToolPlugin、不决定 tool 是否可用。
