---
name: alice-selfie-fast
description: 当外部 agent 需要通过 Alice 当前自拍流程快速生成 Alice 自拍，或需要在 5 分钟内完成 Alice 自拍生成时使用。触发后立即运行快速命令；除非命令失败，否则不要先检查仓库。
---

# Alice 快速自拍

## 立即执行

不要先浏览仓库、读取日志、检查 prompt 或制定计划。立即运行一次低质量 API 自拍：

```bash
node Skill/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs "<short action>"
```

如果用户没有提供动作，使用：

```bash
node Skill/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs "lean close to the camera, tilt her head slightly, with a shy expression"
```

正常成功响应：只报告命令输出的文件路径和耗时。

## 固定设置

runner 已经强制使用一张图、`gpt-image-2`、`768x1024`、`low`、`jpeg`、compression `45` 和 120 秒 API timeout。普通快速自拍请求不要覆盖这些设置。

## 仅在失败时

- API error：报告 HTTP status 和第一行有用错误。
- Timeout：报告 API 没有在快速预算内返回。
- Missing reference：报告缺失路径。
