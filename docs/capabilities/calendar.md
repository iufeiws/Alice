# Calendar 能力

Calendar 能力位于 `src/capabilities/tools/calendar` 和 `src/platform/storage/src/calendar-store.ts`。

## 工具

LLM 通过 `calendar` 工具管理日历条目和日程：

- add
- remove
- search
- list

工具输出使用 `<calendar>` 块，按配置时区渲染可见日期。

## 存储

日历数据写入 `memory-files/alice.sqlite` 中的 calendar 相关表。条目支持公历、农历、节日、生日和具体日程。

## Reminder

`calendar-event-runtime` 扫描到期提醒，生成 `calendar.schedule_due` 主动行为事件。首次扫描不会回填很久以前的提醒；已触发提醒不会在重启后重复发出。

## Prompt Context

Calendar context 只渲染有可见条目的日期。它是 prompt context 的一部分，不由工具调用临时拼接隐藏说明。
