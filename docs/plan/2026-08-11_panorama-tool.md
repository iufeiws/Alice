# Panorama 工具扩展方案

## 概要

将现有 `check_location` 替换为单一 `Panorama` 工具，通过 `action` 提供三种能力：

- `current`：保持原 `check_location` 行为，返回当前位置、街景记录日期和图片识别结果。
- `teleport`：查找输入坐标最近的 pano，将其设为 World Wanderer 新起点、重置历史轨迹并清除导航目标。
- `navigation`：只把输入坐标保存为 World Wanderer 的 `targetLocation`，后续沿用现有选路和到达逻辑。

不保留 `check_location` 兼容入口，不增加隐藏 prompt 或运行时 prompt 拼接。

## 接口与实现

- `Panorama` 使用 `oneOf` schema：

  ```ts
  type PanoramaInput =
    | { action: "current" }
    | { action: "teleport"; lat: number; lng: number }
    | { action: "navigation"; lat: number; lng: number };
  ```

- `lat` 限制为 `[-90, 90]`，`lng` 限制为 `[-180, 180]`；执行层再次校验有限数值、范围、action 和必需字段，非法输入返回明确工具错误。
- LLM 可见 description 固定为：

  ```text
  街景与世界漫游控制。action=current 查看当前现实位置与街景内容；action=teleport 按经纬度传送到最近 pano、重置轨迹并清除导航目标；action=navigation 将 World Wanderer 的导航目标设为指定经纬度。
  ```

- `current` 复用现有实现：从持久化状态解析当前 pano，返回地址、记录日期和 `recognizeImage: true` 的识别文本。
- `teleport` 调用 `getPanoGraphByCoordinates({ lat, lng })`：

  1. 在任何持久化修改前解析最近 pano 和可读地址。
  2. 地址不存在时返回 `location_address_unavailable`，位置、轨迹和导航目标均不修改。
  3. 成功时用该 pano 的实际位置、`panoId` 和 `heading` 建立唯一轨迹记录。
  4. 使用配置时区的 wall-clock ISO 作为轨迹时间，不写 UTC `Z` 时间戳。
  5. 删除配置中的 `targetLocation`。
  6. 仅返回可读地址，不返回坐标、panoId、记录日期或图片识别内容。

- `navigation` 通过现有配置读写入口保存 `{ lat, lng }` 为 `targetLocation`，不立即请求 pano、不修改当前位置或轨迹；返回保存后的目标坐标，不触发图片识别。
- 工具仅在 World Wanderer 启用时暴露；执行期间被禁用则返回现有 `location_unavailable`。
- 保持当前模块结构，复用 `read/writeWorldWandererConfig`、`writeWorldWandererState`、`pathEntryFromPano` 和统一坐标校验，不引入兼容 fallback 或吞错 `try/catch`。
- 同步更新 Google Street View 说明和 `project_summary.md`，将工具名及三个 action 的行为写明。

## 测试计划

- 工具暴露：启用时只列出 `Panorama`，禁用时不列出；`check_location` 被视为未知工具。
- Schema 与执行校验：覆盖三个合法 action、缺少坐标、非数值、越界坐标、未知 action 和多余字段。
- `current`：保持原地址、记录日期、图片识别调用及输出格式。
- `teleport`：

  - 使用输入坐标查询最近 pano。
  - 成功后轨迹仅含该 pano，位置取 pano 实际坐标，朝向取 pano heading。
  - 已有导航目标被清除。
  - 返回地址且不触发图片识别、不暴露坐标或 panoId。
  - 地址缺失时返回错误，原轨迹和目标配置完全不变。
  - Street View 查询失败时错误向上传播，持久化状态不变。

- `navigation`：

  - 精确保留输入坐标为 `targetLocation`。
  - 不调用 Street View，不改变当前 pano、朝向和轨迹。
  - 后续 idle transition 继续使用既有目标选路及 50 米到达清除逻辑。

- 运行定向测试、World Wanderer 测试、`npm run typecheck` 和 `npm run build`。

## 已确认假设

- 工具名大小写固定为 `Panorama`，action 固定为 `current | teleport | navigation`。
- `teleport` 是新旅程起点，不保留旧轨迹，并清除已有导航目标。
- `teleport` 后朝向采用最近 pano 的 heading。
- `teleport` 必须取得可读地址才执行状态修改。
- `teleport` 与 `navigation` 不做图片识别；只有 `current` 保留原识别行为。
- 不迁移或兼容旧 `check_location` 调用。
