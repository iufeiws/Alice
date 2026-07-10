# Shell / Persona / Wardrobe 层级重构计划

日期：2026-07-10

## 目标

调整当前 shell 相关层级与命名：

- 将 shell 相关能力移动到 `content` 层级下。
- 原 shell 中表示人格/外壳文本的部分改名为 `persona`。
- 将 `outfit` 从 shell 体系中移出，作为独立 `wardrobe` 能力。
- 新 context 目录固定为 `src/contexts/persona` 与 `src/contexts/wardrobe`。
- 删除代码与 API 中把 `outfit` 视为 shell 子资源的命名。

最终结构表达为：

```text
src/contexts/persona/
src/contexts/wardrobe/
```

## 非目标

- 不新增、前置、追加或包裹任何 prompt 内容。
- 不改变 prompt layer 顺序。
- 不新增旧 shell API 的兼容 fallback。
- 不改变 tool 是否可用的判断路径。
- 不改变 outfit / wardrobe 的业务语义，只改归属边界和命名。
- 不在本计划中设计新的 UI 功能。

## 当前问题

当前 shell 命名混合了三类职责：

- daily shell / personality：描述当前人格、外壳或表达风格。
- outfit：描述服装资源、图片、on-body 生成状态。
- Shell tool / admin shell routes：同时操作人格与服装。

这导致 `outfit` 被表达为 shell 的子资源，但从业务上看它更接近衣橱资源；同时 `shell` 作为能力名过宽，会和运行 shell / Bash 语义产生歧义。

## 目标边界

### persona

`src/contexts/persona` 负责当前原 shell 中的人格侧资源：

- persona 列表、分组、排序。
- daily persona 选择。
- persona prompt template 或 persona preview 中与人格文本直接相关的字段。
- prompt context 中读取当前 persona 的变量。

### wardrobe

`src/contexts/wardrobe` 负责当前原 outfit 侧资源：

- outfit 列表、分组、排序。
- 当前穿搭选择。
- 服装图片、on-body 图片、生成状态。
- `Wardrobe` tool。
- photo on-body 生成所需的 target outfit。

### content

`content` 是概念层级，不新增单独 `src/contexts/content`。当前落地目录只建 `src/contexts/persona` 与 `src/contexts/wardrobe`。后续若需要真实 content 聚合 context，必须另行确认。

## 命名迁移

| 当前命名 | 目标命名 |
| --- | --- |
| shell | persona，或按语义拆到 wardrobe |
| daily shell | daily persona + current outfit |
| personality | persona |
| personalities | personas |
| outfit | outfit |
| outfits | wardrobe |
| Shell tool 中的 wardrobe 行为 | Wardrobe tool |
| shell assets 中的 outfit image | wardrobe assets |

命名迁移时按语义判断，不做机械全局替换：

- 表示人格文本时改为 `persona`。
- 表示衣橱容器时改为 `wardrobe`；表示单件服装时保留 `outfit`。
- 表示上层内容域时只作为文档概念，不新增 context 目录。
- 表示命令行 shell 或 Bash sandbox 时保持原名，不参与本重构。

## 已确认的 agent-profile domain 现状

`src/contexts/agent-profile/src/domain/` 当前存在以下 shell / outfit 相关代码：

- `outfit.ts`
  - 已有 `pickOutfit`、`findOutfit`、`filterOutfits`、`resolveOutfitByName`、`shouldAttemptOnBodyGeneration`。
  - 当前依赖 `ShellOption`，应迁到 `src/contexts/wardrobe` 并改为 outfit 类型。

- `shell-types.ts`
  - `ShellCategory = "personalities" | "relationships" | "outfits"`。
  - `DailyShell` 同时包含 `personality`、`relationship`、`outfit`。
  - `DailyShellStore.switchOutfit(...)` 说明 outfit 仍是 shell store 的子行为。

- `shell.ts`
  - 从 `./outfit.js` import outfit 查找/选择逻辑。
  - `createDailyShellStore()` 同时读写 personalities、relationships、outfits。
  - `switchOutfit()`、`category === "outfits"`、`daily.outfit` 都需要迁出。

