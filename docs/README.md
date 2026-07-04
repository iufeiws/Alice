# Alice 文档目录

本目录只放当前项目文档和历史归档。

## 当前入口

- `core/`：Core 运行时、Agent 状态、loop 和主动行为。
- `channels/`：飞书、ASR、WebRTC voice、Google Street View 等 channel 现状。
- `capabilities/`：LLM 工具、skills、bash sandbox、calendar 等能力现状。
- `app/`：后台管理和浏览器页面设计。
- `reference/`：工具、协议和实现细节参考。
- `architecture/`：跨模块架构说明。
- `implement/`：仍有当前价值的实现说明。
- `plan/`：尚未完成的计划或收尾清单。

## 归档

`archive/` 只保存历史设计、已完成计划、事故记录和被新版本取代的实现说明。归档文档不是当前行为规范；判断当前行为应优先查看当前入口和源码。

## 清理规则

- 明显废弃且被当前文档替代的短文档直接删除。
- 有历史排障或设计价值、但不能作为当前规范的文档移入 `archive/`。
- 当前文档必须使用中文，并尽量指向当前 `src/` 和 `tests/` 路径。

