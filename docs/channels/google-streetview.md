# Google Street View Channel

Google Street View channel 位于 `src/channels/google-streetview`。

## 功能

该 channel 使用 Google Static Street View 获取街景图片，并把结果作为图片能力提供给上层流程。

## 配置

配置包含 API key、图片尺寸、视角、输出目录等字段。当前存储实现使用配置的输出目录保存生成文件。

## 注意

历史计划中提到按 `<yyyy-mm>/` 分目录保存；当前实现是 flat 输出目录。判断当前行为以 `src/channels/google-streetview/src/storage.ts` 为准。