- `shell-store-files.ts`
  - `shellPaths()` 当前把数据放在 `memory-files/shell/personalities`、`relationships`、`outfits`。
  - `normalizeOutfitImage()` 当前生成 `memory-files/shell/outfits/*.jpg`。
  - daily record 当前持久化 `personalityId`、`relationshipId`、`outfitId`。

- `shell-normalizers.ts`
  - `renderShellTemplate()` 当前渲染 `personality_*`、`relationship_*`、`outfit_*`。
  - `normalizeOption()` 兼容 outfit 图片与 on-body 字段。

- `shell-defaults.ts`
  - 默认 template 仍含 `{{personality_name}}`、`{{outfit_name}}`、`{{outfit_content}}`。
  - 实施时只能迁移变量名，不得修改 prompt 文本语义。

## 迁移步骤

1. 梳理现有 shell 边界
   - 列出 `src/contexts/agent-profile/src/domain/shell*` 中人格与服装字段。
   - 列出 admin shell routes、admin UI shell tab、Shell tool、prompt context daily shell 变量的调用点。
   - 明确哪些调用点属于 persona，哪些属于 wardrobe。

2. 拆分 domain 类型
   - 将人格侧类型迁到 `src/contexts/persona`。
   - 将服装侧类型迁到 `src/contexts/wardrobe`。
   - 删除 shell 类型中对 outfit 的嵌套归属。
   - 不保留旧 shell 类型 re-export 作为兼容层。

3. 调整存储边界
   - persona 数据放到 `src/contexts/persona` 对应 store。
   - wardrobe 数据放到 `src/contexts/wardrobe` 对应 store。
   - 现有 `memory-files/shell/` 资产路径迁移到 wardrobe/persona 明确路径。
   - 数据迁移脚本必须显式、一次性、可重复检测，不能在运行时静默 fallback 旧路径。

4. 调整 tool 边界
   - 现有 Wardrobe 行为从 Shell tool 中独立出来。
   - `Wardrobe` tool 只操作 wardrobe。
   - persona 如需 tool，另行确认；本计划不默认新增 Persona tool。
   - LLM request 中 tool 暴露仍只由 visible tools / `toolNames` 决定。

5. 调整 prompt context
   - 原 `{{personality/...}}` 变量改为 `{{persona/...}}`。
   - `{{outfit/...}}` 保持表示当前服装。
   - `{{targetOutfit/...}}` 保持表示本次 on-body 生成目标服装。
   - Preview 与实际 LLM request 必须使用同一 prompt context runtime。
   - 任何变量改名都不能隐藏追加 prompt 内容。

6. 调整 admin API / UI
   - shell tab 拆成 persona 与 wardrobe 两个管理区域。
   - API 路径从 `/admin/api/shell...` 拆到 persona / wardrobe 对应路径。
   - 图片上传与 on-body 生成 API 归到 wardrobe。
   - 删除将 outfit 保存到 shell option 的请求体字段。

7. 调整 photo on-body
   - `outfit-on-body-runtime` 改为 wardrobe 命名。
   - on-body prompt 目标变量保持为 target outfit。
   - 管理后台手动生成与自动生成都读取同一 target wardrobe 数据。

8. 测试与验证
   - 更新 shell / wardrobe 相关测试命名。
   - 增加 persona 与 wardrobe 拆分后的 store 测试。
   - 增加 admin API 输入校验测试。
   - 增加 prompt context 变量改名测试。
   - 运行：

```bash
npm run typecheck
npm test
```

## 逐文件预期修改清单

### agent-profile domain 迁出

- `src/contexts/agent-profile/src/domain/shell-types.ts`
  - 删除 outfit/wardrobe 字段与 `outfits` category。
  - persona 相关类型迁到 `src/contexts/persona`。
  - outfit 相关类型迁到 `src/contexts/wardrobe`。

