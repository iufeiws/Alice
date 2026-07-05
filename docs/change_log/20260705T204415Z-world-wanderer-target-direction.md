# World Wanderer 目标方向策略

日期：2026-07-06

## 背景

World Wanderer 原先只按最近历史、前进方向、道路连续性和 U-turn 惩罚选择下一个 Street View pano。需要支持一个可配置目标坐标，让游荡时倾向朝目标移动；到达目标附近后清除目标，恢复原有游荡策略。

本次实现不做 A* 图搜索。Street View 运行时只稳定持有当前 pano 的链接，预展开多层 pano 会增加 API 请求和延迟；当前需求只需要方向性目标选择，因此在既有 link 打分 policy 中加入目标方位分。

## 变更内容

- `WorldWandererConfig` 新增可选 `targetLocation` 坐标。
- `chooseNextLink` 支持按目标方位加分，权重复用 `forwardWeight`，与保持当前方向同级。
- 新增 `bearingDegrees` 地理 helper，用于计算当前位置指向目标坐标的方位角。
- World Wanderer runtime 在距离目标 50 米内时清除 config 中的 `targetLocation`。
- 新增测试覆盖目标方向选择和到达目标后清除配置。

## 兼容性

- 不新增 prompt，也不改变 prompt layer 顺序。
- 不获取目标 pano，只使用目标坐标。
- 不保留 A* 或多层 pano 搜索 fallback。
- 没有 `targetLocation` 时继续使用原有游荡策略。

## 验证

已执行：

```bash
node --import tsx --test tests/contexts/world-wanderer/*.test.ts
npm run typecheck
npm test
```

结果：

- World Wanderer 测试通过。
- TypeScript 类型检查通过。
- 完整测试通过。
