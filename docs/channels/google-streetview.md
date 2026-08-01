# Google Street View Channel

Google Street View channel 位于 `src/channels/google-streetview`。

## 功能

该 channel 使用 Google Static Street View 获取街景图片，并把结果作为图片能力提供给上层流程。

`getStreetViewByCoordinates` 和 `getRandomStreetView` 接受可选的 `recognizeImage` 参数。默认值为 `false`，只获取或复用街景图片；传入 `true` 时，会在取图后调用已注入的图片识别能力，并把识别结果写入对应 `panoId` 的 Google Street View 元数据缓存。后续对同一 `panoId` 的识别请求直接复用缓存结果。

拍照流程使用默认取图行为，不触发图片识别。`check_location` 会显式传入 `recognizeImage: true`，并将识别文本与地点信息一起返回。

## 配置

配置包含 API key、图片尺寸、视角、输出目录等字段。当前存储实现使用配置的输出目录保存生成文件。

## 注意

历史计划中提到按 `<yyyy-mm>/` 分目录保存；当前实现是 flat 输出目录。判断当前行为以 `src/channels/google-streetview/src/storage.ts` 为准。