- `src/contexts/agent-profile/src/domain/shell-normalizers.ts`
  - 拆分 persona normalizer 与 wardrobe normalizer。
  - 移除 `renderShellTemplate()` 中的 outfit 变量处理。

- `src/contexts/agent-profile/src/domain/shell-store-files.ts`
  - 移除 `outfitsDir` 与 `memory-files/shell/outfits` 资产路径。
  - persona 文件路径迁到 `src/contexts/persona` 对应 store。
  - wardrobe 文件路径迁到 `src/contexts/wardrobe` 对应 store。

- `src/contexts/agent-profile/src/domain/shell.ts`
  - 删除 shell 聚合人格与服装的 domain API。
  - 删除 `switchOutfit()`，调用方改到 wardrobe runtime。

- `src/contexts/agent-profile/src/domain/outfit.ts`
  - 整体迁到 `src/contexts/wardrobe`。
  - `ShellOption` 类型改为 outfit 类型。

- `src/contexts/agent-profile/src/application/shell-admin-runtime.ts`
  - 拆成 persona admin runtime 与 wardrobe admin runtime。

- `src/contexts/agent-profile/prompts/shell-prompt-template.txt`
  - 文件命名迁移前必须确认其内容是否属于 persona；不得修改文本内容本身。

### tools

- `src/capabilities/tools/shell/src/index.ts`
  - 移除 wardrobe 行为；如无其它必要能力，删除 Shell tool。

- `src/capabilities/tools/shell/profile.ts`
  - 删除或迁移到 persona tool；本计划默认不新增 persona tool。

- `src/capabilities/tools/messaging/src/tool-runtime.ts`
  - tool 注册从 shell 拆到 wardrobe。

### persona

- 新增 `src/contexts/persona/src/...`
  - 承接原 personalities、daily persona、persona prompt template 相关 domain/application/ports。
  - 不承接 outfit、image、on-body 字段。

### wardrobe

- 新增 `src/contexts/wardrobe/src/...`
  - 承接原 outfit domain、store、admin runtime、on-body 状态字段。

- 新增或迁移 Wardrobe tool：
  - `src/capabilities/tools/wardrobe/src/index.ts`
  - `src/capabilities/tools/wardrobe/profile.ts`
  - tool 只依赖 `src/contexts/wardrobe`。

### photo

- `src/contexts/capabilities/src/outfit-on-body-runtime.ts`
  - 改名为 wardrobe on-body runtime。
  - 输入输出字段从 outfit 改为 wardrobe。

- `src/capabilities/tools/photo/src/*`
  - 调整 on-body 生成调用字段命名。

### admin

- `src/apps/api/admin-ui/tabs/shells.ts`
  - 拆为 persona 与 wardrobe 管理入口。

- `src/apps/api/admin-ui/tabs/shells-script.ts`
  - 拆为 persona script 与 wardrobe script。

- admin route / service 中 `/admin/api/shell...`
  - 拆到 persona / wardrobe API。

### docs

- `docs/architecture/prompt-context-runtime.md`
  - 将 daily shell 描述改为 persona + wardrobe。

- `docs/reference/tools/llm-tools.md`
  - 更新 Shell / Wardrobe tool 描述。

- `docs/change_log/*`
  - 实施完成后新增中文变更记录。

## 风险点

- prompt 变量改名会影响现有 prompt 配置，实施前需要确认迁移方式。
- API 路径改名会影响管理后台与本地调用脚本。
- 资产路径迁移不能静默 fallback，否则旧路径会长期残留。
- `shell` 一词在项目中也表示 Bash / command shell，搜索替换必须人工筛选。

## 实施顺序建议

1. 先拆 domain/store 类型，不动 prompt 内容。
2. 再拆 Wardrobe tool 与 admin wardrobe API。
3. 再迁移 persona 管理与 prompt context 变量。
4. 最后删除 shell 聚合入口、旧路径和旧命名测试。

每一步都应保持 typecheck 可通过；涉及 API 行为变更的步骤必须带测试。
