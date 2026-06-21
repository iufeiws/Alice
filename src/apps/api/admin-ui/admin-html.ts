import { deepSeekPricesCnyPer1M } from "../../../contexts/llm-gateway/src/token-pricing.js";

export function renderAdminHtmlV2(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Alice Admin</title>
    <style>
      :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { height: 100%; }
      body { margin: 0; background: #f5f6f8; color: #17202a; overflow: hidden; }
      .shell { display: grid; grid-template-columns: 360px 1fr; grid-template-rows: minmax(0, 1fr) auto; grid-template-areas: "aside main" "terminal terminal"; height: 100vh; overflow: hidden; }
      .shell.collapsed { grid-template-columns: 48px 1fr; }
      aside { grid-area: aside; border-right: 1px solid #d7dce3; background: #fff; min-width: 0; min-height: 0; overflow: auto; }
      .collapsed aside .panel-body, .collapsed aside .tabbar, .collapsed aside h1 { display: none; }
      .side-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #e2e6eb; }
      h1 { font-size: 18px; margin: 0; }
      main { grid-area: main; min-width: 0; min-height: 0; padding: 18px 22px; overflow: auto; }
      .tabbar { display: flex; gap: 8px; padding: 12px 16px 0; }
      .main-tabs { padding: 0 0 14px; }
      .tab { border: 1px solid #c8d0da; background: #fff; color: #17202a; border-radius: 6px; padding: 8px 10px; font-weight: 700; cursor: pointer; }
      .tab.active { background: #2563eb; color: #fff; border-color: #2563eb; }
      .subtabs { display: flex; gap: 8px; margin: 0 0 14px; }
      .panel-body { padding: 14px 16px 20px; }
      .pane { display: none; }
      .pane.active { display: block; }
      .qr-box { width: 220px; min-height: 220px; border: 1px solid #d7dce3; border-radius: 8px; display: grid; place-items: center; background: #f8fafc; margin-top: 10px; overflow: hidden; }
      .qr-box img { max-width: 100%; max-height: 100%; object-fit: contain; }
      section { background: #fff; border: 1px solid #d7dce3; border-radius: 8px; padding: 16px; max-width: 100%; }
      h2 { font-size: 15px; margin: 0 0 14px; }
      label { display: block; font-size: 12px; font-weight: 700; margin: 12px 0 6px; }
      input, textarea, select { box-sizing: border-box; width: 100%; border: 1px solid #c4cad2; border-radius: 6px; padding: 9px 10px; font: inherit; background: #fff; color: #17202a; }
      textarea { resize: vertical; }
      audio { width: 100%; margin-top: 10px; }
      button { border: 0; border-radius: 6px; background: #2563eb; color: #fff; padding: 9px 12px; font-weight: 700; cursor: pointer; margin: 10px 8px 0 0; }
      button.secondary { background: #475467; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f1f3f5; border-radius: 6px; padding: 12px; font-size: 12px; }
      .muted { color: #667085; font-size: 12px; }
      .list { display: grid; gap: 10px; }
      .item { border-bottom: 1px solid #e4e7eb; padding: 10px 0; }
      .item strong { display: block; font-size: 13px; }
      .row { display: grid; grid-template-columns: 1fr 120px 90px; gap: 8px; align-items: end; }
      .prompt-layer { border-bottom: 1px solid #e4e7eb; padding: 12px 0; }
      .prompt-layer summary { cursor: pointer; font-weight: 800; padding: 6px 0; }
      .prompt-layer summary span { color: #667085; font-weight: 700; margin-left: 8px; }
      .prompt-layer[open] summary { margin-bottom: 8px; }
      .prompt-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .prompt-actions button { margin-top: 6px; }
      .prompt-editor-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr); grid-template-areas: "mode preview" "api preview" "editor preview"; gap: 16px; align-items: start; }
      .prompt-mode-cell { grid-area: mode; }
      .prompt-api-cell { grid-area: api; }
      .prompt-edit-cell { grid-area: editor; min-width: 0; }
      .prompt-preview-pane { grid-area: preview; position: sticky; top: 12px; min-width: 0; }
      .prompt-preview-pane .logs { max-height: calc(100vh - 210px); }
      .prompt-preview-pane > pre { max-height: calc(100vh - 210px); overflow: auto; }
      .prompt-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
      .prompt-preview-head h2 { margin: 0; }
      .prompt-preview-head button { margin: 0; white-space: nowrap; }
      .shell-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
      .shell-category-outfits { grid-column: 1 / -1; }
      .shell-option { border-bottom: 1px solid #e4e7eb; padding: 10px 0; }
      .shell-option summary { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 800; padding: 6px 0; }
      .shell-option summary .shell-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .shell-option summary .shell-save { margin-left: auto; }
      .shell-marker { color: #667085; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .shell-option summary button { margin: 0; padding: 5px 8px; }
      .shell-option textarea { min-height: 110px; }
      .shell-image-preview { margin-top: 10px; max-width: 220px; max-height: 160px; border: 1px solid #d7dce3; border-radius: 6px; object-fit: contain; background: #f8fafc; display: block; }
      .shell-image-preview.hidden { display: none; }
      .shell-image-drop { border: 1px dashed #98a2b3; border-radius: 6px; padding: 10px; background: #f8fafc; transition: border-color 120ms ease, background 120ms ease; }
      .shell-image-drop.dragging { border-color: #2563eb; background: #eff6ff; }
      .shell-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .shell-group { border-bottom: 1px solid #e4e7eb; padding: 8px 0; }
      .shell-group summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; }
      .shell-group summary strong { min-width: 0; overflow-wrap: anywhere; }
      .shell-group-actions { display: flex; align-items: center; gap: 8px; }
      .shell-group-add { width: 28px; height: 28px; display: inline-grid; place-items: center; margin: 0; padding: 0; font-size: 17px; line-height: 1; }
      .logs { max-height: calc(100vh - 150px); overflow: auto; background: #111827; color: #e5e7eb; border-radius: 6px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .logs pre { color: #17202a; }
      .admin-terminal { grid-area: terminal; min-height: 0; padding: 0; background: #0b1220; color: #e5e7eb; border: 0; border-top: 1px solid #263244; border-radius: 0; box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.04); }
      .admin-terminal-head { height: 38px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: #111827; border-bottom: 1px solid #263244; overflow-x: auto; cursor: pointer; }
      .admin-terminal-title { flex: 0 0 auto; margin-right: 8px; font-size: 12px; letter-spacing: 0; text-transform: uppercase; color: #cbd5e1; }
      .terminal-tab { margin: 0; padding: 5px 9px; border-radius: 4px; background: transparent; color: #cbd5e1; border: 1px solid transparent; font-size: 12px; }
      .terminal-tab.active { background: #1f2937; color: #fff; border-color: #374151; }
      .terminal-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
      .terminal-action { margin: 0; width: 28px; height: 28px; padding: 0; border-radius: 4px; display: inline-grid; place-items: center; background: #1f2937; color: #e5e7eb; }
      .admin-terminal-body { height: clamp(220px, 32vh, 45vh); min-height: 0; }
      .terminal-pane { display: none; height: 100%; min-height: 0; }
      .terminal-pane.active { display: block; }
      .terminal-pane .logs { height: 100%; max-height: none; box-sizing: border-box; border-radius: 0; background: #0b1220; }
      .admin-terminal.collapsed .admin-terminal-body { display: none; }
      .admin-terminal.collapsed .terminal-tab:not(.active) { display: none; }
      .llm-split { display: grid; grid-template-rows: minmax(280px, 1fr) minmax(280px, 1fr); gap: 12px; height: calc(100vh - 145px); }
      .llm-window { min-height: 0; display: grid; grid-template-rows: auto 1fr; gap: 8px; }
      .llm-window h2 { margin: 0; }
      .llm-window .logs { max-height: none; min-height: 0; }
      .usage-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; margin-bottom: 14px; }
      .usage-controls label { margin: 0; min-width: 120px; }
      .usage-grid { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 10px; margin-bottom: 14px; }
      .usage-metric { border: 1px solid #d7dce3; border-radius: 8px; padding: 10px; background: #f8fafc; }
      .usage-metric strong { display: block; font-size: 18px; margin-top: 4px; }
      .usage-chart { display: grid; gap: 18px; }
      .usage-model-panel { border-bottom: 1px solid #d7dce3; padding: 4px 0 18px; }
      .usage-model-panel:last-child { border-bottom: 0; }
      .usage-model-head { display: flex; align-items: baseline; gap: 18px; margin-bottom: 8px; }
      .usage-model-head h2 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; }
      .usage-model-stat { color: #667085; font-size: 13px; font-weight: 700; }
      .usage-model-charts { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(320px, 1fr); gap: 28px; align-items: start; overflow-x: auto; }
      .usage-mini-title { font-size: 13px; font-weight: 800; color: #17202a; margin: 0 0 6px; }
      .usage-line-chart { min-width: 280px; height: 160px; position: relative; border-bottom: 1px solid #d4dce8; background: repeating-linear-gradient(to bottom, transparent 0, transparent 52px, #e7ebf2 53px); }
      .usage-line-chart svg { width: 100%; height: 140px; display: block; overflow: visible; }
      .usage-axis-row { display: flex; justify-content: space-between; color: #667085; font-size: 11px; margin-top: 4px; }
      .usage-token-bars { min-width: 320px; height: 160px; display: flex; align-items: end; gap: 8px; border-bottom: 1px solid #d4dce8; padding-bottom: 1px; background: repeating-linear-gradient(to bottom, transparent 0, transparent 52px, #e7ebf2 53px); }
      .usage-bar-wrap { flex: 0 0 18px; height: 140px; display: flex; align-items: end; position: relative; }
      .usage-bar { width: 100%; display: flex; flex-direction: column-reverse; min-height: 2px; border-radius: 4px 4px 0 0; overflow: hidden; background: #e5e7eb; }
      .usage-hit { background: rgba(159, 219, 255, 0.82); }
      .usage-miss { background: rgba(89, 169, 255, 0.72); }
      .usage-output { background: rgba(22, 119, 255, 0.90); }
      .usage-legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0 0; color: #667085; font-size: 12px; }
      .usage-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
      .usage-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; }
      .usage-table th, .usage-table td { border-bottom: 1px solid #e4e7eb; padding: 7px 6px; text-align: left; }
      .usage-table th { color: #667085; font-weight: 800; }
      .plugin-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
      .plugin-toolbar label { margin: 0; min-width: 260px; }
      .plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; align-items: stretch; }
      .plugin-card { border: 1px solid #d7dce3; border-radius: 8px; padding: 14px; background: #fff; display: grid; grid-template-rows: auto 1fr auto; gap: 12px; min-height: 180px; }
      .plugin-card-head { display: grid; grid-template-columns: 40px 1fr; gap: 10px; align-items: start; min-width: 0; }
      .plugin-icon { width: 40px; height: 40px; border-radius: 8px; display: grid; place-items: center; background: #17202a; color: #fff; font-weight: 900; }
      .plugin-title { font-weight: 900; overflow-wrap: anywhere; }
      .plugin-desc { color: #667085; font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
      .plugin-meta { display: grid; gap: 4px; color: #667085; font-size: 12px; }
      .plugin-state { font-weight: 800; color: #17202a; }
      .plugin-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .plugin-actions button { margin-top: 0; }
      .plugin-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 800; color: #17202a; white-space: nowrap; cursor: pointer; }
      .plugin-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
      .plugin-switch-visual { position: relative; display: inline-block; width: 46px; height: 24px; flex: 0 0 46px; border: 1px solid #98a2b3; border-radius: 999px; background: #eef1f5; transition: background 140ms ease, border-color 140ms ease; }
      .plugin-switch-visual::after { content: ""; position: absolute; top: 2px; left: 3px; width: 18px; height: 18px; border-radius: 999px; background: #667085; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.24); transition: left 140ms ease, background 140ms ease; }
      .plugin-switch input:checked + .plugin-switch-visual { border-color: #2563eb; background: #e8f1ff; }
      .plugin-switch input:checked + .plugin-switch-visual::after { left: 23px; background: #2563eb; }
      .plugin-switch input:focus-visible + .plugin-switch-visual { outline: 2px solid #93c5fd; outline-offset: 2px; }
      .plugin-switch input:disabled + .plugin-switch-visual { opacity: 0.48; cursor: not-allowed; }
      .plugin-config { margin-top: 14px; }
      .plugin-config.pane.active { display: block; }
      .plugin-config-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .plugin-config-head button { margin-top: 0; }
      .plugin-config-grid { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr); gap: 14px; align-items: start; }
      .plugin-config-sections { display: grid; gap: 16px; }
      .plugin-config-section { border-top: 1px solid #e4e7eb; padding-top: 12px; }
      .world-wanderer-map { width: 100%; height: 360px; border: 1px solid #d7dce3; border-radius: 8px; background: #eef1f5; }
      .world-wanderer-path-meta { margin: 8px 0 0; color: #667085; font-size: 12px; }
      .plugin-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .plugin-section-head h2 { margin: 0; }
      .plugin-preset-row { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 10px; align-items: end; }
      .plugin-preset-editor { display: none; margin-top: 12px; }
      .plugin-preset-editor.active { display: grid; gap: 10px; }
      .plugin-public-grid { display: grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); gap: 12px; }
      .plugin-events { max-height: 280px; }
      #main-initiated-behaviors { max-width: 100%; overflow: hidden; }
      .behavior-layout { width: 100%; max-width: 100%; min-width: 0; display: grid; gap: 16px; align-items: start; }
      .behavior-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
      .behavior-toolbar h2 { margin: 0 0 4px; }
      .behavior-toolbar label { margin: 0; min-width: 220px; }
      .behavior-table-wrap { width: 100%; max-width: 100%; min-width: 0; overflow: hidden; border: 1px solid #d7dce3; border-radius: 8px; }
      .behavior-table { --column-indent: clamp(6px, 0.9vw, 14px); width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
      .behavior-table th, .behavior-table td { border-bottom: 1px solid #e4e7eb; padding: 8px var(--column-indent); text-align: left; vertical-align: middle; overflow-wrap: anywhere; word-break: break-word; }
      .behavior-table th { color: #667085; font-weight: 800; background: #f8fafc; }
      .behavior-table tr:last-child td { border-bottom: 0; }
      .behavior-table button { margin: 0; padding: 6px 9px; max-width: 100%; white-space: normal; }
      .behavior-row:hover td { background: #f8fafc; }
      .behavior-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 800; }
      .behavior-kind { display: inline-flex; max-width: 100%; align-items: center; border-radius: 999px; padding: 2px 7px; font-weight: 800; background: #eef1f5; color: #475467; overflow-wrap: anywhere; }
      .behavior-kind.event { background: #ecfdf3; color: #067647; }
      .behavior-kind.randomized { background: #fff4e5; color: #b54708; }
      .behavior-status { display: inline-flex; max-width: 100%; align-items: center; border-radius: 999px; padding: 2px 7px; font-weight: 800; background: #eef1f5; color: #475467; overflow-wrap: anywhere; }
      .behavior-status.on { background: #e8f1ff; color: #1d4ed8; }
      .behavior-recent { margin-top: 16px; }
      .behavior-recent-scroll { width: 100%; max-width: 100%; min-width: 0; max-height: 150px; overflow: auto; border: 1px solid #d7dce3; border-radius: 8px; }
      .behavior-recent-table { --column-indent: clamp(6px, 0.8vw, 12px); width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
      .behavior-recent-table th, .behavior-recent-table td { border-bottom: 1px solid #e4e7eb; padding: 7px var(--column-indent); text-align: left; overflow-wrap: anywhere; word-break: break-word; }
      .behavior-recent-table th { color: #667085; font-weight: 800; background: #f8fafc; position: sticky; top: 0; }
      .behavior-chart { width: 100%; max-width: 100%; min-width: 0; margin-top: 16px; }
      .behavior-chart-bars { width: 100%; min-width: 0; height: 160px; display: flex; align-items: end; gap: 5px; border-bottom: 1px solid #d4dce8; padding-bottom: 1px; background: repeating-linear-gradient(to bottom, transparent 0, transparent 52px, #e7ebf2 53px); overflow-x: auto; }
      .behavior-chart-bar-wrap { flex: 0 0 10px; height: 140px; display: flex; align-items: end; }
      .behavior-chart-bar { width: 100%; display: flex; flex-direction: column-reverse; min-height: 2px; border-radius: 2px 2px 0 0; overflow: hidden; background: #e5e7eb; }
      .behavior-chart-responded { background: rgba(29, 78, 216, 0.92); }
      .behavior-chart-missed { background: rgba(147, 197, 253, 0.75); }
      .behavior-config { margin-top: 0; }
      .behavior-config.pane.active { display: block; }
      .behavior-config-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .behavior-config-title h2 { margin: 0 0 4px; overflow-wrap: anywhere; }
      .behavior-config-actions button { margin-top: 0; }
      .behavior-config-grid { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(260px, 1fr); gap: 14px; align-items: start; margin-bottom: 14px; }
      .behavior-config-box { border: 1px solid #d7dce3; border-radius: 8px; padding: 12px; background: #fff; }
      .behavior-config-box h2 { margin-bottom: 8px; }
      .behavior-config-row { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; }
      .behavior-config-row input[type="checkbox"] { width: auto; margin: 8px 0 0; }
      .behavior-steps { margin-top: 14px; }
      .behavior-step-list { display: grid; gap: 8px; }
      .behavior-step-item { border: 1px solid #d7dce3; border-radius: 8px; padding: 10px; background: #f8fafc; font-size: 12px; }
      .behavior-step-item strong { display: block; margin-bottom: 4px; }
      .behavior-layer-grid { display: grid; grid-template-columns: minmax(260px, 0.75fr) minmax(320px, 1.25fr); gap: 14px; align-items: start; margin-top: 14px; }
      .behavior-layer-list { display: grid; gap: 8px; }
      .behavior-layer-item { width: 100%; border: 1px solid #d7dce3; border-radius: 8px; padding: 9px; background: #fff; color: #17202a; font-size: 12px; text-align: left; margin: 0; cursor: pointer; }
      .behavior-layer-item.active { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb inset; }
      .behavior-layer-item.disabled { color: #98a2b3; background: #f8fafc; }
      .behavior-layer-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 4px; color: #667085; }
      .behavior-layer-editor textarea { min-height: 160px; }
      .behavior-layer-preview .logs { max-height: 380px; overflow: auto; }
      .memory-controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; margin-bottom: 12px; }
      .memory-controls label { margin: 0; min-width: 180px; }
      .memory-day-layout { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 14px; align-items: start; margin-bottom: 16px; }
      .memory-calendar { margin: 0; }
      .memory-calendar-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
      .memory-calendar-head strong { font-size: 13px; }
      .memory-calendar-head button { width: 26px; height: 26px; padding: 0; margin: 0; }
      .memory-calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
      .memory-calendar-weekday { color: #667085; font-size: 10px; font-weight: 800; text-align: center; padding: 3px 0; }
      .memory-calendar-day { height: 26px; margin: 0; padding: 0; border-radius: 5px; font-size: 11px; }
      .memory-calendar-day.available { background: #17202a; color: #fff; border-color: #17202a; }
      .memory-calendar-day.selected { outline: 2px solid #2563eb; outline-offset: 1px; }
      .memory-calendar-day.empty { visibility: hidden; }
      .memory-calendar-day:disabled { color: #98a2b3; background: #eef1f5; border-color: #d7dce3; cursor: not-allowed; }
      .memory-chat-panel h2 { margin-bottom: 8px; }
      .memory-chat-preview { margin: 0; max-height: 360px; min-height: 238px; }
      .tool-preview-grid { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 14px; align-items: start; }
      .tool-preview-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .log-line { border-bottom: 1px solid #243041; padding: 5px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .log-info { color: #d1d5db; } .log-warn { color: #fbbf24; } .log-error { color: #fca5a5; }
      @media (max-width: 1200px) { .usage-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
      @media (max-width: 900px) {
        html, body { height: auto; min-height: 100%; }
        body { overflow: auto; }
        .shell { min-height: 100vh; height: auto; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto; grid-template-areas: "aside" "main" "terminal"; overflow: visible; }
        .shell.collapsed { grid-template-columns: minmax(0, 1fr); }
        aside { max-height: none; border-right: 0; border-bottom: 1px solid #d7dce3; overflow: visible; }
        .collapsed aside .panel-body, .collapsed aside .tabbar, .collapsed aside h1 { display: none; }
        main { padding: 14px 12px; overflow: visible; }
        section { padding: 12px; }
        .tabbar, .subtabs { max-width: 100%; overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; }
        .tabbar { padding-left: 12px; padding-right: 12px; }
        .main-tabs { padding: 0 0 12px; }
        .tab { flex: 0 0 auto; white-space: nowrap; }
        .row, .tool-preview-grid, .usage-model-charts, .prompt-editor-grid, .shell-grid, .memory-day-layout, .plugin-config-grid, .plugin-public-grid, .plugin-preset-row, .behavior-layout, .behavior-config-grid, .behavior-config-row, .behavior-layer-grid { grid-template-columns: minmax(0, 1fr); }
        .prompt-editor-grid { grid-template-areas: "mode" "api" "editor" "preview"; }
        .prompt-preview-pane { position: static; }
        .prompt-preview-pane .logs, .prompt-preview-pane > pre, .logs { max-height: 55vh; }
        .prompt-preview-head, .plugin-toolbar, .plugin-config-head, .plugin-section-head, .behavior-toolbar, .behavior-config-head, .shell-head, .shell-option summary, .shell-group summary { align-items: stretch; flex-wrap: wrap; }
        .plugin-toolbar label, .behavior-toolbar label, .usage-controls label, .memory-controls label { min-width: min(100%, 180px); flex: 1 1 180px; }
        .plugin-grid { grid-template-columns: minmax(0, 1fr); }
        .plugin-actions { align-items: flex-start; flex-wrap: wrap; }
        .behavior-table-wrap { overflow-x: auto; }
        .behavior-table { min-width: 760px; table-layout: auto; }
        .behavior-recent-scroll { overflow: auto; }
        .behavior-recent-table { min-width: 620px; table-layout: auto; }
        .usage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .usage-model-head { flex-wrap: wrap; gap: 6px 12px; }
        .usage-model-charts { overflow-x: visible; }
        .llm-split { height: auto; grid-template-rows: auto; }
        .llm-window .logs { max-height: 55vh; }
        .admin-terminal { position: static; }
        .admin-terminal-body { height: 40vh; }
      }
      @media (max-width: 560px) {
        button { width: 100%; margin-right: 0; }
        .side-head button, .tab, .terminal-tab, .terminal-action, .memory-calendar-head button, .shell-group-add, .plugin-switch input, .behavior-table button, .prompt-preview-head button, .plugin-config-head button, .behavior-config-head button, .shell-option summary button, .shell-group summary button { width: auto; }
        .panel-body { padding: 12px; }
        .qr-box { width: 100%; min-height: 180px; }
        .usage-grid { grid-template-columns: minmax(0, 1fr); }
        .usage-controls, .memory-controls, .prompt-actions, .tool-preview-actions, .behavior-config-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
        .prompt-actions button, .tool-preview-actions button, .behavior-config-actions button { margin: 0; width: 100%; }
        .plugin-card { min-height: 0; }
        .plugin-card-head { grid-template-columns: 34px minmax(0, 1fr); }
        .plugin-icon { width: 34px; height: 34px; }
        .plugin-switch { width: auto; }
        .shell-image-preview { max-width: 100%; }
        .terminal-actions { margin-left: 0; }
      }
    </style>
  </head>
  <body>
    <div id="shell" class="shell">
      <aside>
        <div class="side-head">
          <h1>Alice Admin</h1>
          <button id="collapse" class="secondary" type="button">≡</button>
        </div>
        <div class="tabbar">
          <button class="tab active" data-left-tab="llm" type="button">LLM Settings</button>
          <button class="tab" data-left-tab="feishu" type="button">Channel Settings</button>
          <button class="tab" data-left-tab="core" type="button">Alice Core</button>
          <button class="tab" data-left-tab="agent" type="button">Agent Settings</button>
        </div>
        <div class="panel-body">
          <div id="left-llm" class="pane active">
            <h2>LLM API</h2>
            <form id="llm-form">
              <label for="llmPresetSelect">API Preset</label>
              <select id="llmPresetSelect"></select>
              <label for="llmPresetName">Preset Name <span class="shell-marker" id="llmPresetMarker"></span></label>
              <input id="llmPresetName" autocomplete="off" placeholder="preset name" />
              <div class="prompt-actions">
                <button type="button" id="llm-preset-save">Save Preset</button>
                <button type="button" id="llm-preset-rename">Rename</button>
                <button type="button" id="llm-preset-delete" class="secondary">Delete</button>
              </div>
              <label for="baseURL">Base URL</label>
              <input id="baseURL" name="baseURL" autocomplete="off" />
              <label for="model">Model</label>
              <input id="model" name="model" autocomplete="off" />
              <label for="apiKey">API Key</label>
              <input id="apiKey" name="apiKey" type="password" placeholder="Leave blank to keep unchanged" autocomplete="new-password" />
              <label for="temperature">Temperature</label>
              <input id="temperature" name="temperature" inputmode="decimal" />
              <label for="timeoutMs">Timeout Ms</label>
              <input id="timeoutMs" name="timeoutMs" inputmode="numeric" />
              <label><input id="streamEnabled" name="stream" type="checkbox" /> Streaming</label>
              <label><input id="supportsImage" name="supportsImage" type="checkbox" /> Supports Images</label>
              <label><input id="supportsAudio" name="supportsAudio" type="checkbox" /> Supports Audio</label>
              <label for="extraParams">Extra Params JSON</label>
              <textarea id="extraParams" name="extraParams" rows="6" spellcheck="false">{}</textarea>
              <label for="followupExtraParams">Follow-up Extra Params JSON</label>
              <textarea id="followupExtraParams" name="followupExtraParams" rows="6" spellcheck="false">{}</textarea>
              <p class="muted">First-call params apply to the first LLM request in a session; follow-up params apply to later tool-result requests. Object-body fragments are also accepted. For streaming token usage, include "stream_options":{"include_usage":true}.</p>
              <p class="muted" id="save-status"></p>
            </form>
            <h2>Runtime</h2>
            <pre id="config">Loading...</pre>
          </div>
          <div id="left-feishu" class="pane">
            <div class="subtabs">
              <button class="tab active" data-channel-tab="feishu" type="button">Feishu</button>
              <button class="tab" data-channel-tab="wechat" type="button">WeChat</button>
            </div>
            <div id="channel-feishu" class="pane active">
              <h2>Feishu</h2>
              <form id="feishu-form">
                <label><input id="feishuEnabled" name="enabled" type="checkbox" /> Enabled</label>
                <label for="feishuConnectionMode">Connection Mode</label>
                <input id="feishuConnectionMode" name="connectionMode" autocomplete="off" />
                <label for="feishuAppId">App ID</label>
                <input id="feishuAppId" name="appId" autocomplete="off" />
                <label for="feishuAppSecret">App Secret</label>
                <input id="feishuAppSecret" name="appSecret" type="password" placeholder="Leave blank to keep unchanged" autocomplete="new-password" />
                <label><input id="feishuRequireMention" name="requireMention" type="checkbox" /> Require mention in groups</label>
                <button type="submit">Save</button>
                <button type="button" id="feishu-start">Start</button>
                <button type="button" id="feishu-stop" class="secondary">Stop</button>
                <p class="muted" id="feishu-status"></p>
              </form>
              <h2>Send Test</h2>
            <label for="testMarkdown">Markdown</label>
            <textarea id="testMarkdown" rows="5"></textarea>
              <button type="button" id="send-test-markdown">Send Markdown</button>
              <label for="testImagePath">Image Local Path</label>
              <input id="testImagePath" autocomplete="off" />
              <button type="button" id="send-test-image">Send Image</button>
              <label for="testAudioPath">Audio Local Path</label>
              <input id="testAudioPath" autocomplete="off" />
              <button type="button" id="send-test-audio">Send Audio</button>
              <p class="muted" id="send-test-status"></p>
            </div>
            <div id="channel-wechat" class="pane">
              <h2>WeChat</h2>
              <form id="wechat-form">
                <label><input id="wechatEnabled" name="enabled" type="checkbox" /> Enabled</label>
                <label for="wechatBaseURL">iLink Base URL</label>
                <input id="wechatBaseURL" name="baseURL" autocomplete="off" />
                <label for="wechatPollTimeoutMs">Poll Timeout Ms</label>
                <input id="wechatPollTimeoutMs" name="pollTimeoutMs" inputmode="numeric" />
                <button type="submit">Save</button>
                <button type="button" id="wechat-login">Get Login QR</button>
                <button type="button" id="wechat-start">Start</button>
                <button type="button" id="wechat-stop" class="secondary">Stop</button>
                <p class="muted" id="wechat-status"></p>
              </form>
              <div id="wechat-qr" class="qr-box"><span class="muted">No QR code</span></div>
              <p class="muted" id="wechat-login-status"></p>
              <pre id="wechat-contacts">[]</pre>
            </div>
            <h2>Messaging Tools</h2>
            <button type="button" id="tool-view">View Messages</button>
            <label for="toolSearchContent">Search Content</label>
            <input id="toolSearchContent" autocomplete="off" />
            <label for="toolSearchDirection">Search Direction</label>
            <input id="toolSearchDirection" autocomplete="off" value="backward" />
            <button type="button" id="tool-search">Search Messages</button>
            <label for="toolSendType">Send Type</label>
            <input id="toolSendType" autocomplete="off" value="message" />
            <label for="toolSendContent">Send Content</label>
            <textarea id="toolSendContent" rows="4"></textarea>
            <button type="button" id="tool-send">Send Message</button>
            <pre id="tool-result">No tool run yet.</pre>
            <h2>Unique Bound Contact</h2>
            <pre id="pairings">Loading...</pre>
          </div>
          <div id="left-core" class="pane">
            <h2>Alice Core</h2>
            <form id="core-profile-form">
              <label for="appearanceDescription">Appearance Description</label>
              <textarea id="appearanceDescription" name="appearanceDescription" rows="12" spellcheck="false"></textarea>
              <label for="librarySetting">Library Setting</label>
              <textarea id="librarySetting" name="librarySetting" rows="8" spellcheck="false"></textarea>
              <button type="submit">Save Core Profile</button>
              <p class="muted" id="core-profile-status"></p>
            </form>
            <h2>Voice Sample</h2>
            <p class="muted" id="tts-reference-status">Loading...</p>
            <label for="ttsReferenceAudio">Reference Audio</label>
            <input id="ttsReferenceAudio" type="file" accept="audio/wav,audio/mpeg,audio/mp4,.wav,.mp3,.m4a" />
            <label for="ttsReferenceText">Reference Text</label>
            <textarea id="ttsReferenceText" rows="3" placeholder="输入参考音频对应的原文"></textarea>
            <button type="button" id="tts-upload-reference">Upload Voice Sample</button>
            <label for="ttsPreviewText">Preview Text</label>
            <textarea id="ttsPreviewText" rows="3"></textarea>
            <button type="button" id="tts-generate-preview">Generate Preview</button>
            <audio id="ttsPreviewAudio" controls></audio>
            <p class="muted" id="tts-preview-status"></p>
            <h2>Variables</h2>
            <pre id="coreProfilePreview">Loading...</pre>
          </div>
          <div id="left-agent" class="pane">
            <h2>Agent</h2>
            <form id="agent-form">
              <label for="inboundDebounceMs">Message Wait Ms</label>
              <input id="inboundDebounceMs" name="inboundDebounceMs" inputmode="numeric" />
              <label for="timezone">Timezone</label>
              <input id="timezone" name="timezone" autocomplete="off" />
              <label for="defaultTargetPlugin">Default Target Plugin</label>
              <select id="defaultTargetPlugin" name="defaultTargetPlugin">
                <option value="auto">auto</option>
                <option value="wechat">wechat</option>
                <option value="feishu">feishu</option>
              </select>
              <button type="submit">Save</button>
              <p class="muted" id="agent-status"></p>
            </form>
            <h2>State</h2>
            <form id="agent-state-form">
              <label for="agentStateSelect">State</label>
              <select id="agentStateSelect" name="state"></select>
              <label for="agentIntimacy">Intimacy</label>
              <input id="agentIntimacy" name="intimacy" inputmode="numeric" />
              <button type="submit">Save State</button>
              <pre id="agentStateSnapshot">Loading...</pre>
            </form>
            <h2>Runtime</h2>
            <button type="button" id="heartbeat-pause" class="secondary">Pause Heartbeat</button>
            <button type="button" id="heartbeat-resume">Start Heartbeat</button>
            <button type="button" id="process-now">Process Now</button>
            <pre id="runtimeStatus">Loading...</pre>
          </div>
        </div>
      </aside>
      <main>
        <div class="tabbar main-tabs">
          <button class="tab active" data-main-tab="prompts" type="button">Prompt</button>
          <button class="tab" data-main-tab="shells" type="button">Shell</button>
          <button class="tab" data-main-tab="llm-chain" type="button">LLM Sessions</button>
          <button class="tab" data-main-tab="token-usage" type="button">Token Usage</button>
          <button class="tab" data-main-tab="memory" type="button">Memory</button>
          <button class="tab" data-main-tab="plugins" type="button">Plugin</button>
          <button class="tab" data-main-tab="initiated-behaviors" type="button">Initiated Behaviors</button>
          <button class="tab" data-main-tab="tool-preview" type="button">Tool Preview</button>
        </div>
        <section id="main-prompts" class="pane active">
          <div id="promptProfile">Loading...</div>
          <p class="muted" id="prompt-status"></p>
        </section>
        <section id="main-shells" class="pane">
          <div id="shellEditor">Loading...</div>
          <p class="muted" id="shell-status"></p>
        </section>
        <section id="main-llm-request" class="pane"><div id="llmRequests" class="logs">No LLM request yet.</div></section>
        <section id="main-llm-chain" class="pane">
          <button type="button" id="llm-run-cancel" class="secondary">Cancel Current Run</button>
          <button type="button" id="llm-chain-clear" class="secondary">Clear Active Session</button>
          <div class="llm-window">
            <h2>Sessions</h2>
            <div id="llmChainSessions" class="logs">No LLM session yet.</div>
          </div>
        </section>
        <section id="main-token-usage" class="pane">
          <div class="usage-controls">
            <label for="tokenUsageRange">Range
              <select id="tokenUsageRange">
                <option value="24h">24h</option>
                <option value="7d">7d</option>
                <option value="30d">30d</option>
              </select>
            </label>
            <label for="tokenUsageBucket">Bucket
              <select id="tokenUsageBucket">
                <option value="hour">Hour</option>
                <option value="day">Day</option>
              </select>
            </label>
            <label for="tokenUsageModel">Model
              <select id="tokenUsageModel"><option value="all">all</option></select>
            </label>
            <label for="tokenUsageAgent">Agent
              <select id="tokenUsageAgent"><option value="all">all</option><option value="chat">chat</option><option value="talk">talk</option><option value="memorize">memorize</option><option value="tts">tts</option></select>
            </label>
            <button type="button" id="tokenUsageRefresh">Refresh</button>
          </div>
          <div id="tokenUsageMetrics" class="usage-grid"></div>
          <div id="tokenUsageChart" class="usage-chart">Loading...</div>
          <div id="tokenUsageModels"></div>
          <div id="tokenUsageLatest"></div>
        </section>
        <section id="main-memory" class="pane">
          <div>
            <h2>Memory</h2>
          <div class="memory-controls">
            <label for="memoryRunDate">Date
              <select id="memoryRunDate"></select>
            </label>
            <button type="button" id="memory-run-day">Run Selected Day</button>
            <button type="button" id="memory-clear-session" class="secondary">Clear Session</button>
            <button type="button" id="memory-undo-last" class="secondary">Undo Last Run</button>
            <button type="button" id="memory-redo-last" class="secondary">Redo Last Run</button>
            <button type="button" id="memory-delete-latest-sql" class="secondary">Delete Latest SQL</button>
          </div>
            <div class="memory-day-layout">
              <div class="memory-calendar" id="memoryCalendar"></div>
              <div class="memory-chat-panel">
                <h2>Selected Day Chat</h2>
                <div id="memoryDayMessages" class="logs memory-chat-preview">Choose a date to load chat records.</div>
              </div>
            </div>
            <p class="muted" id="memory-status"></p>
            <div id="memoryFiles">Loading...</div>
            <h2>Last Run</h2>
            <pre id="memoryRunResult">No memory run yet.</pre>
          </div>
        </section>
        <section id="main-plugins" class="pane">
          <div id="pluginListPanel">
            <div class="plugin-toolbar">
              <div>
                <h2>Plugin</h2>
                <p class="muted">Manage local plugins and their runtime switches.</p>
              </div>
              <label for="pluginSearch">Search plugins
                <input id="pluginSearch" autocomplete="off" placeholder="name, id, kind" />
              </label>
            </div>
            <div id="pluginGrid" class="plugin-grid">Loading...</div>
          </div>
          <section id="pluginConfigPanel" class="plugin-config pane">
            <div class="plugin-config-head">
              <button type="button" id="pluginBack" class="secondary">← Plugin</button>
              <h2 id="pluginConfigTitle">Plugin Config</h2>
            </div>
            <div id="pluginConfigBody">Choose a plugin to configure.</div>
          </section>
          <p class="muted" id="plugin-status"></p>
        </section>
        <section id="main-initiated-behaviors" class="pane">
          <div id="behaviorListPanel">
            <div class="behavior-toolbar">
              <div>
                <h2>Initiated Behaviors</h2>
                <p class="muted">Runtime plans and layer-based prompt profiles from src/contexts/agent-profile/prompts.</p>
              </div>
              <label for="behaviorTypeFilter">Type
                <select id="behaviorTypeFilter">
                  <option value="all">all</option>
                  <option value="event">event</option>
                  <option value="randomized">randomized</option>
                </select>
              </label>
            </div>
            <div class="behavior-layout">
              <div class="behavior-table-wrap">
                <table class="behavior-table" aria-label="Initiated behaviors">
                  <colgroup>
                    <col style="width: 6%" />
                    <col style="width: 5%" />
                    <col style="width: 5%" />
                    <col style="width: 15%" />
                    <col style="width: 8%" />
                    <col style="width: 19%" />
                    <col style="width: 9%" />
                    <col style="width: 11%" />
                    <col style="width: 9%" />
                    <col style="width: 8%" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Enabled</th>
                      <th>Weight</th>
                      <th>Priority</th>
                      <th>Behavior</th>
                      <th>Type</th>
                      <th>Source / Schedule</th>
                      <th>15m response</th>
                      <th>Last run</th>
                      <th>Health</th>
                      <th>Config</th>
                    </tr>
                  </thead>
                  <tbody id="behaviorTableBody">
                    <tr><td colspan="10" class="muted">Loading initiated behaviors...</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="behavior-recent">
                <h2>Recent Runs</h2>
                <div class="behavior-recent-scroll">
                  <table class="behavior-recent-table">
                    <thead>
                      <tr><th>Time</th><th>Behavior</th><th>Type</th><th>Trigger</th><th>Result</th><th>15m</th><th>Session</th></tr>
                    </thead>
                    <tbody id="behaviorRunsBody">
                      <tr><td colspan="7" class="muted">Loading runs...</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div class="behavior-chart">
                <h2>Randomized Response, 30 Minute Buckets</h2>
                <div id="behaviorChartBars" class="behavior-chart-bars" aria-label="Randomized response chart"></div>
                <div class="usage-legend"><span><i class="usage-swatch behavior-chart-responded"></i>responded within 15m</span><span><i class="usage-swatch behavior-chart-missed"></i>no response within 15m</span></div>
              </div>
            </div>
          </div>
          <section id="behaviorConfigPanel" class="behavior-config pane">
            <div class="behavior-config-head">
              <button type="button" id="behaviorBack" class="secondary">← Initiated Behaviors</button>
              <div class="behavior-config-title">
                <h2 id="behaviorConfigTitle">sleep_goodnight</h2>
                <p class="muted" id="behaviorConfigSummary">Goodnight and enter sleep cocoon.</p>
              </div>
              <div class="behavior-config-actions">
                <button type="button" id="behaviorConfigSave">Save</button>
                <button type="button" id="behaviorConfigReset" class="secondary">Reset</button>
              </div>
            </div>
            <div class="behavior-config-grid">
              <div class="behavior-config-box">
                <h2>Type</h2>
                <label for="behaviorConfigType">Type</label>
                <select id="behaviorConfigType">
                  <option value="event">event</option>
                  <option value="randomized">randomized</option>
                </select>
              </div>
              <div class="behavior-config-box" id="behaviorConfigSpecific"></div>
            </div>
            <div class="behavior-steps">
              <h2>Steps</h2>
              <div id="behaviorConfigSteps" class="behavior-step-list"></div>
            </div>
            <div class="behavior-config-box">
              <h2>Prompt Layers</h2>
              <div class="prompt-actions">
                <button type="button" id="behaviorLayerAdd">Add Layer</button>
                <button type="button" id="behaviorToolLayerAdd" class="secondary">Add Tool Request</button>
              </div>
              <div id="behaviorPromptLayerList"></div>
            </div>
            <div class="behavior-config-box behavior-layer-preview">
              <h2>Assembled Prompt Preview</h2>
              <div id="behaviorPromptPreview" class="logs">No prompt layers.</div>
            </div>
            <div class="behavior-recent">
              <h2>Recent Runs For This Behavior</h2>
              <div id="behaviorConfigRuns" class="behavior-recent-scroll"></div>
            </div>
          </section>
        </section>
        <section id="main-tool-preview" class="pane">
          <div class="tool-preview-grid">
            <div>
              <h2>Tool Return Preview</h2>
              <label for="toolPreviewSelect">Tool</label>
              <select id="toolPreviewSelect"></select>
              <label for="toolPreviewTarget">Target</label>
              <select id="toolPreviewTarget">
                <option value="feishu">Feishu</option>
                <option value="wechat">WeChat</option>
              </select>
              <label for="toolPreviewInput">Arguments JSON</label>
              <textarea id="toolPreviewInput" rows="12" spellcheck="false">{}</textarea>
              <div class="tool-preview-actions">
                <button type="button" id="tool-preview-run">Preview Return</button>
                <button type="button" id="tool-preview-reset" class="secondary">Reset Args</button>
              </div>
              <p class="muted" id="tool-preview-status"></p>
            </div>
            <div>
              <h2>Result</h2>
              <div id="toolPreviewResult" class="logs">Choose a tool and preview its return.</div>
            </div>
          </div>
        </section>
      </main>
      <section id="adminTerminal" class="admin-terminal collapsed" aria-label="Terminal logs">
        <div class="admin-terminal-head">
          <strong class="admin-terminal-title">Terminal</strong>
          <button class="terminal-tab" data-terminal-tab="active-session" type="button" aria-label="Active Session">Active Session</button>
          <button class="terminal-tab active" data-terminal-tab="system" type="button" aria-label="System Log">System</button>
          <button class="terminal-tab" data-terminal-tab="messages" type="button" aria-label="Message Log">Message</button>
          <button class="terminal-tab" data-terminal-tab="events" type="button" aria-label="Event Log">Event</button>
          <div class="terminal-actions">
            <button id="terminalRefresh" class="terminal-action" type="button" title="Refresh logs" aria-label="Refresh logs">↻</button>
            <button id="terminalCollapse" class="terminal-action" type="button" title="Pause terminal refresh" aria-label="Pause terminal refresh">Ⅱ</button>
          </div>
        </div>
        <div class="admin-terminal-body">
          <div id="terminal-active-session" class="terminal-pane"><div id="activeSessionLogs" class="logs">Loading...</div></div>
          <div id="terminal-system" class="terminal-pane active"><div id="logs" class="logs">Loading...</div></div>
          <div id="terminal-messages" class="terminal-pane"><div id="messageLogs" class="logs">Loading...</div></div>
          <div id="terminal-events" class="terminal-pane"><div id="eventLogs" class="logs">Loading...</div></div>
        </div>
      </section>
    </div>
    <script>
      const $ = (id) => document.getElementById(id);
      let terminalAutoRefreshPaused = false;
      let terminalRefreshInFlight = false;
      let initiatedBehaviorPayload = { plans: [], runs: [], buckets: [] };
      let behaviorConfigId = "";
      let behaviorConfigLayers = [];
      let behaviorConfigLayerIndex = 0;
      const behaviorLayerRoles = ["user", "assistant", "tool_request"];
      const initiatedBehaviorSummaries = {
        sleep_goodnight: "Event behavior with backend sleep_cocoon action=in before the LLM prompt.",
        sleep_morning: "Event behavior for the normal wake transition.",
        sleep_force_wake: "Event behavior for forced wake; distinct from ordinary morning.",
        ritual: "Randomized ritual initiation for dates, holidays, and lightweight greetings.",
        review: "Randomized review initiation for open loops and recent context.",
        story: "Randomized low-frequency first-person story snippet.",
        care: "Randomized low-interruption care check-in.",
        share: "Randomized content share tied to recent interests.",
        invite: "Randomized invitation to a small shared activity.",
        real_world_suggestion: "Randomized real-world suggestion such as food, rest, or sleep."
      };
      async function refreshInitiatedBehaviors() {
        try {
          const response = await fetch("/admin/api/initiated-behaviors");
          initiatedBehaviorPayload = await response.json();
        } catch (error) {
          initiatedBehaviorPayload = { plans: [], runs: [], buckets: [] };
          $("behaviorTableBody").innerHTML = '<tr><td colspan="10" class="muted">Failed to load initiated behaviors.</td></tr>';
          $("behaviorRunsBody").innerHTML = '<tr><td colspan="7" class="muted">Failed to load runs.</td></tr>';
          $("behaviorChartBars").innerHTML = "";
          return;
        }
        renderInitiatedBehaviorList();
      }
      function renderInitiatedBehaviorList() {
        const typeFilter = $("behaviorTypeFilter")?.value || "all";
        const plans = (initiatedBehaviorPayload.plans || []).filter((plan) => typeFilter === "all" || plan.kind === typeFilter);
        const runs = initiatedBehaviorPayload.runs || [];
        $("behaviorTableBody").innerHTML = plans.map((plan) => {
          const responseRatio = behaviorResponseRatio(plan.id, runs);
          const lastRun = runs.find((run) => run.behaviorId === plan.id);
          const source = plan.kind === "event" ? (plan.triggerEvent || "-") : "randomized";
          const weight = plan.kind === "event" ? "-" : valueOrDash(plan.weight);
          const priority = plan.kind === "event" ? "-" : valueOrDash(plan.priority);
          const health = plan.availability?.status === "unavailable" ? "unavailable" : plan.enabled ? "ok" : "disabled";
          return '<tr class="behavior-row" data-behavior-row="' + escapeAttr(plan.id) + '">' +
            '<td><label class="plugin-switch" title="Toggle behavior"><input type="checkbox" data-behavior-enabled="' + escapeAttr(plan.id) + '" ' + (plan.enabled ? "checked " : "") + '/><span class="plugin-switch-visual"></span></label></td>' +
            '<td>' + escapeHtml(weight) + '</td>' +
            '<td>' + escapeHtml(priority) + '</td>' +
            '<td><span class="behavior-id">' + escapeHtml(plan.id) + '</span></td>' +
            '<td><span class="behavior-kind ' + escapeAttr(plan.kind) + '">' + escapeHtml(plan.kind) + '</span></td>' +
            '<td>' + escapeHtml(source) + '</td>' +
            '<td>' + escapeHtml(responseRatio) + '</td>' +
            '<td>' + escapeHtml(lastRun ? formatAdminTime(lastRun.triggeredAt) : "never") + '</td>' +
            '<td><span class="behavior-status ' + (health === "ok" ? "on" : "") + '">' + escapeHtml(health) + '</span></td>' +
            '<td><button type="button" data-behavior-config="' + escapeAttr(plan.id) + '">Config</button></td>' +
          '</tr>';
        }).join("") || '<tr><td colspan="10" class="muted">No initiated behavior plans.</td></tr>';
        document.querySelectorAll("[data-behavior-config]").forEach((button) => button.addEventListener("click", () => openInitiatedBehaviorConfig(button.dataset.behaviorConfig)));
        document.querySelectorAll("[data-behavior-enabled]").forEach((input) => input.addEventListener("change", () => setInitiatedBehaviorEnabled(input.dataset.behaviorEnabled, input.checked, input)));
        renderInitiatedBehaviorRuns(runs);
        renderInitiatedBehaviorChart(initiatedBehaviorPayload.buckets || []);
      }
      async function setInitiatedBehaviorEnabled(id, enabled, input) {
        if (!id) return;
        input.disabled = true;
        try {
          const response = await fetch("/admin/api/initiated-behaviors/" + encodeURIComponent(id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled })
          });
          if (!response.ok) throw new Error(await response.text());
          await refreshInitiatedBehaviors();
        } catch (error) {
          input.checked = !enabled;
          input.disabled = false;
          alert("Failed to update behavior: " + (error && error.message ? error.message : String(error)));
        }
      }
      function renderInitiatedBehaviorRuns(runs) {
        $("behaviorRunsBody").innerHTML = (runs || []).map((run) =>
          '<tr><td>' + escapeHtml(formatAdminTime(run.triggeredAt)) + '</td><td>' + escapeHtml(run.behaviorId) + '</td><td>' + escapeHtml(run.kind) + '</td><td>' + escapeHtml(run.trigger || "-") + '</td><td>' + escapeHtml(run.result || "-") + '</td><td>' + escapeHtml(formatBool(run.respondedWithin15m)) + '</td><td>' + escapeHtml(run.sessionId || "-") + '</td></tr>'
        ).join("") || '<tr><td colspan="7" class="muted">No runs recorded.</td></tr>';
      }
      function renderInitiatedBehaviorChart(buckets) {
        const maxTotal = Math.max(1, ...(buckets || []).map((bucket) => Number(bucket.total) || 0));
        $("behaviorChartBars").innerHTML = (buckets || []).map((bucket) => {
          const responded = Number(bucket.respondedWithin15m) || 0;
          const missed = Number(bucket.notRespondedWithin15m) || 0;
          const respondedHeight = Math.max(0, Math.round((responded / maxTotal) * 84));
          const missedHeight = Math.max(0, Math.round((missed / maxTotal) * 84));
          const title = formatAdminTime(bucket.startAt) + " total " + valueOrDash(bucket.total);
          return '<div class="behavior-chart-bar-wrap" title="' + escapeAttr(title) + '"><div class="behavior-chart-bar"><span class="behavior-chart-responded" style="height: ' + respondedHeight + 'px"></span><span class="behavior-chart-missed" style="height: ' + missedHeight + 'px"></span></div></div>';
        }).join("");
      }
      function openInitiatedBehaviorConfig(id) {
        const detail = (initiatedBehaviorPayload.plans || []).find((plan) => plan.id === id);
        if (!detail) return;
        behaviorConfigId = id;
        behaviorConfigLayers = cloneBehaviorLayers(detail.promptProfile?.layers || []);
        behaviorConfigLayerIndex = 0;
        $("behaviorListPanel").style.display = "none";
        $("behaviorConfigPanel").classList.add("active");
        $("behaviorConfigPanel").style.display = "block";
        $("behaviorConfigTitle").textContent = detail.id;
        $("behaviorConfigSummary").textContent = initiatedBehaviorSummaries[detail.id] || "";
        $("behaviorConfigType").value = detail.kind;
        $("behaviorConfigType").onchange = renderBehaviorConfigSpecific;
        const triggerLabel = detail.kind === "event" ? (detail.triggerEvent || "event") : "randomized";
        renderBehaviorConfigSpecific(detail);
        $("behaviorConfigSteps").innerHTML = (detail.steps || []).map((step, index) => {
          const status = detail.availability?.steps?.[index];
          return '<div class="behavior-step-item"><strong>' + escapeHtml(step.kind) + '</strong><div>' + escapeHtml(formatBehaviorStepDetail(step)) + '</div>' + (step.arguments ? '<div class="muted">' + escapeHtml(JSON.stringify(step.arguments)) + '</div>' : "") + (status ? '<div class="muted">' + escapeHtml(status.status + (status.reason ? ": " + status.reason : "")) + '</div>' : "") + '</div>';
        }).join("") || '<p class="muted">No steps configured.</p>';
        renderBehaviorLayerEditor();
        const runs = (initiatedBehaviorPayload.runs || []).filter((run) => run.behaviorId === id);
        $("behaviorConfigRuns").innerHTML = '<table class="behavior-recent-table"><thead><tr><th>Time</th><th>Trigger</th><th>Result</th><th>15m</th><th>Session</th></tr></thead><tbody>' + (runs.map((run) => '<tr><td>' + escapeHtml(formatAdminTime(run.triggeredAt)) + '</td><td>' + escapeHtml(run.trigger || triggerLabel) + '</td><td>' + escapeHtml(run.result || "-") + '</td><td>' + escapeHtml(formatBool(run.respondedWithin15m)) + '</td><td>' + escapeHtml(run.sessionId || "-") + '</td></tr>').join("") || '<tr><td colspan="5" class="muted">No runs recorded.</td></tr>') + '</tbody></table>';
      }
      function renderBehaviorConfigSpecific(detail) {
        const current = detail || (initiatedBehaviorPayload.plans || []).find((plan) => plan.id === behaviorConfigId) || {};
        const kind = $("behaviorConfigType").value;
        $("behaviorConfigSpecific").innerHTML = kind === "event"
          ? '<h2>Event</h2><label for="behaviorConfigTriggerEvent">triggerEvent</label><input id="behaviorConfigTriggerEvent" value="' + escapeAttr(current.triggerEvent || "") + '" />'
          : '<h2>Randomized</h2><label for="behaviorConfigWeight">Weight</label><input id="behaviorConfigWeight" type="number" step="0.01" value="' + escapeAttr(valueOrDash(current.weight) === "-" ? "0" : valueOrDash(current.weight)) + '" /><label for="behaviorConfigPriority">Priority</label><input id="behaviorConfigPriority" type="number" step="1" value="' + escapeAttr(valueOrDash(current.priority) === "-" ? "0" : valueOrDash(current.priority)) + '" />';
      }
      function cloneBehaviorLayers(layers) {
        return (layers || []).map((layer, index) => ({
          id: layer.id || "layer_" + (index + 1),
          title: layer.title || layer.id || "Layer " + (index + 1),
          role: behaviorLayerRoles.includes(layer.role) ? layer.role : "user",
          enabled: layer.enabled !== false,
          content: layer.content || "",
          order: Number.isFinite(Number(layer.order)) ? Number(layer.order) : (index + 1) * 10,
          toolName: layer.role === "tool_request" ? (layer.toolName || "check_chat") : undefined,
          toolCallId: layer.role === "tool_request" ? (layer.toolCallId || "") : undefined,
          toolArguments: layer.role === "tool_request" ? (layer.toolArguments || "{}") : undefined,
          thinking: (layer.role === "assistant" || layer.role === "tool_request") ? (layer.thinking || "") : undefined
        }));
      }
      function syncCurrentBehaviorLayerFromEditor() {
        // Behavior prompt layers are edited directly in their details blocks, matching the main Prompt page.
      }
      function renderBehaviorLayerEditor() {
        const layers = [...behaviorConfigLayers].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
        $("behaviorPromptLayerList").innerHTML = layers.map((layer, index) => renderBehaviorPromptLayer(layer, index, layers.length)).join("") || '<p class="muted">No prompt layers yet.</p>';
        layers.forEach((layer, index) => bindBehaviorPromptLayer(layer, index, layers));
        renderBehaviorPromptPreview();
      }
      function addBehaviorLayer(role = "user") {
        const nextIndex = behaviorConfigLayers.length + 1;
        const normalizedRole = role === "tool_request" ? "tool_request" : "user";
        const layer = {
          id: "layer_" + nextIndex,
          title: "Layer " + nextIndex,
          role: normalizedRole,
          enabled: true,
          order: nextIndex * 10
        };
        if (normalizedRole === "tool_request") {
          behaviorConfigLayers.push({ ...layer, content: "", thinking: "", toolName: "check_chat", toolArguments: "{}" });
        } else {
          behaviorConfigLayers.push({ ...layer, content: "" });
        }
        renderBehaviorLayerEditor();
      }
      function renderBehaviorPromptLayer(layer, index, count) {
        const role = behaviorLayerRoles.includes(layer.role) ? layer.role : "user";
        const isToolRequest = role === "tool_request";
        const showsThinking = role === "assistant" || isToolRequest;
        const showsContent = !isToolRequest;
        return \`
          <details class="prompt-layer" data-behavior-layer-id="\${escapeAttr(layer.id)}" open>
            <summary>\${escapeHtml(layer.title || "Untitled Layer")}<span>[\${escapeHtml(role)}]\${layer.enabled ? "" : " disabled"}</span></summary>
            <div class="row">
              <div>
                <label>Title</label>
                <input data-field="title" value="\${escapeAttr(layer.title)}" />
              </div>
              <div>
                <label>Role</label>
                <select data-field="role">
                  \${behaviorLayerRoles.map((item) => \`<option value="\${item}" \${role === item ? "selected" : ""}>\${item}</option>\`).join("")}
                </select>
              </div>
              <label><input data-field="enabled" type="checkbox" \${layer.enabled ? "checked" : ""} /> Enabled</label>
            </div>
            \${isToolRequest ? \`<div class="row">
              <div>
                <label>Tool Name</label>
                <select data-field="toolName">
                  \${renderToolOptions(layer.toolName)}
                </select>
              </div>
              <div>
                <label>Tool Call ID</label>
                <input data-field="toolCallId" value="\${escapeAttr(layer.toolCallId || "")}" placeholder="call_1" />
              </div>
              <div></div>
            </div>
            <label>Tool Arguments</label>
            <textarea data-field="toolArguments" rows="3">\${escapeHtml(layer.toolArguments || "")}</textarea>
            <p class="muted">Tool result is generated by actually running this request when the LLM request is built. It is not editable.</p>\` : ""}
            \${showsThinking ? \`<label>\${isToolRequest ? "Thinking / Assistant Tool Call Content" : "Thinking / Assistant Content"}</label>
            <textarea data-field="thinking" rows="3">\${escapeHtml(layer.thinking || "")}</textarea>\` : ""}
            \${showsContent ? \`<label>Content</label>
            <textarea data-field="content" rows="7">\${escapeHtml(layer.content || "")}</textarea>\` : ""}
            <div class="prompt-actions">
              <button type="button" data-action="up" \${index === 0 ? "disabled" : ""}>Up</button>
              <button type="button" data-action="down" \${index === count - 1 ? "disabled" : ""}>Down</button>
              <button type="button" data-action="delete" class="secondary">Delete</button>
            </div>
          </details>
        \`;
      }
      function bindBehaviorPromptLayer(layer, index, sortedLayers) {
        const root = document.querySelector('[data-behavior-layer-id="' + cssEscape(layer.id) + '"]');
        if (!root) return;
        root.querySelector('[data-field="title"]').addEventListener("input", (event) => {
          layer.title = event.target.value;
          renderBehaviorPromptPreview();
        });
        root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
          layer.role = behaviorLayerRoles.includes(event.target.value) ? event.target.value : "user";
          if (layer.role !== "tool_request") {
            delete layer.toolName;
            delete layer.toolCallId;
            delete layer.toolArguments;
          } else {
            layer.toolName = layer.toolName || "check_chat";
            layer.toolArguments = layer.toolArguments || "{}";
          }
          if (layer.role !== "assistant" && layer.role !== "tool_request") delete layer.thinking;
          renderBehaviorLayerEditor();
        });
        root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => {
          layer.enabled = event.target.checked;
          renderBehaviorPromptPreview();
        });
        root.querySelector('[data-field="toolName"]')?.addEventListener("change", (event) => {
          layer.toolName = event.target.value;
          renderBehaviorPromptPreview();
        });
        root.querySelector('[data-field="toolCallId"]')?.addEventListener("input", (event) => {
          layer.toolCallId = event.target.value;
          renderBehaviorPromptPreview();
        });
        root.querySelector('[data-field="thinking"]')?.addEventListener("input", (event) => {
          layer.thinking = event.target.value;
          renderBehaviorPromptPreview();
        });
        root.querySelector('[data-field="toolArguments"]')?.addEventListener("input", (event) => {
          layer.toolArguments = event.target.value;
          renderBehaviorPromptPreview();
        });
        root.querySelector('[data-field="content"]')?.addEventListener("input", (event) => {
          layer.content = event.target.value;
          renderBehaviorPromptPreview();
        });
        root.querySelector('[data-action="delete"]').addEventListener("click", () => {
          behaviorConfigLayers = behaviorConfigLayers.filter((item) => item.id !== layer.id);
          renderBehaviorLayerEditor();
        });
        root.querySelector('[data-action="up"]').addEventListener("click", () => moveBehaviorPromptLayer(index, -1, sortedLayers));
        root.querySelector('[data-action="down"]').addEventListener("click", () => moveBehaviorPromptLayer(index, 1, sortedLayers));
      }
      function moveBehaviorPromptLayer(index, delta, sortedLayers) {
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= sortedLayers.length) return;
        const currentOrder = sortedLayers[index].order;
        sortedLayers[index].order = sortedLayers[nextIndex].order;
        sortedLayers[nextIndex].order = currentOrder;
        renderBehaviorLayerEditor();
      }
      function renderBehaviorPromptPreview() {
        const messages = behaviorConfigLayers
          .filter((layer) => layer.enabled !== false)
          .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0))
          .map((layer) => behaviorLayerToPreviewMessage(layer));
        $("behaviorPromptPreview").innerHTML = messages.length
          ? renderLLMRequestBlock("Initiated Behavior Prompt · " + behaviorConfigId, {
            source: "initiated-behavior-config",
            model: "preview",
            temperature: "",
            messages,
            tools: []
          })
          : "No enabled prompt layers.";
      }
      function behaviorLayerToPreviewMessage(layer) {
        if (layer.role === "tool_request") {
          return {
            role: "assistant",
            content: renderPromptPreviewText(layer.content || ""),
            reasoningContent: renderPromptPreviewText(layer.thinking || layer.content || ""),
            toolCalls: [{
              id: layer.toolCallId || "initiated_" + behaviorConfigId + "_" + layer.id,
              type: "function",
              function: {
                name: layer.toolName || "check_chat",
                arguments: renderPromptPreviewText(layer.toolArguments || "{}")
              }
            }]
          };
        }
        return {
          role: layer.role === "assistant" ? "assistant" : "user",
          content: renderPromptPreviewText(layer.content || ""),
          reasoningContent: layer.role === "assistant" && layer.thinking ? renderPromptPreviewText(layer.thinking) : undefined
        };
      }
      function renderPromptPreviewText(value) {
        return String(value || "").replace(/\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (_, key) => {
          const resolved = promptVariables && Object.prototype.hasOwnProperty.call(promptVariables, key) ? promptVariables[key] : undefined;
          if (resolved === undefined || resolved === null) return "{{" + key + "}}";
          return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
        });
      }
      function bindBehaviorLayerEditorEvents() {
        // Behavior prompt layer events are bound after each render, matching the main Prompt page.
      }
      async function saveBehaviorConfig() {
        if (!behaviorConfigId) return;
        syncCurrentBehaviorLayerFromEditor();
        const detail = (initiatedBehaviorPayload.plans || []).find((plan) => plan.id === behaviorConfigId);
        const kind = $("behaviorConfigType").value === "randomized" ? "randomized" : "event";
        const body = {
          kind,
          promptProfile: { layers: behaviorConfigLayers }
        };
        if (typeof detail?.enabled === "boolean") body.enabled = detail.enabled;
        if (kind === "event") {
          body.triggerEvent = $("behaviorConfigTriggerEvent")?.value || "";
        } else {
          body.weight = Number($("behaviorConfigWeight")?.value) || 0;
          body.priority = Number($("behaviorConfigPriority")?.value) || 0;
        }
        $("behaviorConfigSave").disabled = true;
        try {
          const response = await fetch("/admin/api/initiated-behaviors/" + encodeURIComponent(behaviorConfigId), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (!response.ok) throw new Error(await response.text());
          await refreshInitiatedBehaviors();
          openInitiatedBehaviorConfig(behaviorConfigId);
        } catch (error) {
          alert("Failed to save behavior: " + (error && error.message ? error.message : String(error)));
        } finally {
          $("behaviorConfigSave").disabled = false;
        }
      }
      function resetBehaviorConfig() {
        if (behaviorConfigId) openInitiatedBehaviorConfig(behaviorConfigId);
      }
      function closeInitiatedBehaviorConfig() {
        $("behaviorConfigPanel").classList.remove("active");
        $("behaviorConfigPanel").style.display = "none";
        $("behaviorListPanel").style.display = "block";
      }
      function behaviorResponseRatio(id, runs) {
        const scoped = (runs || []).filter((run) => run.behaviorId === id && typeof run.respondedWithin15m === "boolean");
        if (!scoped.length) return "-";
        const responded = scoped.filter((run) => run.respondedWithin15m === true).length;
        return Math.round((responded / scoped.length) * 100) + "%";
      }
      function formatBehaviorStepDetail(step) {
        if (step.kind === "backend_effect") return step.effect || "";
        if (step.kind === "llm_instruction") return step.promptProfilePath || "";
        if (step.kind === "record_only") return step.reason || "";
        return "";
      }
      function valueOrDash(value) {
        if (value === undefined || value === null || value === "") return "-";
        return String(value);
      }
      function formatBool(value) {
        if (value === true) return "yes";
        if (value === false) return "no";
        return "-";
      }
      function formatAdminTime(value) {
        if (!value) return "-";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }
      function setTabs(kind, name) {
        document.querySelectorAll("[data-" + kind + "-tab]").forEach((button) => button.classList.toggle("active", button.dataset[kind + "Tab"] === name));
        document.querySelectorAll(kind === "left" ? "#left-llm,#left-feishu,#left-core,#left-agent" : "#main-prompts,#main-shells,#main-llm-chain,#main-token-usage,#main-memory,#main-plugins,#main-initiated-behaviors,#main-tool-preview").forEach((pane) => pane.classList.remove("active"));
        $(kind === "left" ? "left-" + name : "main-" + name).classList.add("active");
      }
      function setTerminalTab(name) {
        document.querySelectorAll("[data-terminal-tab]").forEach((button) => button.classList.toggle("active", button.dataset.terminalTab === name));
        document.querySelectorAll("#terminal-active-session,#terminal-system,#terminal-messages,#terminal-events").forEach((pane) => pane.classList.remove("active"));
        $("terminal-" + name).classList.add("active");
      }
      function toggleTerminalCollapsed() {
        const terminal = $("adminTerminal");
        terminal.classList.toggle("collapsed");
      }
      function updateTerminalAutoRefreshButton() {
        $("terminalCollapse").textContent = terminalAutoRefreshPaused ? "▶" : "Ⅱ";
        $("terminalCollapse").setAttribute("title", terminalAutoRefreshPaused ? "Resume terminal refresh" : "Pause terminal refresh");
        $("terminalCollapse").setAttribute("aria-label", terminalAutoRefreshPaused ? "Resume terminal refresh" : "Pause terminal refresh");
      }
      function toggleTerminalAutoRefreshPaused() {
        terminalAutoRefreshPaused = !terminalAutoRefreshPaused;
        updateTerminalAutoRefreshButton();
      }
      async function refreshTerminal() {
        if (terminalRefreshInFlight) return;
        terminalRefreshInFlight = true;
        try {
          await refreshLogs();
          await refreshActiveSessionTerminal();
        } finally {
          terminalRefreshInFlight = false;
        }
      }
      document.querySelectorAll("[data-left-tab]").forEach((button) => button.addEventListener("click", () => setTabs("left", button.dataset.leftTab)));
      document.querySelectorAll("[data-channel-tab]").forEach((button) => button.addEventListener("click", () => {
        document.querySelectorAll("[data-channel-tab]").forEach((tab) => tab.classList.toggle("active", tab === button));
        document.querySelectorAll("#channel-feishu,#channel-wechat").forEach((pane) => pane.classList.remove("active"));
        $("channel-" + button.dataset.channelTab).classList.add("active");
      }));
      document.querySelectorAll("[data-behavior-config]").forEach((button) => button.addEventListener("click", () => openInitiatedBehaviorConfig(button.dataset.behaviorConfig)));
      $("behaviorBack").addEventListener("click", closeInitiatedBehaviorConfig);
      $("behaviorTypeFilter").addEventListener("change", renderInitiatedBehaviorList);
      $("behaviorConfigSave").addEventListener("click", saveBehaviorConfig);
      $("behaviorConfigReset").addEventListener("click", resetBehaviorConfig);
      $("behaviorLayerAdd").addEventListener("click", () => addBehaviorLayer("user"));
      $("behaviorToolLayerAdd").addEventListener("click", () => addBehaviorLayer("tool_request"));
      bindBehaviorLayerEditorEvents();
      document.querySelectorAll("[data-main-tab]").forEach((button) => button.addEventListener("click", async () => {
        setTabs("main", button.dataset.mainTab);
        if (button.dataset.mainTab === "shells") await refreshShellEditor();
        if (button.dataset.mainTab === "llm-chain") await refreshLLMChain();
        if (button.dataset.mainTab === "token-usage") await refreshTokenUsage();
        if (button.dataset.mainTab === "memory") await refreshMemory();
        if (button.dataset.mainTab === "plugins") await refreshPlugins();
        if (button.dataset.mainTab === "initiated-behaviors") await refreshInitiatedBehaviors();
        if (button.dataset.mainTab === "tool-preview") await refreshToolPreviewTools();
      }));
      document.querySelectorAll("[data-terminal-tab]").forEach((button) => button.addEventListener("click", async () => {
        setTerminalTab(button.dataset.terminalTab);
        if (button.dataset.terminalTab === "active-session") await refreshActiveSessionTerminal();
      }));
      $("terminalRefresh").addEventListener("click", async () => {
        await refreshTerminal();
      });
      $("terminalCollapse").addEventListener("click", toggleTerminalAutoRefreshPaused);
      document.querySelector(".admin-terminal-head").addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        toggleTerminalCollapsed();
      });
      $("collapse").addEventListener("click", () => $("shell").classList.toggle("collapsed"));
      setInterval(() => {
        if (!terminalAutoRefreshPaused) refreshTerminal();
      }, 1000);

      async function refresh() {
        const config = await fetch("/admin/api/config").then((res) => res.json());
        $("config").textContent = JSON.stringify(config, null, 2);
        await refreshLLMApiPresets();
        if (!currentLLMApiPreset) clearLLMApiForm();
        $("inboundDebounceMs").value = String(config.core.inboundDebounceMs ?? 1000);
        $("timezone").value = config.core.timezone || "Asia/Singapore";
        $("defaultTargetPlugin").value = config.core.defaultTargetPlugin || "auto";
        $("appearanceDescription").value = (config.coreProfile && config.coreProfile.appearanceDescription) || "";
        $("librarySetting").value = (config.coreProfile && config.coreProfile.librarySetting) || "";
        $("coreProfilePreview").textContent = JSON.stringify(config.coreVariables || {
          appearance: (config.coreProfile && config.coreProfile.appearanceDescription) || "",
          library: { content: (config.coreProfile && config.coreProfile.librarySetting) || "" }
        }, null, 2);
        const tts = config.tts || {};
        $("tts-reference-status").textContent = "Backend: " + (tts.backend || "genie-tts")
          + " · Genie model: " + (tts.genieModelDir || "assets/tts/genie/models/alice") + (tts.genieModelAvailable ? " (found)" : " (missing, fallback to MOSS)")
          + " · Reference: " + (tts.genieReferenceAudio || tts.mossReferenceAudio || "assets/tts/references/alice/reference.wav")
          + " · Text: " + (tts.genieReferenceText || "assets/tts/references/alice/reference.txt") + (tts.genieReferenceTextAvailable ? " (found)" : " (missing)");
        await refreshAgentState();
        $("feishuEnabled").checked = Boolean(config.plugins.feishu.enabled);
        $("feishuConnectionMode").value = config.plugins.feishu.connectionMode || "";
        $("feishuAppId").value = config.plugins.feishu.appId || "";
        $("feishuRequireMention").checked = Boolean(config.plugins.feishu.requireMention);
        $("feishu-status").textContent = config.plugins.feishu.runtimeStarted ? "Feishu runtime started." : "Feishu runtime stopped.";
        $("wechatEnabled").checked = Boolean(config.plugins.wechat && config.plugins.wechat.enabled);
        $("wechatBaseURL").value = (config.plugins.wechat && config.plugins.wechat.baseURL) || "";
        $("wechatPollTimeoutMs").value = String((config.plugins.wechat && config.plugins.wechat.pollTimeoutMs) || 35000);
        $("wechat-status").textContent = config.plugins.wechat && config.plugins.wechat.runtimeStarted
          ? "WeChat runtime started."
          : config.plugins.wechat && config.plugins.wechat.loggedIn
            ? "WeChat logged in, runtime stopped."
            : "WeChat not logged in.";
        $("wechat-contacts").textContent = JSON.stringify((config.plugins.wechat && config.plugins.wechat.contacts) || [], null, 2);

        await refreshPromptProfile();
        await refreshShellEditor();
        await refreshRuntimeStatus();
        const pairings = await fetch("/admin/api/plugins/feishu/pairings").then((res) => res.json());
        $("pairings").textContent = JSON.stringify(pairings.contacts, null, 2);
        await refreshLLMRequests();
        await refreshTokenUsage();
        await refreshTerminal();
      }

      async function refreshLLMRequests() {
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        const blocks = [
          renderLLMRequestBlock("Current Prompt Profile Prebuild", payload.profilePreview),
          renderLLMRequestBlock("Latest Message Context Preview", payload.messagePreview),
          renderLLMRequestBlock("Latest Actual Request", payload.actual)
        ].filter(Boolean);
        $("llmRequests").innerHTML = blocks.length ? blocks.join("") : "No LLM request preview available.";
        $("llmRequests").scrollTop = 0;
      }

      async function refreshLLMChain() {
        const requestPayload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        $("llmChainSessions").innerHTML = renderLLMSessionGroups(requestPayload.activeSession, requestPayload.clearedSessions || [], requestPayload.memorySessions || [], requestPayload.talkActiveSession, requestPayload.talkSessions || []);
        bindLLMSessionDetails("llmChainSessions");
        $("llmChainSessions").scrollTop = $("llmChainSessions").scrollHeight;
      }

      async function refreshActiveSessionTerminal() {
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        $("activeSessionLogs").innerHTML = renderActiveSessionTerminalRows(payload.activeSession);
        $("activeSessionLogs").scrollTop = $("activeSessionLogs").scrollHeight;
      }

      async function refreshTokenUsage() {
        const params = new URLSearchParams({
          range: $("tokenUsageRange").value,
          bucket: $("tokenUsageBucket").value,
          agent: $("tokenUsageAgent").value,
          model: $("tokenUsageModel").value
        });
        const payload = await fetch("/admin/api/token-usage?" + params.toString()).then((res) => res.json());
        renderTokenUsage(payload);
      }

      async function refreshPlugins() {
        if ($("pluginConfigPanel").classList.contains("active")) return;
        const payload = await fetch("/admin/api/plugins").then((res) => res.json());
        const query = ($("pluginSearch").value || "").toLowerCase().trim();
        const plugins = (payload.plugins || []).filter((plugin) => {
          const haystack = [plugin.id, plugin.name, plugin.kind, plugin.status, plugin.description].join(" ").toLowerCase();
          return !query || haystack.includes(query);
        });
        $("pluginGrid").innerHTML = plugins.length ? plugins.map(renderPluginCard).join("") : '<p class="muted">No plugins match this search.</p>';
      }

      function renderPluginCard(plugin) {
        const initial = String(plugin.name || plugin.id || "?").slice(0, 1).toUpperCase();
        const canConfig = Boolean(plugin.configurable);
        const canSwitch = Boolean(plugin.switchable);
        const enabled = plugin.status === "enabled" || plugin.status === "missing_config" || plugin.status === "error";
        return \`
          <div class="plugin-card" data-plugin-card="\${escapeAttr(plugin.id)}">
            <div class="plugin-card-head">
              <div class="plugin-icon">\${escapeHtml(initial)}</div>
              <div>
                <div class="plugin-title">\${escapeHtml(plugin.name || plugin.id)}</div>
                <div class="plugin-desc">\${escapeHtml(plugin.description || "")}</div>
              </div>
            </div>
            <div class="plugin-meta">
              <div>ID: \${escapeHtml(plugin.id)}</div>
              <div>Kind: \${escapeHtml(plugin.kind)}</div>
              <div class="plugin-state">\${escapeHtml(plugin.status)} · \${escapeHtml(plugin.health)}</div>
              \${plugin.configSource ? \`<div>Config: \${escapeHtml(plugin.configSource)}</div>\` : ""}
              \${plugin.lastLoadedAt ? \`<div>Loaded: \${escapeHtml(plugin.lastLoadedAt)}</div>\` : ""}
            </div>
            <div class="plugin-actions">
              <div>
                <button type="button" data-plugin-config="\${escapeAttr(plugin.id)}" \${canConfig ? "" : "disabled"}>Config</button>
                <button type="button" class="secondary" data-plugin-reload="\${escapeAttr(plugin.id)}" \${canConfig ? "" : "disabled"}>Reload</button>
              </div>
              <label class="plugin-switch">
                <input type="checkbox" data-plugin-switch="\${escapeAttr(plugin.id)}" \${enabled ? "checked" : ""} \${canSwitch ? "" : "disabled"} />
                <span class="plugin-switch-visual" aria-hidden="true"></span>
              </label>
            </div>
          </div>
        \`;
      }

      async function openPluginConfig(pluginId) {
        $("plugin-status").textContent = "Loading plugin config...";
        const payload = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config").then((res) => res.json());
        if (payload.error) {
          $("plugin-status").textContent = "Cannot load plugin config: " + payload.error;
          return;
        }
        $("pluginListPanel").style.display = "none";
        $("pluginConfigPanel").classList.add("active");
        $("pluginConfigTitle").textContent = (payload.plugin && payload.plugin.name ? payload.plugin.name : pluginId) + " Config";
        renderPluginConfig(payload);
        $("plugin-status").textContent = "";
      }

      function closePluginConfig() {
        $("pluginConfigPanel").classList.remove("active");
        $("pluginListPanel").style.display = "";
        $("pluginConfigBody").textContent = "Choose a plugin to configure.";
        refreshPlugins();
      }

      function renderPluginConfig(payload) {
        if (payload.plugin && payload.plugin.id === "tts") {
          renderTtsPluginConfig(payload);
          return;
        }
        const config = payload.configValue || {};
        const fields = (payload.configSchema && payload.configSchema.fields) || [];
        const groups = (payload.configSchema && payload.configSchema.groups) || [];
        $("pluginConfigBody").innerHTML = \`
          \${renderPluginConfigGroupSelector(groups)}
          <form id="pluginConfigForm" class="plugin-config-grid" data-plugin-id="\${escapeAttr(payload.plugin.id)}" novalidate>
            <div>\${fields.filter((_, index) => index % 2 === 0).map((field) => renderPluginFieldContainer(field, config, payload.apiPresets || [])).join("")}</div>
            <div>\${fields.filter((_, index) => index % 2 === 1).map((field) => renderPluginFieldContainer(field, config, payload.apiPresets || [])).join("")}
              <div class="prompt-actions">
                <button type="submit">Save</button>
                <button type="button" id="pluginConfigReload" class="secondary">Reload</button>
                <button type="button" id="pluginConfigLogs" class="secondary">Load Events</button>
              </div>
            </div>
          </form>
          <h2>Route</h2>
          <pre>\${escapeHtml((payload.routePreview || []).join("\\n"))}</pre>
          <h2>Runtime Access</h2>
          <pre>\${escapeHtml((payload.runtimeAccess || []).join("\\n"))}</pre>
          \${payload.plugin && payload.plugin.id === "world_wanderer" ? renderWorldWandererMapBox(payload) : ""}
          \${payload.testSchema ? renderPluginTestBox(payload) : ""}
          <h2>Recent Events</h2>
          <div id="pluginEvents" class="logs plugin-events">No events loaded.</div>
        \`;
        bindPluginConfigForm();
        if (payload.plugin && payload.plugin.id === "world_wanderer") initWorldWandererMap(payload);
      }

      function renderWorldWandererMapBox(payload) {
        const path = (payload.runtimeState && payload.runtimeState.pathStack) || [];
        return \`
          <h2>Recent Path</h2>
          <div id="worldWandererMap" class="world-wanderer-map"></div>
          <p id="worldWandererPathMeta" class="world-wanderer-path-meta">\${escapeHtml(worldWandererPathMeta(path, payload.configValue || {}))}</p>
        \`;
      }

      function worldWandererPathMeta(path, config) {
        if (!config.mapsJavaScriptApiKey) return "Set Maps JavaScript API Key to load the map.";
        if (!path.length) return "No path entries yet.";
        const last = path[path.length - 1];
        return path.length + " points, latest " + (last.time || "") + " @ " + Number(last.lat).toFixed(5) + ", " + Number(last.lng).toFixed(5);
      }

      function initWorldWandererMap(payload) {
        const key = payload.configValue && payload.configValue.mapsJavaScriptApiKey;
        const path = ((payload.runtimeState && payload.runtimeState.pathStack) || []).filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)));
        if (!key || !path.length) return;
        window.__worldWandererMapPayload = { path };
        if (window.google && window.google.maps) {
          drawWorldWandererMap();
          return;
        }
        if (document.getElementById("googleMapsJs")) return;
        const script = document.createElement("script");
        script.id = "googleMapsJs";
        script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&callback=drawWorldWandererMap";
        script.async = true;
        document.head.appendChild(script);
      }

      function drawWorldWandererMap() {
        const target = $("worldWandererMap");
        const path = (window.__worldWandererMapPayload && window.__worldWandererMapPayload.path) || [];
        if (!target || !path.length || !(window.google && window.google.maps)) return;
        const coords = path.map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
        const map = new google.maps.Map(target, { center: coords[coords.length - 1], zoom: 16, mapTypeId: "roadmap" });
        const bounds = new google.maps.LatLngBounds();
        coords.forEach((coord) => bounds.extend(coord));
        new google.maps.Polyline({ path: coords, map, strokeColor: "#2563eb", strokeOpacity: 0.9, strokeWeight: 4 });
        new google.maps.Marker({ position: coords[0], map, label: "S" });
        new google.maps.Marker({ position: coords[coords.length - 1], map, label: "E" });
        if (coords.length > 1) map.fitBounds(bounds);
      }
      window.drawWorldWandererMap = drawWorldWandererMap;

      function renderTtsPluginConfig(payload) {
        const config = payload.configValue || {};
        const fields = (payload.configSchema && payload.configSchema.fields) || [];
        const apiPresets = payload.apiPresets || [];
        const field = (key) => fields.find((item) => item.key === key);
        const render = (key) => field(key) ? renderPluginFieldContainer(field(key), config, apiPresets) : "";
        $("pluginConfigBody").innerHTML = \`
          <form id="pluginConfigForm" class="plugin-config-sections" data-plugin-id="\${escapeAttr(payload.plugin.id)}" data-plugin-save-mode="section">
            <section class="plugin-config-section" data-plugin-config-section="translation">
              <div class="plugin-section-head">
                <h2>Translation</h2>
              </div>
              <div class="plugin-preset-row">
                \${render("translationEditPresetName")}
                <button type="button" class="secondary" data-plugin-preset-toggle="translation">Modify</button>
              </div>
              <div class="plugin-preset-editor" data-plugin-preset-editor="translation">
                \${render("newTranslationPresetName")}
                \${render("currentTranslation.apiPresetName")}
                \${render("currentTranslation.prompt")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="translation">Save Translation Preset</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="model-genie" data-plugin-conversion-panel="genie">
              <div class="plugin-section-head">
                <h2>Model / Conversion / Genie</h2>
              </div>
              <div class="plugin-public-grid">
                \${render("conversion.genie.enabled")}
                \${render("conversion.genie.baseURL")}
              </div>
              <div class="plugin-preset-row">
                \${render("voice.modelEditPresetName")}
                <button type="button" class="secondary" data-plugin-preset-toggle="model">Modify</button>
              </div>
              <div class="plugin-preset-editor" data-plugin-preset-editor="model">
                \${render("voice.newModelConfigName")}
                \${render("voice.currentModel.language")}
                \${render("voice.currentModel.modelDir")}
                \${render("voice.currentModel.referenceAudio")}
                \${render("voice.currentModel.referenceText")}
                \${render("voice.currentModel.speed")}
                \${render("voice.currentModel.splitText")}
                \${render("voice.currentModel.partSilenceSeconds")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="model-genie">Save Genie Settings</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="conversion-openai-api" data-plugin-conversion-panel="openai-api">
              <div class="plugin-section-head"><h2>Conversion / OpenAI-API</h2></div>
              <div class="plugin-public-grid">
                \${render("conversion.openaiApi.apiPresetName")}
                \${render("conversion.openaiApi.model")}
                \${render("conversion.openaiApi.voice")}
                \${render("conversion.openaiApi.timeoutMs")}
                \${render("conversion.openaiApi.sampleRate")}
                \${render("conversion.openaiApi.channels")}
                \${render("conversion.openaiApi.extraParamsJson")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="conversion-openai-api">Save OpenAI-API Conversion</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="conversion-bailian" data-plugin-conversion-panel="bailian">
              <div class="plugin-section-head"><h2>Conversion / Bailian</h2></div>
              <div class="plugin-public-grid">
                \${render("conversion.bailian.service")}
                \${render("conversion.bailian.endpoint")}
                \${render("conversion.bailian.apiKey")}
                \${render("conversion.bailian.apiKeyEnv")}
                \${render("conversion.bailian.workspaceId")}
                \${render("conversion.bailian.userAgent")}
                \${render("conversion.bailian.model")}
                \${render("conversion.bailian.voice")}
                \${render("conversion.bailian.languageType")}
                \${render("conversion.bailian.mode")}
                \${render("conversion.bailian.responseFormat")}
                \${render("conversion.bailian.timeoutMs")}
                \${render("conversion.bailian.sampleRate")}
                \${render("conversion.bailian.channels")}
                \${render("conversion.bailian.extraParamsJson")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="conversion-bailian">Save Bailian Conversion</button>
              </div>
            </section>
            <section class="plugin-config-section" data-plugin-config-section="common">
              <div class="plugin-section-head"><h2>Common</h2></div>
              <div class="plugin-public-grid">
                \${render("translationPresetName")}
                \${render("voice.modelConfigName")}
                \${render("conversion.provider")}
                \${render("currentTranslation.translationEnabled")}
                \${render("enabled")}
                \${render("targetRoute")}
                \${render("persistTranslation")}
              </div>
              <div class="prompt-actions">
                <button type="button" data-plugin-section-save="common">Save Common Settings</button>
              </div>
            </section>
            <div class="prompt-actions">
              <button type="button" id="pluginConfigReload" class="secondary">Reload</button>
              <button type="button" id="pluginConfigLogs" class="secondary">Load Events</button>
            </div>
          </form>
          <h2>Route</h2>
          <pre>\${escapeHtml((payload.routePreview || []).join("\\n"))}</pre>
          <h2>Runtime Access</h2>
          <pre>\${escapeHtml((payload.runtimeAccess || []).join("\\n"))}</pre>
          \${payload.testSchema ? renderPluginTestBox(payload) : ""}
          <h2>Recent Events</h2>
          <div id="pluginEvents" class="logs plugin-events">No events loaded.</div>
        \`;
        bindPluginConfigForm();
        document.querySelectorAll("[data-plugin-preset-toggle]").forEach((button) => {
          button.addEventListener("click", () => {
            const key = button.dataset.pluginPresetToggle;
            const editor = document.querySelector('[data-plugin-preset-editor="' + cssEscape(key) + '"]');
            editor?.classList.toggle("active");
            button.textContent = editor?.classList.contains("active") ? "Hide" : "Modify";
          });
        });
        const translationEditSelect = document.querySelector('[data-plugin-field="translationEditPresetName"]');
        if (translationEditSelect) {
          translationEditSelect.addEventListener("change", () => {
            const preset = (config.translationPresets || {})[translationEditSelect.value] || {};
            setPluginFieldValue("currentTranslation.translationEnabled", preset.translationEnabled ?? true);
            setPluginFieldValue("currentTranslation.apiPresetName", preset.apiPresetName || "");
            setPluginFieldValue("currentTranslation.prompt", preset.prompt || "");
            setPluginFieldValue("newTranslationPresetName", "");
          });
        }
        const modelEditSelect = document.querySelector('[data-plugin-field="voice.modelEditPresetName"]');
        if (modelEditSelect) {
          modelEditSelect.addEventListener("change", () => {
            const preset = ((config.voice || {}).modelConfigs || {})[modelEditSelect.value] || {};
            setPluginFieldValue("voice.currentModel.language", preset.language || "jp");
            setPluginFieldValue("voice.currentModel.speed", preset.speed ?? "");
            setPluginFieldValue("voice.currentModel.splitText", preset.splitText ?? false);
            setPluginFieldValue("voice.currentModel.partSilenceSeconds", preset.partSilenceSeconds ?? "");
            setPluginFieldValue("voice.currentModel.referenceText", "");
            setPluginFieldValue("voice.newModelConfigName", "");
          });
        }
        const conversionProviderSelect = document.querySelector('[data-plugin-field="conversion.provider"]');
        const applyConversionPanel = () => {
          const provider = conversionProviderSelect?.value || "genie";
          document.querySelectorAll("[data-plugin-conversion-panel]").forEach((node) => {
            node.style.display = node.dataset.pluginConversionPanel === provider ? "" : "none";
          });
        };
        conversionProviderSelect?.addEventListener("change", applyConversionPanel);
        applyConversionPanel();
        const bailianServiceSelect = document.querySelector('[data-plugin-field="conversion.bailian.service"]');
        const bailianEndpointInput = document.querySelector('[data-plugin-field="conversion.bailian.endpoint"]');
        const bailianDefaultEndpoints = {
          qwen: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
          cosy: "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
        };
        bailianServiceSelect?.addEventListener("change", () => {
          if (!bailianEndpointInput) return;
          const next = bailianServiceSelect.value === "cosy" ? "cosy" : "qwen";
          const current = bailianEndpointInput.value || "";
          if (!current || current === bailianDefaultEndpoints.qwen || current === bailianDefaultEndpoints.cosy) {
            bailianEndpointInput.value = bailianDefaultEndpoints[next];
          }
        });
      }

      function setPluginFieldValue(field, value) {
        const input = document.querySelector('[data-plugin-field="' + cssEscape(field) + '"]');
        if (!input) return;
        if (input.type === "checkbox") {
          input.checked = Boolean(value);
        } else {
          input.value = value ?? "";
        }
      }

      function bindPluginConfigForm() {
        $("pluginConfigForm").addEventListener("submit", savePluginConfig);
        document.querySelectorAll("[data-plugin-upload]").forEach((input) => input.addEventListener("change", uploadPluginAsset));
        if ($("pluginConfigGroup")) $("pluginConfigGroup").addEventListener("change", applyPluginConfigGroupFilter);
        applyPluginConfigGroupFilter();
        $("pluginConfigReload").addEventListener("click", async () => {
          const pluginId = $("pluginConfigForm").dataset.pluginId;
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/reload", { method: "POST" }).then((res) => res.json());
          $("plugin-status").textContent = result.ok ? pluginId + " reloaded." : "Reload failed: " + (result.error || "unknown error");
          await openPluginConfig(pluginId);
        });
        $("pluginConfigLogs").addEventListener("click", () => loadPluginEvents($("pluginConfigForm").dataset.pluginId));
        document.querySelectorAll("[data-plugin-section-save]").forEach((button) => button.addEventListener("click", savePluginConfigSection));
        if ($("pluginConfigTest")) $("pluginConfigTest").addEventListener("click", () => runPluginTest($("pluginConfigForm").dataset.pluginId));
      }

      function renderPluginConfigGroupSelector(groups) {
        if (!groups.length) return "";
        return \`
          <label for="pluginConfigGroup">Configure
            <select id="pluginConfigGroup">
              \${groups.map((group) => \`<option value="\${escapeAttr(group.key)}">\${escapeHtml(group.label || group.key)}</option>\`).join("")}
            </select>
          </label>
        \`;
      }

      function renderPluginFieldContainer(field, config, apiPresets) {
        return \`<div data-plugin-config-group="\${escapeAttr(field.group || "")}">\${renderPluginField(field, config, apiPresets)}</div>\`;
      }

      function applyPluginConfigGroupFilter() {
        const selector = $("pluginConfigGroup");
        const active = selector ? selector.value : "";
        document.querySelectorAll("[data-plugin-config-group]").forEach((node) => {
          const group = node.dataset.pluginConfigGroup || "";
          node.style.display = !active || !group || group === active ? "" : "none";
        });
      }

      function renderPluginTestBox(payload) {
        const schema = payload.testSchema || { input: "text", label: "Input", buttonLabel: "Test translation and voice" };
        const input = schema.input === "audio"
          ? \`<label>\${escapeHtml(schema.label || "Audio")}<input id="pluginTestAudio" value="\${escapeAttr((payload.configValue && payload.configValue.testAudioPath) || schema.defaultValue || "")}" placeholder="assets/plugin/asr/test-audio/example.wav" /></label>\`
          : \`<label>\${escapeHtml(schema.label || "Input")}<textarea id="pluginTestText" rows="4" spellcheck="false">\${escapeHtml(schema.defaultValue || "")}</textarea></label>\`;
        return \`
          <h2>Test</h2>
          <div class="plugin-test-box" data-plugin-test-input="\${escapeAttr(schema.input || "text")}">
            \${input}
            <button type="button" id="pluginConfigTest" class="secondary">\${escapeHtml(schema.buttonLabel || "Run test")}</button>
            <pre id="pluginTestOutput">No test run yet.</pre>
          </div>
        \`;
      }

      function renderPluginField(field, config, apiPresets) {
        const value = valueAtPath(config, field.key);
        const inputName = escapeAttr(field.key);
        const description = field.description ? \`<p class="muted">\${escapeHtml(field.description)}</p>\` : "";
        if (field.type === "switch") {
          return \`<label class="plugin-switch"><input type="checkbox" name="\${inputName}" data-plugin-field="\${inputName}" \${value ? "checked" : ""} /><span class="plugin-switch-visual" aria-hidden="true"></span> \${escapeHtml(field.label)}</label>\${description}\`;
        }
        if (field.type === "textarea") {
          const textValue = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
          return \`<label>\${escapeHtml(field.label)}<textarea rows="7" spellcheck="false" name="\${inputName}" data-plugin-field="\${inputName}">\${escapeHtml(textValue)}</textarea></label>\${description}\`;
        }
        if (field.type === "number") {
          return \`<label>\${escapeHtml(field.label)}<input type="number" min="\${escapeAttr(field.min ?? "0.5")}" max="\${escapeAttr(field.max ?? "2")}" step="\${escapeAttr(field.step ?? "0.05")}" name="\${inputName}" data-plugin-field="\${inputName}" value="\${escapeAttr(value ?? "")}" /></label>\${description}\`;
        }
        if (field.type === "password") {
          const configured = Boolean(valueAtPath(config, field.key + "Set"));
          const placeholder = configured ? "Configured; leave blank to keep unchanged" : "Leave blank to keep unchanged";
          return \`<label>\${escapeHtml(field.label)}<input type="password" name="\${inputName}" data-plugin-field="\${inputName}" value="" placeholder="\${escapeAttr(placeholder)}" autocomplete="new-password" /></label>\${description}\`;
        }
        if (field.type === "select") {
          const options = field.options || [];
          return \`<label>\${escapeHtml(field.label)}<select name="\${inputName}" data-plugin-field="\${inputName}">\${options.map((option) => \`<option value="\${escapeAttr(option.value)}" \${option.value === value ? "selected" : ""}>\${escapeHtml(option.label || option.value)}</option>\`).join("")}</select></label>\${description}\`;
        }
        if (field.type === "apiPresetSelect") {
          const options = ["", ...apiPresets.map((preset) => preset.name).filter(Boolean)];
          return \`<label>\${escapeHtml(field.label)}<select name="\${inputName}" data-plugin-field="\${inputName}">\${options.map((option) => \`<option value="\${escapeAttr(option)}" \${option === value ? "selected" : ""}>\${escapeHtml(option || "(none)")}</option>\`).join("")}</select></label>\${description}\`;
        }
        if (field.type === "fileUpload" || field.type === "folderUpload") {
          const directoryAttrs = field.type === "folderUpload" ? "webkitdirectory directory multiple" : "";
          return \`<label>\${escapeHtml(field.label)}<input type="file" data-plugin-upload="\${escapeAttr(field.assetKey || field.key)}" data-plugin-field="\${inputName}" accept="\${escapeAttr(field.accept || "")}" \${directoryAttrs} /></label><p class="muted">Current: \${escapeHtml(value || "(none)")}</p>\${description}\`;
        }
        if (field.type === "readonly") {
          const displayValue = typeof value === "boolean" ? (value ? "Yes" : "No") : value ?? field.description ?? "";
          return \`<label>\${escapeHtml(field.label)}<input value="\${escapeAttr(displayValue)}" readonly /></label>\`;
        }
        return \`<label>\${escapeHtml(field.label)}<input name="\${inputName}" data-plugin-field="\${inputName}" value="\${escapeAttr(value || "")}" /></label>\${description}\`;
      }

      async function savePluginConfig(event) {
        event.preventDefault();
        const form = event.currentTarget;
        if (form.dataset.pluginSaveMode === "section") {
          $("plugin-status").textContent = "Use the section save buttons for this plugin.";
          return;
        }
        const pluginId = form.dataset.pluginId;
        $("plugin-status").textContent = "Saving plugin config...";
        try {
          const body = pluginConfigBodyFrom(form);
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          }).then((res) => res.json());
          if (result.ok) {
            await openPluginConfig(pluginId);
            $("plugin-status").textContent = pluginId + " config saved.";
            return;
          }
          $("plugin-status").textContent = "Save failed: " + (result.error || "unknown error");
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          $("plugin-status").textContent = "Save failed: " + message;
        }
      }

      async function savePluginConfigSection(event) {
        const button = event.currentTarget;
        const section = button.closest("[data-plugin-config-section]");
        const form = button.closest("form");
        const pluginId = form.dataset.pluginId;
        const sectionName = button.dataset.pluginSectionSave || "section";
        const body = pluginConfigBodyFrom(section);
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? sectionName + " saved." : "Save failed: " + (result.error || "unknown error");
        if (result.ok) await openPluginConfig(pluginId);
      }

      function pluginConfigBodyFrom(root) {
        const body = {};
        root.querySelectorAll("[data-plugin-field]").forEach((input) => {
          if (input.type === "file") return;
          if (input.readOnly) return;
          if (input.type === "password" && input.value === "") return;
          const value = input.type === "checkbox" ? input.checked : input.type === "number" && input.value !== "" ? Number(input.value) : input.value;
          setValueAtPath(body, input.dataset.pluginField, value);
        });
        return body;
      }

      async function switchPluginModelConfig(event) {
        const input = event.currentTarget;
        const form = input.closest("form");
        const pluginId = form.dataset.pluginId;
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ voice: { modelConfigName: input.value } })
        }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? "Model config switched." : "Switch failed: " + (result.error || "unknown error");
        if (result.ok) await openPluginConfig(pluginId);
      }

      async function switchPluginTranslationPreset(event) {
        const input = event.currentTarget;
        const form = input.closest("form");
        const pluginId = form.dataset.pluginId;
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ translationPresetName: input.value })
        }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? "Translation preset switched." : "Switch failed: " + (result.error || "unknown error");
        if (result.ok) await openPluginConfig(pluginId);
      }

      async function uploadPluginAsset(event) {
        const input = event.currentTarget;
        const files = Array.from(input.files || []);
        if (!files.length) return;
        const pluginId = $("pluginConfigForm").dataset.pluginId;
        const assetKey = input.dataset.pluginUpload;
        const presetName = document.querySelector('[data-plugin-field="voice.modelEditPresetName"]')?.value || document.querySelector('[data-plugin-field="voice.modelConfigName"]')?.value || "";
        for (const file of files) {
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/assets/" + encodeURIComponent(assetKey), {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
              "x-file-name": encodeURIComponent(file.name || "asset"),
              "x-relative-dir": encodeURIComponent(file.webkitRelativePath ? file.webkitRelativePath.split("/").slice(0, -1).join("/") : ""),
              "x-preset-name": encodeURIComponent(presetName)
            },
            body: file
          }).then((res) => res.json());
          if (!result.ok) {
            $("plugin-status").textContent = "Upload failed: " + (result.error || "unknown error");
            return;
          }
        }
        $("plugin-status").textContent = "Asset uploaded.";
        await openPluginConfig(pluginId);
      }

      async function loadPluginEvents(pluginId) {
        const payload = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/events").then((res) => res.json());
        if (!$("pluginEvents")) return;
        $("pluginEvents").innerHTML = (payload.events || []).length
          ? payload.events.map((entry) => \`<div class="log-line log-\${escapeAttr(entry.level || "info")}">[\${escapeHtml(entry.time || "")}] [\${escapeHtml(entry.level || "info")}] \${escapeHtml(entry.message || "")}</div>\`).join("")
          : "No plugin events yet.";
      }

      async function runPluginTest(pluginId) {
        $("pluginTestOutput").textContent = "Running...";
        const box = document.querySelector(".plugin-test-box");
        const body = box && box.dataset.pluginTestInput === "audio"
          ? { audioFile: $("pluginTestAudio").value }
          : { text: $("pluginTestText").value };
        const payload = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then((res) => res.json());
        if (!payload.ok) {
          $("pluginTestOutput").textContent = "Test failed: " + (payload.error || "unknown error");
          return;
        }
        const result = payload.result || {};
        $("pluginTestOutput").innerHTML = \`
Input:
\${escapeHtml(result.input || "")}

Output:
\${escapeHtml(result.output || "")}

\${result.provider ? "Transcription:\\nProvider: " + escapeHtml(result.provider) + (result.model ? "\\nModel: " + escapeHtml(result.model) : "") + "\\n" : ""}

Voice:
\${result.voice && result.voice.audioUrl ? \`<audio controls src="\${escapeAttr(result.voice.audioUrl)}"></audio>\` : "No audio"}
\${result.voice && result.voice.assetId ? "\\nAsset: " + escapeHtml(result.voice.assetId) : ""}

Timing:
\${escapeHtml(JSON.stringify(result.timing || {}, null, 2))}
\`;
      }

      const deepSeekPricesCnyPer1M = ${JSON.stringify(deepSeekPricesCnyPer1M)};

      function renderTokenUsage(payload) {
        const summary = payload.summary || {};
        $("tokenUsageMetrics").innerHTML = [
          renderUsageMetric("Cache Hit Rate", formatPercent(summary.cacheHitRate)),
          renderUsageMetric("Total Tokens", formatNumber(summary.totalTokens)),
          renderUsageMetric("Cost (CNY)", formatCny(actualCnyCost(payload))),
          renderUsageMetric("Cache Hit", formatNumber(summary.cacheHitTokens)),
          renderUsageMetric("Cache Miss", formatNumber(summary.cacheMissTokens)),
          renderUsageMetric("Output", formatNumber(summary.outputTokens))
        ].join("");
        renderTokenUsageModelOptions(payload.byModel || [], payload.model || "all");
        $("tokenUsageChart").innerHTML = renderTokenUsageChart(payload.buckets || []);
        $("tokenUsageModels").innerHTML = renderTokenUsageModels(payload.byModel || []);
        $("tokenUsageLatest").innerHTML = renderTokenUsageLatest(payload.latest || []);
      }

      function renderTokenUsageMetricRows(rows) {
        return rows.map((row) => \`
          <tr>
            <td>\${escapeHtml(row.model || row.createdAt || "")}</td>
            <td>\${escapeHtml(row.agentId || "")}</td>
            <td>\${formatNumber(row.requests || row.totalTokens)}</td>
            <td>\${formatNumber(row.cacheHitTokens)}</td>
            <td>\${formatNumber(row.cacheMissTokens)}</td>
            <td>\${formatPercent(row.cacheHitRate)}</td>
          </tr>
        \`).join("");
      }

      function renderUsageMetric(label, value) {
        return \`<div class="usage-metric"><span class="muted">\${escapeHtml(label)}</span><strong>\${escapeHtml(value)}</strong></div>\`;
      }

      function renderTokenUsageChart(buckets) {
        if (!buckets.length) return "No token usage recorded for this range.";
        const requestTotal = buckets.reduce((sum, bucket) => sum + Number(bucket.requests || 0), 0);
        const tokenTotal = buckets.reduce((sum, bucket) => sum + Number(bucket.totalTokens || 0), 0);
        return \`
          <div class="usage-model-panel">
            <div class="usage-model-charts">
              <div>
                <p class="usage-mini-title">API Requests <span class="usage-model-stat">\${formatNumber(requestTotal)}</span></p>
                \${renderRequestLineChart(buckets)}
              </div>
              <div>
                <p class="usage-mini-title">Tokens <span class="usage-model-stat">\${formatNumber(tokenTotal)}</span></p>
                \${renderTokenBars(buckets)}
              </div>
            </div>
            <div class="usage-legend">
              <span><span class="usage-swatch usage-output"></span>output</span>
              <span><span class="usage-swatch usage-miss"></span>cache miss</span>
              <span><span class="usage-swatch usage-hit"></span>cache hit</span>
            </div>
          </div>
        \`;
      }

      function renderRequestLineChart(buckets) {
        const maxRequests = Math.max(1, ...buckets.map((bucket) => Number(bucket.requests || 0)));
        const width = Math.max(320, buckets.length * 28);
        const height = 140;
        const points = buckets.map((bucket, index) => {
          const x = buckets.length === 1 ? width / 2 : (index / (buckets.length - 1)) * width;
          const y = height - (Number(bucket.requests || 0) / maxRequests) * (height - 10);
          return { x, y, bucket };
        });
        const path = points.map((point, index) => \`\${index === 0 ? "M" : "L"} \${point.x.toFixed(2)} \${point.y.toFixed(2)}\`).join(" ");
        const area = \`\${path} L \${points.at(-1)?.x.toFixed(2) || 0} \${height} L \${points[0]?.x.toFixed(2) || 0} \${height} Z\`;
        return \`
          <div class="usage-line-chart">
            <svg viewBox="0 0 \${width} \${height}" preserveAspectRatio="none">
              <path d="\${escapeAttr(area)}" fill="rgba(22, 119, 255, 0.42)"></path>
              <path d="\${escapeAttr(path)}" fill="none" stroke="#1677ff" stroke-width="3"></path>
              \${points.map((point) => \`<circle cx="\${point.x.toFixed(2)}" cy="\${point.y.toFixed(2)}" r="3" fill="#1677ff"><title>\${escapeHtml(point.bucket.bucket + " requests=" + point.bucket.requests)}</title></circle>\`).join("")}
            </svg>
          </div>
          <div class="usage-axis-row"><span>\${escapeHtml(shortBucketLabel(buckets[0]?.bucket))}</span><span>\${escapeHtml(shortBucketLabel(buckets.at(-1)?.bucket))}</span></div>
        \`;
      }

      function renderTokenBars(buckets) {
        const maxValue = Math.max(1, ...buckets.map((bucket) => Number(bucket.cacheHitTokens || 0) + Number(bucket.cacheMissTokens || 0) + Number(bucket.outputTokens || 0)));
        const bars = buckets.map((bucket) => {
          const hit = Number(bucket.cacheHitTokens || 0);
          const miss = Number(bucket.cacheMissTokens || 0);
          const output = Number(bucket.outputTokens || 0);
          const total = Math.max(1, hit + miss + output);
          const height = Math.max(2, Math.round((total / maxValue) * 140));
          return \`
            <div class="usage-bar-wrap" title="\${escapeAttr(bucket.bucket + " hit=" + hit + " miss=" + miss + " output=" + output + " rate=" + formatPercent(bucket.cacheHitRate))}">
              <div class="usage-bar" style="height:\${height}px">
                <div class="usage-output" style="height:\${Math.round((output / total) * 100)}%"></div>
                <div class="usage-miss" style="height:\${Math.round((miss / total) * 100)}%"></div>
                <div class="usage-hit" style="height:\${Math.round((hit / total) * 100)}%"></div>
              </div>
            </div>
          \`;
        }).join("");
        return \`
          <div class="usage-token-bars">\${bars}</div>
          <div class="usage-axis-row"><span>\${escapeHtml(shortBucketLabel(buckets[0]?.bucket))}</span><span>\${escapeHtml(shortBucketLabel(buckets.at(-1)?.bucket))}</span></div>
        \`;
      }

      function renderTokenUsageModels(rows) {
        if (!rows.length) return "";
        return \`
          <h2>By Model</h2>
          <table class="usage-table">
            <thead><tr><th>Model</th><th>Agent</th><th>Total</th><th>Hit</th><th>Miss</th><th>Hit Rate</th></tr></thead>
            <tbody>\${renderTokenUsageMetricRows(rows.map((row) => ({ ...row, agentId: "all" })))}</tbody>
          </table>
        \`;
      }

      function renderTokenUsageLatest(rows) {
        if (!rows.length) return "";
        return \`
          <h2>Latest Events</h2>
          <table class="usage-table">
            <thead><tr><th>Time</th><th>Agent</th><th>Total</th><th>Hit</th><th>Miss</th><th>Hit Rate</th></tr></thead>
            <tbody>\${renderTokenUsageMetricRows(rows.map((row) => ({ ...row, model: row.createdAt })))}</tbody>
          </table>
        \`;
      }

      function renderTokenUsageModelOptions(rows, selected) {
        const models = ["all", ...rows.map((row) => row.model).filter(Boolean).filter((value, index, list) => list.indexOf(value) === index)];
        $("tokenUsageModel").innerHTML = models.map((model) => \`<option value="\${escapeAttr(model)}" \${model === selected ? "selected" : ""}>\${escapeHtml(model)}</option>\`).join("");
      }

      function shortBucketLabel(value) {
        return String(value || "").replace(/^\\d{4}-/, "").replace("T", " ");
      }

      function formatNumber(value) {
        return Number(value || 0).toLocaleString("en-US");
      }

      function actualCnyCost(payload) {
        const rows = Array.isArray(payload.byModel) && payload.byModel.length
          ? payload.byModel
          : [{ ...(payload.summary || {}), model: payload.model || $("model").value || "deepseek-chat" }];
        return rows.reduce((sum, row) => {
          const price = deepSeekPriceForModel(row.model || "");
          return sum
            + Number(row.cacheHitTokens || 0) * price.hit / 1_000_000
            + Number(row.cacheMissTokens || 0) * price.miss / 1_000_000
            + Number(row.outputTokens || 0) * price.output / 1_000_000;
        }, 0);
      }

      function deepSeekPriceForModel(model) {
        return deepSeekPricesCnyPer1M.find((price) => new RegExp(price.pattern, "i").test(String(model || ""))) || deepSeekPricesCnyPer1M.at(-1);
      }

      function formatCny(value) {
        const digits = value > 0 && value < 1 ? 6 : 2;
        return "¥" + Number(value || 0).toLocaleString("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits
        });
      }

      function formatPercent(value) {
        return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 10 + "%" : "unknown";
      }

      function renderActiveLLMSession(session) {
        return \`<div class="log-line">Active session #\${escapeHtml(session.id || "")} mode=\${escapeHtml(session.mode || "normal")} started=\${escapeHtml(session.startedAt || "")} updated=\${escapeHtml(session.updatedAt || "")} rounds=\${escapeHtml(session.roundCount ?? session.requestCount ?? 0)} messages=\${escapeHtml(session.messageCount ?? 0)}</div>\`;
      }

      function renderActiveSessionTerminalRows(session) {
        if (!session) return '<div class="log-line">Active session: none</div>';
        if (isActiveSessionWaiting(session)) return '<div class="log-line">waiting</div>';
        const latest = latestActiveSessionMessage(session);
        return \`<div class="log-line">[\${escapeHtml(latest.role)}] \${escapeHtml(latest.summary)}</div>\`;
      }

      function isActiveSessionWaiting(session) {
        if (session.currentRound && session.currentRound.status === "running") return true;
        const requestRound = typeof session.latestRequest?.round === "number" ? session.latestRequest.round : undefined;
        const responseRound = typeof session.latestResponse?.round === "number" ? session.latestResponse.round : undefined;
        return typeof requestRound === "number" && (typeof responseRound !== "number" || requestRound > responseRound);
      }

      function latestActiveSessionMessage(session) {
        if (session.latestMessage) {
          return {
            role: session.latestMessage.role || "unknown",
            summary: summarizeLLMMessageForRow(session.latestMessage)
          };
        }
        const messages = Array.isArray(session.messages) ? session.messages : [];
        const latest = messages[messages.length - 1];
        if (!latest) return { role: "none", summary: "No messages in active session." };
        return {
          role: latest.role || "unknown",
          summary: summarizeLLMMessageForRow(latest)
        };
      }

      function summarizeLLMMessageForRow(message) {
        if (typeof message.content === "string" && message.content.trim()) return compactLogText(message.content);
        if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
          return "tool_calls: " + message.toolCalls.map((call) => call.function?.name || call.name || call.id || "unknown").join(", ");
        }
        if (message.reasoningContent) return compactLogText(message.reasoningContent);
        return JSON.stringify(message);
      }

      function compactLogText(value) {
        const text = String(value || "").replace(/\\s+/g, " ").trim();
        return text.length > 240 ? text.slice(0, 237) + "..." : text;
      }

      function renderLLMSessionGroups(activeSession, clearedSessions, memorySessions, talkActiveSession, talkSessions) {
        const active = activeSession ? renderActiveLLMSession(activeSession) : '<div class="log-line">Active session: none</div>';
        const activeGroup = activeSession
          ? renderLLMSessionShell(activeSession, "Active Session")
          : "";
        const archived = sortedLLMSessions(clearedSessions).map((session) => renderLLMSessionShell(session, "Chat Saved Session")).join("");
        const talkActive = talkActiveSession ? renderActiveLLMSession(talkActiveSession) : '<div class="log-line">Talk active session: none</div>';
        const talkActiveGroup = talkActiveSession
          ? renderLLMSessionShell(talkActiveSession, "Talk Active Session")
          : "";
        const talk = sortedLLMSessions(talkSessions).map((session) => renderLLMSessionShell(session, "Talk Saved Session")).join("");
        const memory = sortedLLMSessions(memorySessions).map((session) => renderLLMSessionShell(session, "Memorize")).join("");
        return [
          '<h2>Chat</h2>',
          archived || '<div class="log-line">Chat saved sessions: none</div>',
          active,
          activeGroup,
          '<h2>Talk</h2>',
          talk || '<div class="log-line">Talk saved sessions: none</div>',
          talkActive,
          talkActiveGroup,
          '<h2>Memorize</h2>',
          memory || '<div class="log-line">Memorize sessions: none</div>'
        ].join("");
      }

      function sortedLLMSessions(sessions) {
        return [...(sessions || [])].sort((left, right) => String(left.startedAt || "").localeCompare(String(right.startedAt || "")) || String(left.id || "").localeCompare(String(right.id || "")));
      }

      function renderLLMSessionShell(session, title) {
        const reason = session.reason ? \` · reason=\${escapeHtml(session.reason)}\` : "";
        const counts = \`\${escapeHtml(session.roundCount ?? session.requestCount ?? 0)} round(s) · \${escapeHtml(session.messageCount ?? 0)} message(s)\`;
        return \`<details class="log-line llm-session-detail" data-session-id="\${escapeAttr(session.id || "")}"><summary>\${escapeHtml(title)} \${escapeHtml(session.id || "")} · \${counts} · mode=\${escapeHtml(session.mode || "normal")} · \${escapeHtml(session.startedAt || "")}\${reason}</summary><div class="llm-session-body">Expand to load.</div></details>\`;
      }

      function bindLLMSessionDetails(containerId) {
        document.querySelectorAll(\`#\${containerId} details.llm-session-detail\`).forEach((detail) => {
          detail.addEventListener("toggle", async () => {
            if (!detail.open || detail.dataset.loaded === "true") return;
            const body = detail.querySelector(".llm-session-body");
            body.textContent = "Loading...";
            const payload = await fetch(\`/admin/api/llm-chain/session?id=\${encodeURIComponent(detail.dataset.sessionId || "")}\`).then((res) => res.json());
            const session = payload.session;
            if (!session) {
              body.textContent = "Session not found.";
              detail.dataset.loaded = "true";
              return;
            }
            body.innerHTML = renderLLMSession(session);
            detail.dataset.loaded = "true";
          });
        });
      }

      function renderLLMSession(session) {
        const entries = Array.isArray(session.jsonlEntries) && session.jsonlEntries.length
          ? session.jsonlEntries
          : [fallbackLLMSessionMetadata(session), ...(Array.isArray(session.messages) ? session.messages : [])];
        return entries.map((entry, index) => renderLLMSessionJsonlEntry(entry, index)).join("");
      }

      function fallbackLLMSessionMetadata(session) {
        return {
          id: session.id,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt,
          mode: session.mode,
          modeStartedAt: session.modeStartedAt,
          modeExpiresAt: session.modeExpiresAt,
          fixedPrefixKind: session.fixedPrefixKind,
          fixedPrefixCursorMessageId: session.fixedPrefixCursorMessageId,
          currentRound: session.currentRound,
          latestRequest: session.latestRequest,
          latestResponse: session.latestResponse,
          clearedAt: session.clearedAt,
          reason: session.reason,
          archiveFilePath: session.archiveFilePath,
          messageCount: Array.isArray(session.messages) ? session.messages.length : session.messageCount
        };
      }

      function renderLLMSessionJsonlEntry(entry, index) {
        const isMeta = index === 0;
        const label = isMeta ? "[meta]" : "[message" + index + "]";
        const role = !isMeta && entry && typeof entry === "object" && entry.role ? " " + entry.role : "";
        const name = !isMeta && entry && typeof entry === "object" && entry.name ? " name=" + entry.name : "";
        return \`
          <details class="log-line">
            <summary>\${escapeHtml(label + role + name)}</summary>
            <pre>\${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
          </details>
        \`;
      }

      function renderLLMTranscript(messages) {
        const parsed = renderParsedLLMMessages(messages);
        return parsed || '<div class="log-line">No messages archived.</div>';
      }

      function renderParsedLLMMessages(messages) {
        const list = Array.isArray(messages) ? messages : [];
        if (!list.length) return "";
        const unresolved = unresolvedPromptVariables(list);
        return [
          unresolved.length ? '<div class="log-line log-warn">unresolved variables\\n' + escapeHtml(unresolved.join("\\n")) + '</div>' : "",
          ...list.map((message, index) => renderParsedLLMMessage(message, index))
        ].join("");
      }

      function renderParsedLLMMessage(message, index) {
        const header = [
          "#" + (index + 1),
          "[" + (message.role || "unknown") + "]",
          message.name ? "name=" + message.name : "",
          message.toolCallId ? "tool_call_id=" + message.toolCallId : ""
        ].filter(Boolean).join(" ");
        const parts = [
          '<strong>' + escapeHtml(header) + '</strong>',
          message.content ? '<div>content</div><pre>' + escapeHtml(message.content) + '</pre>' : "",
          message.reasoningContent ? '<div>reasoning_content</div><pre>' + escapeHtml(message.reasoningContent) + '</pre>' : "",
          Array.isArray(message.toolCalls) && message.toolCalls.length
            ? '<div>tool_calls</div><pre>' + escapeHtml(JSON.stringify(message.toolCalls, null, 2)) + '</pre>'
            : ""
        ].filter(Boolean).join("\\n");
        return '<details class="log-line" open><summary>' + escapeHtml(header) + '</summary>' + parts + '</details>';
      }

      function unresolvedPromptVariables(value) {
        const text = JSON.stringify(value || "");
        const found = text.match(/\\{\\{\\s*[a-zA-Z0-9_/]+\\s*\\}\\}/g) || [];
        return [...new Set(found)].sort();
      }

      function renderLLMRequestBlock(title, current) {
        if (!current) return "";
        const raw = current.rawRequest || {
          model: current.model,
          temperature: current.temperature,
          messages: current.messages,
          tools: current.tools
        };
        return \`
          <div class="log-line">== \${escapeHtml(title)} ==</div>
          <div class="log-line">[\${escapeHtml(current.time || "")}] source=\${escapeHtml(current.source || "actual")} model=\${escapeHtml(current.model || "")} temperature=\${escapeHtml(current.temperature ?? "")}\${current.conversationId ? " conversation=" + escapeHtml(current.conversationId) : ""}</div>
          \${current.tools && current.tools.length ? \`<div class="log-line">tools\\n\${escapeHtml(current.tools.map((tool) => tool.function.name).join(", "))}</div>\` : ""}
          <div class="log-line">parsed messages</div>
          \${renderParsedLLMMessages(current.messages || [])}
          <div class="log-line">raw json\\n\${escapeHtml(JSON.stringify(raw, null, 2))}</div>
        \`;
      }

      async function refreshAgentState() {
        const payload = await fetch("/admin/api/agent-state").then((res) => res.json());
        const state = payload.state || {};
        const states = payload.states || [];
        $("agentStateSelect").innerHTML = states.map((item) => \`<option value="\${escapeAttr(item)}" \${state.state === item ? "selected" : ""}>\${escapeHtml(item)}</option>\`).join("");
        $("agentIntimacy").value = String(state.intimacy ?? 50);
        $("agentStateSnapshot").textContent = JSON.stringify(state, null, 2);
      }

      async function refreshRuntimeStatus() {
        const payload = await fetch("/admin/api/runtime/status").then((res) => res.json());
        $("runtimeStatus").textContent = JSON.stringify(payload, null, 2);
      }

      let promptProfile = null;
      let talkPromptProfile = null;
      let promptVariables = {};
      let talkPromptVariables = {};
      let promptTools = [];
      let promptEditorMode = "chat";
      let promptSideView = "preview";
      let memoryPrompts = null;
      let lastMemoryPromptPreviewTarget = "persistent";
      let memorySleepDays = [];
      let memoryCalendarMonth = "";
      let toolPreviewTools = [];
      let llmApiPresets = [];
      let currentLLMApiPreset = null;
      let promptApiProfile = {};
      async function refreshPromptProfile() {
        const payload = await fetch("/admin/api/prompt-profile").then((res) => res.json());
        promptProfile = payload.profile;
        promptVariables = payload.variables || {};
        promptTools = payload.tools || [];
        const talkPayload = await fetch("/admin/api/talk-prompt-profile").then((res) => res.json());
        talkPromptProfile = talkPayload.profile;
        talkPromptVariables = talkPayload.variables || {};
        const memoryPayload = await fetch("/admin/api/memory/prompts").then((res) => res.json());
        memoryPrompts = memoryPayload.prompts || {};
        promptApiProfile = memoryPayload.apiProfile || promptApiProfile || {};
        if (memoryPayload.apiPresets) {
          llmApiPresets = memoryPayload.apiPresets;
          renderLLMApiPresetControls();
        }
        renderPromptProfile();
      }

      function renderPromptProfile() {
        if (!promptProfile || !talkPromptProfile || !memoryPrompts) return;
        if (promptEditorMode === "memory") {
          renderMemoryPromptEditor();
          return;
        }
        const activeProfile = promptEditorMode === "talk" ? talkPromptProfile : promptProfile;
        const isTalk = promptEditorMode === "talk";
        const layers = [...activeProfile.layers].sort((a, b) => a.order - b.order);
        if (!Array.isArray(activeProfile.appendLayers)) activeProfile.appendLayers = [];
        const appendLayers = [...activeProfile.appendLayers].sort((a, b) => a.order - b.order);
        $("promptProfile").innerHTML = \`
          <div class="prompt-editor-grid">
            <div class="subtabs prompt-mode-cell">
              <button class="tab \${!isTalk ? "active" : ""}" id="prompt-mode-chat" type="button">Chat</button>
              <button class="tab \${isTalk ? "active" : ""}" id="prompt-mode-talk" type="button">Talk</button>
              <button class="tab" id="prompt-mode-memory" type="button">Memorize</button>
            </div>
            <div class="prompt-api-cell">\${renderPromptApiPresetPicker(isTalk ? "talk" : "chat")}</div>
            <div class="prompt-edit-cell">
              <h2>\${isTalk ? "Talk Prompt Profile" : "Prompt Profile"}</h2>
              <label for="promptUserName">User Name</label>
              <input id="promptUserName" autocomplete="off" value="\${escapeAttr(activeProfile.userName || "user")}" />
              <h2>Visible Tools</h2>
              <label><input id="toolFeishuVisible" type="checkbox" \${activeProfile.visibleTools?.feishu === false ? "" : "checked"} /> tool: chat</label>
              <label><input id="toolPhotoVisible" type="checkbox" \${activeProfile.visibleTools?.photo === false || activeProfile.visibleTools?.media === false ? "" : "checked"} /> tool: photo</label>
              <label><input id="toolShellVisible" type="checkbox" \${activeProfile.visibleTools?.shell === false ? "" : "checked"} /> tool: shell</label>
              <p class="muted">check_chat · send_chat · wardrobe · selfie</p>
              <h2>Initial Layers</h2>
              <div id="promptLayers">\${layers.map((layer, index) => renderPromptLayer(layer, index, layers.length, "layers")).join("")}</div>
              <button type="button" id="prompt-add">Add Initial Layer</button>
              <h2>Append Layers</h2>
              <p class="muted">Append layers are rendered and appended before each heartbeat LLM request. Tool request layers run immediately and include their tool result.</p>
              <div id="promptAppendLayers">\${appendLayers.map((layer, index) => renderPromptLayer(layer, index, appendLayers.length, "appendLayers")).join("")}</div>
              <button type="button" id="prompt-append-add">Add Append Layer</button>
              <button type="button" id="prompt-save">Save Prompt Profile</button>
            </div>
            \${renderPromptSidePane(isTalk ? "talk" : "chat", isTalk ? "Talk Preview" : "Chat Preview", "Save Prompt Profile to refresh preview.")}
          </div>
        \`;
        $("prompt-mode-chat").addEventListener("click", () => { promptEditorMode = "chat"; renderPromptProfile(); });
        $("prompt-mode-talk").addEventListener("click", () => { promptEditorMode = "talk"; renderPromptProfile(); });
        $("prompt-mode-memory").addEventListener("click", () => { promptEditorMode = "memory"; renderPromptProfile(); });
        bindPromptSideToggle(isTalk ? "talk" : "chat");
        bindPromptApiPresetPicker(isTalk ? "talk" : "chat");
        $("promptUserName").addEventListener("input", () => { activeProfile.userName = $("promptUserName").value; });
        $("toolFeishuVisible").addEventListener("change", () => { activeProfile.visibleTools.feishu = $("toolFeishuVisible").checked; });
        $("toolPhotoVisible").addEventListener("change", () => { activeProfile.visibleTools.photo = $("toolPhotoVisible").checked; delete activeProfile.visibleTools.media; });
        $("toolShellVisible").addEventListener("change", () => { activeProfile.visibleTools.shell = $("toolShellVisible").checked; });
        layers.forEach((layer, index) => bindPromptLayer(layer, index, "layers"));
        appendLayers.forEach((layer, index) => bindPromptLayer(layer, index, "appendLayers"));
        $("prompt-add").addEventListener("click", () => {
          const order = Math.max(0, ...activeProfile.layers.map((layer) => Number(layer.order) || 0)) + 10;
          activeProfile.layers.push({ id: "layer_" + Date.now(), title: "New Layer", role: "user", enabled: true, content: "", order });
          renderPromptProfile();
        });
        $("prompt-append-add").addEventListener("click", () => {
          const order = Math.max(0, ...activeProfile.appendLayers.map((layer) => Number(layer.order) || 0)) + 10;
          activeProfile.appendLayers.push({ id: "append_layer_" + Date.now(), title: "New Append Layer", role: "tool_request", enabled: true, content: "", order, toolName: "check_chat", toolArguments: "{}" });
          renderPromptProfile();
        });
        $("prompt-save").addEventListener("click", savePromptProfile);
      }

      function renderPromptSidePane(mode, previewTitle, placeholder) {
        return \`
          <div class="prompt-preview-pane">
            <div class="prompt-preview-head">
              <h2 id="promptSideTitle">\${promptSideView === "variables" ? "变量解析树" : escapeHtml(previewTitle)}</h2>
              <button type="button" id="promptSideToggle" class="secondary">\${promptSideView === "variables" ? "预览" : "变量解析树"}</button>
            </div>
            \${renderPromptSideContent(mode, placeholder)}
          </div>
        \`;
      }

      function renderPromptSideContent(mode, placeholder) {
        const elementId = mode === "memory" ? "memoryPromptPreview" : mode === "talk" ? "talkPromptPreview" : "chatPromptPreview";
        if (promptSideView === "variables") {
          const variables = mode === "talk" ? talkPromptVariables : promptVariables;
          return \`<pre id="\${elementId}">\${escapeHtml(JSON.stringify(variables, null, 2))}</pre>\`;
        }
        return \`<div id="\${elementId}" class="logs">\${escapeHtml(placeholder)}</div>\`;
      }

      function bindPromptSideToggle(mode) {
        $("promptSideToggle")?.addEventListener("click", async () => {
          promptSideView = promptSideView === "variables" ? "preview" : "variables";
          renderPromptProfile();
          if (promptSideView !== "preview") return;
          if (mode === "memory") await refreshMemoryPromptPreview(lastMemoryPromptPreviewTarget);
          else await refreshChatPromptPreview(mode);
        });
      }

      function renderMemoryPromptEditor() {
        const groups = [
          ["commonLayers", "共同组", "persistent"]
        ];
        $("promptProfile").innerHTML = \`
          <div class="prompt-editor-grid">
            <div class="subtabs prompt-mode-cell">
              <button class="tab" id="prompt-mode-chat" type="button">Chat</button>
              <button class="tab" id="prompt-mode-talk" type="button">Talk</button>
              <button class="tab active" id="prompt-mode-memory" type="button">Memorize</button>
            </div>
            <div class="prompt-api-cell">\${renderPromptApiPresetPicker("memorize")}</div>
            <div class="prompt-edit-cell">
              \${groups.map(([key, title, target]) => \`
                <h2>\${escapeHtml(title)}</h2>
                <div id="memory-\${escapeAttr(key)}">\${[...(memoryPrompts[key] || [])].sort((a, b) => a.order - b.order).map((layer, index, list) => renderMemoryPromptLayer(layer, index, list.length, key)).join("")}</div>
                <button type="button" data-memory-layer-add="\${escapeAttr(key)}">Add Layer</button>
                <button type="button" data-memory-group-save="\${escapeAttr(key)}" data-memory-preview-target="\${escapeAttr(target)}">Save \${escapeHtml(title)}</button>
              \`).join("")}
            </div>
            \${renderPromptSidePane("memory", "Prompt Preview", "Save a Memorize group to refresh its preview.")}
          </div>
        \`;
        $("prompt-mode-chat").addEventListener("click", () => { promptEditorMode = "chat"; renderPromptProfile(); });
        $("prompt-mode-talk").addEventListener("click", () => { promptEditorMode = "talk"; renderPromptProfile(); });
        $("prompt-mode-memory").addEventListener("click", () => { promptEditorMode = "memory"; renderPromptProfile(); });
        bindPromptSideToggle("memory");
        bindPromptApiPresetPicker("memorize");
        groups.forEach(([key]) => (memoryPrompts[key] || []).forEach((layer, index) => bindMemoryPromptLayer(layer, index, key)));
        document.querySelectorAll("[data-memory-layer-add]").forEach((button) => button.addEventListener("click", () => {
          const key = button.dataset.memoryLayerAdd;
          if (!Array.isArray(memoryPrompts[key])) memoryPrompts[key] = [];
          const order = Math.max(0, ...memoryPrompts[key].map((layer) => Number(layer.order) || 0)) + 10;
          memoryPrompts[key].push({ id: key + "_" + Date.now(), title: "New Layer", role: "user", enabled: true, order, content: "" });
          renderPromptProfile();
        }));
        document.querySelectorAll("[data-memory-group-save]").forEach((button) => button.addEventListener("click", () => {
          saveMemoryPromptGroup(button.dataset.memoryGroupSave, button.dataset.memoryPreviewTarget || "persistent");
        }));
      }

      function renderPromptApiPresetPicker(mode) {
        const isMemorize = mode === "memorize";
        const isTalk = mode === "talk";
        const selected = isMemorize ? promptApiProfile.memorizePresetName : isTalk ? promptApiProfile.talkPresetName : (promptApiProfile.chatPresetName || promptApiProfile.corePresetName);
        const label = isMemorize ? "Memorize API Preset" : isTalk ? "Talk API Preset" : "Chat API Preset";
        const buttonLabel = isMemorize ? "Save Memorize API Binding" : isTalk ? "Save Talk API Binding" : "Save Chat API Binding";
        return \`
          <div class="row">
            <div>
              <label for="promptApiPresetSelect">\${escapeHtml(label)}</label>
              <select id="promptApiPresetSelect" data-prompt-api-mode="\${escapeAttr(mode)}">\${renderLLMApiPresetOptions(selected || "")}</select>
            </div>
            <div>
              <button type="button" id="prompt-api-profile-save" data-prompt-api-mode="\${escapeAttr(mode)}">\${escapeHtml(buttonLabel)}</button>
            </div>
          </div>
        \`;
      }

      function bindPromptApiPresetPicker(mode) {
        $("prompt-api-profile-save")?.addEventListener("click", () => savePromptApiProfile(mode));
      }

      function renderMemoryPromptLayer(layer, index, count, group) {
        const role = layer.role || "system";
        const isToolRequest = role === "tool_request";
        const canThink = role === "assistant" || isToolRequest;
        return \`
          <details class="prompt-layer" data-memory-layer-group="\${escapeAttr(group)}" data-memory-layer-id="\${escapeAttr(layer.id)}" open>
            <summary>\${escapeHtml(layer.title || "Untitled Layer")}<span>[\${escapeHtml(role)}]\${layer.enabled ? "" : " disabled"}</span></summary>
            <div class="row">
              <div>
                <label>Title</label>
                <input data-field="title" value="\${escapeAttr(layer.title || "")}" />
              </div>
              <div>
                <label>Role</label>
                <select data-field="role">
                  \${["system", "user", "assistant", "tool_request"].map((item) => \`<option value="\${item}" \${role === item ? "selected" : ""}>\${item}</option>\`).join("")}
                </select>
              </div>
              \${isToolRequest ? \`
              <div>
                <label>Tool</label>
                <select data-field="toolName">
                  \${["Read", "self_talk"].map((item) => \`<option value="\${item}" \${(layer.toolName || "Read") === item ? "selected" : ""}>\${item}</option>\`).join("")}
                </select>
              </div>
              \` : ""}
              <label><input data-field="enabled" type="checkbox" \${layer.enabled ? "checked" : ""} /> Enabled</label>
            </div>
            \${canThink ? \`
            <label>Thinking / Fake Reasoning</label>
            <textarea data-field="thinking" rows="3">\${escapeHtml(layer.thinking || "")}</textarea>
            \` : ""}
            \${isToolRequest ? \`
            <label>Tool Arguments</label>
            <textarea data-field="toolArguments" rows="3">\${escapeHtml(layer.toolArguments || "{}")}</textarea>
            \` : ""}
            <label>Content</label>
            <textarea data-field="content" rows="7">\${escapeHtml(layer.content || "")}</textarea>
            <div class="prompt-actions">
              <button type="button" data-action="up" \${index === 0 ? "disabled" : ""}>Up</button>
              <button type="button" data-action="down" \${index === count - 1 ? "disabled" : ""}>Down</button>
              <button type="button" data-action="delete" class="secondary">Delete</button>
            </div>
          </details>
        \`;
      }

      function bindMemoryPromptLayer(layer, index, group) {
        const root = document.querySelector('[data-memory-layer-group="' + cssEscape(group) + '"][data-memory-layer-id="' + cssEscape(layer.id) + '"]');
        if (!root) return;
        root.querySelector('[data-field="title"]').addEventListener("input", (event) => { layer.title = event.target.value; });
        root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
          layer.role = event.target.value;
          if (layer.role === "tool_request") {
            layer.toolName = "Read";
            if (!layer.toolArguments) layer.toolArguments = "{\\"file_path\\":\\"{{memorize/target/fileName}}\\"}";
          } else {
            delete layer.toolName;
            delete layer.toolCallId;
            delete layer.toolArguments;
          }
          if (layer.role !== "assistant" && layer.role !== "tool_request") delete layer.thinking;
          renderPromptProfile();
        });
        root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => { layer.enabled = event.target.checked; });
        root.querySelector('[data-field="content"]').addEventListener("input", (event) => { layer.content = event.target.value; });
        root.querySelector('[data-field="thinking"]')?.addEventListener("input", (event) => { layer.thinking = event.target.value; });
        root.querySelector('[data-field="toolName"]')?.addEventListener("change", (event) => { layer.toolName = event.target.value; });
        root.querySelector('[data-field="toolArguments"]')?.addEventListener("input", (event) => { layer.toolArguments = event.target.value; });
        root.querySelector('[data-action="delete"]').addEventListener("click", () => {
          memoryPrompts[group] = memoryPrompts[group].filter((item) => item.id !== layer.id);
          renderPromptProfile();
        });
        root.querySelector('[data-action="up"]').addEventListener("click", () => moveMemoryPromptLayer(index, -1, group));
        root.querySelector('[data-action="down"]').addEventListener("click", () => moveMemoryPromptLayer(index, 1, group));
      }

      function moveMemoryPromptLayer(index, delta, group) {
        const layers = [...memoryPrompts[group]].sort((a, b) => a.order - b.order);
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= layers.length) return;
        const currentOrder = layers[index].order;
        layers[index].order = layers[nextIndex].order;
        layers[nextIndex].order = currentOrder;
        renderPromptProfile();
      }

      async function saveMemoryPromptGroup(group, target) {
        const result = await fetch("/admin/api/memory/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompts: memoryPrompts }) }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "Memorize " + group + " saved." : "Memorize prompt save failed.";
        if (result.prompts) memoryPrompts = result.prompts;
        renderPromptProfile();
        if (result.ok) await refreshMemoryPromptPreview(target);
      }

      async function refreshMemoryPromptPreview(target) {
        if (!$("memoryPromptPreview")) return;
        if (promptSideView === "variables") {
          $("memoryPromptPreview").outerHTML = renderPromptSideContent("memory", "Save a Memorize group to refresh its preview.");
          return;
        }
        lastMemoryPromptPreviewTarget = target || lastMemoryPromptPreviewTarget;
        $("promptSideTitle").textContent = "Prompt Preview · " + memoryTargetLabel(target);
        $("memoryPromptPreview").textContent = "Loading preview...";
        const result = await fetch("/admin/api/memory/prompts/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompts: memoryPrompts, target, date: $("memoryRunDate")?.value })
        }).then(async (res) => ({ status: res.status, body: await res.json() }));
        if (!result.body.ok) {
          $("memoryPromptPreview").textContent = JSON.stringify(result.body, null, 2);
          return;
        }
        $("memoryPromptPreview").innerHTML = renderMemoryPromptPreview(result.body.preview);
      }

      function memoryTargetLabel(target) {
        if (target === "userPreferences") return "user-preferences → user-preferences";
        if (target === "yesterdaySummary") return "diary → diary";
        return "persistent-memory → persistent-memory";
      }

      function renderMemoryPromptPreview(preview) {
        const request = preview.request || {};
        return renderLLMRequestBlock("Current Memorize Prompt Preview · " + memoryTargetLabel(preview.target), {
          ...request,
          source: "preview",
          time: preview.generatedAt,
          conversationId: preview.target,
          rawRequest: request
        });
      }

      async function refreshLLMApiPresets() {
        const payload = await fetch("/admin/api/config/llm-presets").then((res) => res.json());
        llmApiPresets = payload.presets || [];
        currentLLMApiPreset = payload.active;
        renderLLMApiPresetControls();
        if (payload.active) {
          applyLLMApiPresetToForm(payload.active);
          $("llmPresetSelect").value = payload.active.name || "";
        }
      }

      function renderLLMApiPresetControls() {
        if ($("llmPresetSelect")) $("llmPresetSelect").innerHTML = renderLLMApiPresetOptions($("llmPresetSelect").value || "");
        if ($("promptApiPresetSelect")) {
          const selected = promptEditorMode === "memory"
            ? promptApiProfile.memorizePresetName
            : promptEditorMode === "talk"
              ? promptApiProfile.talkPresetName
              : (promptApiProfile.chatPresetName || promptApiProfile.corePresetName);
          $("promptApiPresetSelect").innerHTML = renderLLMApiPresetOptions(selected || "");
        }
      }

      function renderLLMApiPresetOptions(selected = "") {
        return ['<option value="" ' + (!selected ? "selected" : "") + '>Choose API preset</option>']
          .concat(llmApiPresets.map((preset) => \`<option value="\${escapeAttr(preset.name)}" \${selected === preset.name ? "selected" : ""}>\${escapeHtml(preset.name)}\${preset.apiKeySet ? "" : " (no key)"}</option>\`))
          .join("");
      }

      function selectedLLMApiPreset(selectId = "llmPresetSelect") {
        const name = $(selectId)?.value || "";
        return llmApiPresets.find((preset) => preset.name === name);
      }

      function collectLLMApiForm() {
        const body = {
          baseURL: $("baseURL").value,
          model: $("model").value,
          temperature: $("temperature").value,
          timeoutMs: $("timeoutMs").value,
          stream: $("streamEnabled").checked,
          supportsImage: $("supportsImage").checked,
          supportsAudio: $("supportsAudio").checked,
          extraParams: $("extraParams").value,
          followupExtraParams: $("followupExtraParams").value
        };
        if ($("apiKey").value) body.apiKey = $("apiKey").value;
        return body;
      }

      function bindLLMApiPresetFormDirtyTracking() {
        ["llmPresetName", "baseURL", "model", "apiKey", "temperature", "timeoutMs", "extraParams", "followupExtraParams"].forEach((id) => {
          $(id)?.addEventListener("input", () => markLLMApiPreset("dirty"));
        });
        $("streamEnabled")?.addEventListener("change", () => markLLMApiPreset("dirty"));
        $("supportsImage")?.addEventListener("change", () => markLLMApiPreset("dirty"));
        $("supportsAudio")?.addEventListener("change", () => markLLMApiPreset("dirty"));
      }

      function markLLMApiPreset(state) {
        const marker = $("llmPresetMarker");
        if (!marker) return;
        marker.textContent = state === "dirty" ? "[●]" : state === "saved" ? "[M]" : "";
      }

      function applyLLMApiPresetToForm(preset) {
        $("baseURL").value = preset.baseURL || "";
        $("model").value = preset.model || "";
        $("temperature").value = String(preset.temperature ?? "");
        $("timeoutMs").value = String(preset.timeoutMs ?? "");
        $("streamEnabled").checked = preset.stream !== false;
        $("supportsImage").checked = preset.supportsImage === true;
        $("supportsAudio").checked = preset.supportsAudio === true;
        $("extraParams").value = JSON.stringify(preset.extraParams || {}, null, 2);
        $("followupExtraParams").value = JSON.stringify(preset.followupExtraParams || {}, null, 2);
        $("llmPresetName").value = preset.name || "";
        $("apiKey").value = "";
        markLLMApiPreset("");
      }

      function clearLLMApiForm() {
        $("baseURL").value = "";
        $("model").value = "";
        $("temperature").value = "0.2";
        $("timeoutMs").value = "60000";
        $("streamEnabled").checked = true;
        $("supportsImage").checked = false;
        $("supportsAudio").checked = false;
        $("extraParams").value = "{}";
        $("followupExtraParams").value = "{}";
        $("llmPresetName").value = "";
        $("apiKey").value = "";
        markLLMApiPreset("");
      }

      function validateLLMApiPresetForm() {
        const name = $("llmPresetName").value.trim() || $("llmPresetSelect").value;
        if (!name) return "Preset name required. API settings are saved only as named presets.";
        if (!$("model").value.trim()) return "Model is required.";
        const baseURL = $("baseURL").value.trim();
        if (baseURL) {
          try {
            const url = new URL(baseURL);
            if (url.protocol !== "http:" && url.protocol !== "https:") return "Base URL must start with http:// or https://.";
          } catch {
            return "Base URL is not a valid URL.";
          }
        }
        const temperature = Number($("temperature").value);
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return "Temperature must be a number between 0 and 2.";
        const timeoutMs = Number($("timeoutMs").value);
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) return "Timeout Ms must be at least 1000.";
        const extraParams = parseLLMApiJsonObject("Extra Params JSON", $("extraParams").value);
        if (extraParams) return extraParams;
        const followupExtraParams = parseLLMApiJsonObject("Follow-up Extra Params JSON", $("followupExtraParams").value);
        if (followupExtraParams) return followupExtraParams;
        return "";
      }

      function parseLLMApiJsonObject(label, value) {
        const text = value.trim();
        if (!text) return "";
        try {
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return label + " must be a JSON object.";
          return "";
        } catch {
          return label + " is not valid JSON.";
        }
      }

      async function saveCurrentLLMApiPreset() {
        const name = $("llmPresetName").value.trim() || $("llmPresetSelect").value;
        const validationError = validateLLMApiPresetForm();
        if (validationError) {
          $("save-status").textContent = validationError;
          return;
        }
        try {
          $("save-status").textContent = "Saving preset...";
          const result = await persistLLMApiPreset(name);
          $("save-status").textContent = "Preset saved: " + name;
          llmApiPresets = result.presets || llmApiPresets;
          renderLLMApiPresetControls();
          $("llmPresetSelect").value = name;
          const saved = selectedLLMApiPreset();
          if (saved) applyLLMApiPresetToForm(saved);
          markLLMApiPreset("saved");
        } catch (error) {
          $("save-status").textContent = "Preset save failed: " + (error?.message || "unknown");
        }
      }

      async function persistLLMApiPreset(name) {
        const result = await fetch("/admin/api/config/llm-presets", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, ...collectLLMApiForm() })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown");
        return result;
      }

      async function savePromptApiProfile(mode) {
        const selected = $("promptApiPresetSelect")?.value || undefined;
        const profile = {
          chatPresetName: promptApiProfile.chatPresetName || promptApiProfile.corePresetName || undefined,
          talkPresetName: promptApiProfile.talkPresetName || undefined,
          memorizePresetName: promptApiProfile.memorizePresetName || undefined
        };
        if (mode === "memorize") profile.memorizePresetName = selected;
        else if (mode === "talk") profile.talkPresetName = selected;
        else profile.chatPresetName = selected;
        const result = await fetch("/admin/api/prompt-api-profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(profile)
        }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "API binding saved." : "API binding save failed: " + (result.error || "unknown");
        if (result.profile) promptApiProfile = result.profile;
        if (result.ok) {
          if (mode === "memorize") await refreshMemoryPromptPreview(lastMemoryPromptPreviewTarget);
          else await refreshChatPromptPreview(mode);
        }
      }

      async function renameSelectedLLMApiPreset() {
        const from = $("llmPresetSelect").value;
        const to = $("llmPresetName").value.trim();
        if (!from || !to) {
          $("save-status").textContent = "Choose a preset and enter a new name.";
          return;
        }
        const result = await fetch("/admin/api/config/llm-presets/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from, to })
        }).then((res) => res.json());
        $("save-status").textContent = result.ok ? "Preset renamed." : "Preset rename failed: " + (result.error || "unknown");
        if (result.presets) {
          llmApiPresets = result.presets;
          renderLLMApiPresetControls();
          $("llmPresetSelect").value = to;
        }
      }

      async function deleteSelectedLLMApiPreset() {
        const name = $("llmPresetSelect").value;
        if (!name) {
          $("save-status").textContent = "Choose a preset to delete.";
          return;
        }
        const result = await fetch("/admin/api/config/llm-presets", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name })
        }).then((res) => res.json());
        $("save-status").textContent = result.ok ? "Preset deleted." : "Preset delete failed: " + (result.error || "unknown");
        if (result.presets) {
          llmApiPresets = result.presets;
          renderLLMApiPresetControls();
          $("llmPresetName").value = "";
        }
      }

      async function refreshMemory() {
        const payload = await fetch("/admin/api/memory").then((res) => res.json());
        const files = payload.files || [];
        renderMemorySleepDays(payload.sleepDays || []);
        await refreshMemoryDayMessages();
        $("memoryFiles").innerHTML = files.map((file) => \`
          <details class="prompt-layer" open>
            <summary>
              <span>\${escapeHtml(memoryTargetDisplayName(file.target))} · \${escapeHtml(file.tableName || file.fileName)}</span>
              <span>
                \${escapeHtml(file.lines)}/\${escapeHtml(file.maxLines)} lines · \${escapeHtml(file.bytes)}/\${escapeHtml(file.maxBytes)} bytes
                <button type="button" class="secondary" data-memory-run="\${escapeAttr(file.target)}">Run</button>
              </span>
            </summary>
            <textarea data-memory-target="\${escapeAttr(file.target)}" rows="10">\${escapeHtml(file.content || "")}</textarea>
            <button type="button" data-memory-save="\${escapeAttr(file.target)}">Save SQL Record</button>
            <button type="button" class="secondary" data-memory-delete-latest="\${escapeAttr(file.target)}">Delete Latest SQL Record</button>
          </details>
        \`).join("");
        document.querySelectorAll("[data-memory-run]").forEach((button) => button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await runMemoryTarget(button.dataset.memoryRun);
        }));
        document.querySelectorAll("[data-memory-save]").forEach((button) => button.addEventListener("click", async () => {
          const target = button.dataset.memorySave;
          const content = document.querySelector('[data-memory-target="' + cssEscape(target) + '"]').value;
          const result = await fetch("/admin/api/memory/file", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target, content })
          }).then((res) => res.json());
          $("memory-status").textContent = result.ok ? "Memory SQL record saved." : "Memory SQL save failed: " + (result.error || "unknown error");
          if (result.ok && Array.isArray(result.files)) {
            const file = result.files.find((entry) => entry.target === target);
            const details = button.closest("details");
            if (file && details) {
              details.querySelector("summary span").textContent = file.lines + "/" + file.maxLines + " lines · " + file.bytes + "/" + file.maxBytes + " bytes";
            }
          }
        }));
        document.querySelectorAll("[data-memory-delete-latest]").forEach((button) => button.addEventListener("click", async () => {
          await deleteLatestMemorySqlRecord(button.dataset.memoryDeleteLatest);
        }));
      }

      function memoryTargetDisplayName(target) {
        if (target === "persistent") return "记忆";
        if (target === "userPreferences") return "用户记忆";
        if (target === "yesterdaySummary") return "日记";
        return target || "Memory";
      }

      function renderMemorySleepDays(days) {
        memorySleepDays = days;
        const select = $("memoryRunDate");
        const previous = select.value;
        if (!days.length) {
          select.innerHTML = '<option value="">No sleep windows</option>';
          renderMemoryCalendar();
          return;
        }
        select.innerHTML = days.map((day) => {
          const label = day.date + "  " + (day.startAt || "") + " -> " + (day.endAt || "");
          return \`<option value="\${escapeAttr(day.date)}">\${escapeHtml(label)}</option>\`;
        }).join("");
        select.value = days.some((day) => day.date === previous) ? previous : days[0].date;
        memoryCalendarMonth = select.value.slice(0, 7);
        renderMemoryCalendar();
      }

      function renderMemoryCalendar() {
        const root = $("memoryCalendar");
        if (!root) return;
        const selected = $("memoryRunDate").value;
        if (!memorySleepDays.length) {
          const month = memoryCalendarMonth || new Date().toISOString().slice(0, 7);
          root.innerHTML = renderMemoryCalendarShell(month, selected, new Set());
          bindMemoryCalendar();
          return;
        }
        if (!memoryCalendarMonth) memoryCalendarMonth = selected ? selected.slice(0, 7) : memorySleepDays[0].date.slice(0, 7);
        root.innerHTML = renderMemoryCalendarShell(memoryCalendarMonth, selected, new Set(memorySleepDays.map((day) => day.date)));
        bindMemoryCalendar();
      }

      function renderMemoryCalendarShell(month, selected, availableDates) {
        const first = new Date(month + "-01T00:00:00");
        const year = first.getFullYear();
        const monthIndex = first.getMonth();
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
        const leading = first.getDay();
        const cells = [];
        for (let i = 0; i < leading; i += 1) cells.push('<button type="button" class="memory-calendar-day empty" disabled></button>');
        for (let day = 1; day <= daysInMonth; day += 1) {
          const date = month + "-" + String(day).padStart(2, "0");
          const available = availableDates.has(date);
          const classes = ["memory-calendar-day", available ? "available" : "", selected === date ? "selected" : ""].filter(Boolean).join(" ");
          cells.push(\`<button type="button" class="\${classes}" data-memory-calendar-date="\${escapeAttr(date)}" \${available ? "" : "disabled"}>\${day}</button>\`);
        }
        const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => '<div class="memory-calendar-weekday">' + day + '</div>').join("");
        return \`
          <div class="memory-calendar-head">
            <button type="button" class="secondary" data-memory-calendar-shift="-1">&lt;</button>
            <strong>\${escapeHtml(month)}</strong>
            <button type="button" class="secondary" data-memory-calendar-shift="1">&gt;</button>
          </div>
          <div class="memory-calendar-grid">\${weekdays}\${cells.join("")}</div>
        \`;
      }

      function bindMemoryCalendar() {
        document.querySelectorAll("[data-memory-calendar-date]").forEach((button) => button.addEventListener("click", async () => {
          $("memoryRunDate").value = button.dataset.memoryCalendarDate;
          memoryCalendarMonth = $("memoryRunDate").value.slice(0, 7);
          renderMemoryCalendar();
          await refreshMemoryDayMessages();
        }));
        document.querySelectorAll("[data-memory-calendar-shift]").forEach((button) => button.addEventListener("click", () => {
          const current = new Date((memoryCalendarMonth || new Date().toISOString().slice(0, 7)) + "-01T00:00:00");
          current.setMonth(current.getMonth() + Number(button.dataset.memoryCalendarShift || 0));
          memoryCalendarMonth = current.toISOString().slice(0, 7);
          renderMemoryCalendar();
        }));
      }

      async function refreshMemoryDayMessages() {
        if (!$("memoryDayMessages")) return;
        const date = $("memoryRunDate").value;
        if (!date) {
          $("memoryDayMessages").textContent = "Choose a date to load chat records.";
          return;
        }
        $("memoryDayMessages").textContent = "Loading chat records...";
        const payload = await fetch("/admin/api/memory/messages?date=" + encodeURIComponent(date)).then((res) => res.json());
        if (!payload.ok) {
          $("memoryDayMessages").textContent = "Chat load failed: " + (payload.error || "unknown error");
          return;
        }
        const utcWindow = payload.startAtUtc || payload.endAtUtc
          ? ' utc=' + escapeHtml(payload.startAtUtc || "") + ' -> ' + escapeHtml(payload.endAtUtc || "")
          : "";
        $("memoryDayMessages").innerHTML = '<div class="log-line">Window: ' + escapeHtml(payload.startAt || "") + ' -> ' + escapeHtml(payload.endAt || "") + utcWindow + '</div>' + renderMemoryDayMessages(payload);
      }

      function renderMemoryDayMessages(payload) {
        if (typeof payload.content === "string" && payload.content.trim()) {
          return '<pre class="log-line">' + escapeHtml(payload.content) + '</pre>';
        }
        const messages = payload.messages || [];
        if (!messages.length) return '<div class="log-line">No chat records for selected date.</div>';
        return messages.map((message) => {
          const actor = message.senderRole || message.direction || "unknown";
          const status = message.status && message.status !== "sent" ? " " + message.status : "";
          const utc = message.createdAtUtc ? " utc=" + message.createdAtUtc : "";
          return \`<div class="log-line">[\${escapeHtml(message.createdAt || "")}\${escapeHtml(utc)}] \${escapeHtml(actor)}\${escapeHtml(status)}: \${escapeHtml(message.contentText || "")}</div>\`;
        }).join("");
      }

      async function runMemoryDay() {
        const runId = createMemoryRunId();
        const startedAt = Date.now();
        const stopProgress = startMemoryRunProgress(runId, "Running Memorize...", startedAt);
        let result;
        try {
          result = await fetch("/admin/api/memory/run-day", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ date: $("memoryRunDate").value, runId })
          }).then(async (res) => ({ status: res.status, body: await res.json() }));
        } finally {
          stopProgress();
        }
        const progress = await fetchMemoryRunProgress(runId);
        const rounds = memoryRunRoundsText(result.body.result, result.body.ok ? "ok" : "failed", progress);
        $("memory-status").textContent = result.body.ok ? "Memorize complete." + rounds : "Memorize failed: " + memoryRunErrorText(result.body) + rounds;
        $("memoryRunResult").textContent = JSON.stringify(result.body.result || result.body, null, 2);
        await refreshMemory();
        await refreshLogs();
      }

      async function runMemoryTarget(target) {
        const runId = createMemoryRunId();
        const startedAt = Date.now();
        const stopProgress = startMemoryRunProgress(runId, "Running Memorize for " + target + "...", startedAt);
        let result;
        try {
          result = await fetch("/admin/api/memory/run-target", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ date: $("memoryRunDate").value, target, runId })
          }).then(async (res) => ({ status: res.status, body: await res.json() }));
        } finally {
          stopProgress();
        }
        const progress = await fetchMemoryRunProgress(runId);
        const rounds = memoryRunRoundsText(result.body.result, result.body.ok ? "ok" : "failed", progress);
        $("memory-status").textContent = result.body.ok ? "Memorize " + target + " complete." + rounds : "Memorize " + target + " failed: " + memoryRunErrorText(result.body) + rounds;
        $("memoryRunResult").textContent = JSON.stringify(result.body.result || result.body, null, 2);
        await refreshMemory();
        await refreshLogs();
      }

      function memoryRunErrorText(body) {
        const error = body?.error || body?.result?.results?.find((entry) => !entry.ok)?.error;
        if (error === "memory_manual_run_requires_paused_or_sleeping") return "pause heartbeat or enter sleeping state first";
        return error || "see Last Run / System Log";
      }

      function createMemoryRunId() {
        return Date.now() + "-" + Math.random().toString(16).slice(2);
      }

      function startMemoryRunProgress(runId, prefix, startedAt) {
        let stopped = false;
        let timer = null;
        const tick = async () => {
          if (stopped) return;
          try {
            const progress = await fetchMemoryRunProgress(runId);
            if (progress) renderMemoryProgress(prefix, progress, startedAt);
          } catch {}
          if (!stopped) timer = setTimeout(tick, 800);
        };
        $("memory-status").textContent = prefix + " rounds. 0 0s";
        timer = setTimeout(tick, 150);
        return () => {
          stopped = true;
          if (timer) clearTimeout(timer);
        };
      }

      async function fetchMemoryRunProgress(runId) {
        try {
          const payload = await fetch("/admin/api/memory/run-progress?id=" + encodeURIComponent(runId)).then((res) => res.json());
          return payload.ok ? payload.progress : null;
        } catch {
          return null;
        }
      }

      function renderMemoryProgress(prefix, progress, startedAt) {
        $("memory-status").textContent = prefix + memoryProgressRoundsText(progress, startedAt);
      }

      function memoryProgressRoundsText(progress, startedAt) {
        const entries = Object.entries(progress?.rounds || {});
        if (!entries.length) return " rounds. 0 0s";
        return " rounds. " + entries.map(([target, rounds]) => {
          const seconds = elapsedSecondsText(Date.parse(progress?.roundStartedAt?.[target] || progress?.updatedAt || new Date().toISOString()));
          return [rounds, progress?.tools?.[target], seconds].filter(Boolean).join(" ");
        }).join(", ");
      }

      function memoryRunRoundsText(result, status, progress) {
        const results = Array.isArray(result?.results) ? result.results : [];
        const parts = results.filter((entry) => typeof entry.rounds === "number").map((entry) => {
          const tool = status || progress?.tools?.[entry.target];
          const seconds = elapsedSecondsText(Date.parse(progress?.roundStartedAt?.[entry.target] || progress?.updatedAt || new Date().toISOString()));
          return [entry.rounds, tool, seconds].filter(Boolean).join(" ");
        });
        return parts.length ? " rounds. " + parts.join(", ") : "";
      }

      function elapsedSecondsText(startedAtMs) {
        return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)) + "s";
      }

      async function undoLastMemoryRun() {
        const result = await fetch("/admin/api/memory/undo-last", { method: "POST" }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Undo memory run complete." : "Undo memory run failed: " + (result.error || "unknown");
        await refreshMemory();
      }

      async function redoLastMemoryRun() {
        const result = await fetch("/admin/api/memory/redo-last", { method: "POST" }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Redo memory run complete." : "Redo memory run failed: " + (result.error || "unknown");
        await refreshMemory();
      }

      async function deleteLatestMemorySqlRecord(target) {
        $("memory-status").textContent = "Deleting latest " + memoryTargetDisplayName(target) + " SQL record...";
        const result = await fetch("/admin/api/memory/delete-latest-sql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target })
        }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Deleted latest " + memoryTargetDisplayName(target) + " SQL record: " + (result.entry?.localDate || result.entry?.id || "") : "Delete latest SQL record failed: " + (result.error || "unknown error");
        await refreshMemory();
      }

      async function clearMemorySession() {
        const result = await fetch("/admin/api/memory/clear-session", { method: "POST" }).then((res) => res.json());
        $("memory-status").textContent = result.ok ? "Memorize session cleared." : "Memorize session clear failed: " + (result.error || "unknown error");
        await refreshLLMChain();
      }

      async function refreshToolPreviewTools() {
        const payload = await fetch("/admin/api/tools").then((res) => res.json());
        toolPreviewTools = payload.tools || [];
        const select = $("toolPreviewSelect");
        const previous = select.value;
        select.innerHTML = toolPreviewTools.map((tool) => \`<option value="\${escapeAttr(tool.pluginId + ":" + tool.name)}">\${escapeHtml(tool.pluginId)} / \${escapeHtml(tool.name)}</option>\`).join("");
        if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
        if (!select.value && select.options.length) select.selectedIndex = 0;
        renderToolPreviewDefaultInput(false);
      }

      function currentToolPreviewTool() {
        const [pluginId, name] = $("toolPreviewSelect").value.split(":");
        return toolPreviewTools.find((tool) => tool.pluginId === pluginId && tool.name === name);
      }

      function renderToolPreviewDefaultInput(force) {
        const tool = currentToolPreviewTool();
        if (!tool) {
          $("toolPreviewInput").value = "{}";
          return;
        }
        if (!force && $("toolPreviewInput").value.trim() && $("toolPreviewInput").value.trim() !== "{}") return;
        $("toolPreviewInput").value = JSON.stringify(defaultInputFromSchema(tool.inputSchema), null, 2);
        $("tool-preview-status").textContent = "";
      }

      function defaultInputFromSchema(schema) {
        const properties = schema && typeof schema === "object" ? schema.properties || {} : {};
        const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
        const result = {};
        Object.entries(properties).forEach(([key, spec]) => {
          if (!required.has(key) && spec.default === undefined) return;
          if (spec.default !== undefined) {
            result[key] = spec.default;
          } else if (Array.isArray(spec.enum) && spec.enum.length) {
            result[key] = spec.enum[0];
          } else if (spec.type === "number" || spec.type === "integer") {
            result[key] = 0;
          } else if (spec.type === "boolean") {
            result[key] = false;
          } else if (spec.type === "array") {
            result[key] = [];
          } else if (spec.type === "object") {
            result[key] = {};
          } else {
            result[key] = "";
          }
        });
        return result;
      }

      async function runToolPreview() {
        const tool = currentToolPreviewTool();
        if (!tool) return;
        let input;
        try {
          input = JSON.parse($("toolPreviewInput").value || "{}");
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Arguments must be a JSON object.");
        } catch (error) {
          $("tool-preview-status").textContent = "Invalid JSON: " + (error?.message || "parse failed");
          return;
        }
        $("tool-preview-status").textContent = "Running preview...";
        const result = await fetch("/admin/api/tools/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pluginId: tool.pluginId,
            toolName: tool.name,
            targetPlugin: $("toolPreviewTarget").value,
            input
          })
        }).then(async (res) => ({ status: res.status, body: await res.json() }));
        $("tool-preview-status").textContent = result.body.ok ? "Preview complete." : "Preview failed.";
        $("toolPreviewResult").innerHTML = renderToolPreviewResult(result.body, result.status);
        $("toolPreviewResult").scrollTop = 0;
        await refreshLogs();
        await refreshLLMRequests();
      }

      function renderToolPreviewResult(payload, status) {
        return \`
          <div class="log-line">HTTP \${escapeHtml(status)} · \${escapeHtml(payload.pluginId || "")}/\${escapeHtml(payload.toolName || "")} · ok=\${escapeHtml(payload.ok)}</div>
          <div class="log-line">LLM content\\n\${escapeHtml(payload.content || payload.error || "")}</div>
          <div class="log-line">raw json\\n\${escapeHtml(JSON.stringify(payload.result || payload, null, 2))}</div>
        \`;
      }

      function renderPromptLayer(layer, index, count, collection) {
        const role = layer.role || "system";
        const isToolRequest = role === "tool_request";
        const showsThinking = role === "assistant" || isToolRequest;
        const showsContent = !isToolRequest;
        return \`
          <details class="prompt-layer" data-layer-id="\${escapeAttr(layer.id)}" data-layer-collection="\${escapeAttr(collection)}" open>
            <summary>\${escapeHtml(layer.title || "Untitled Layer")}<span>[\${escapeHtml(role)}]\${layer.enabled ? "" : " disabled"}</span></summary>
            <div class="row">
              <div>
                <label>Title</label>
                <input data-field="title" value="\${escapeAttr(layer.title)}" />
              </div>
              <div>
                <label>Role</label>
                <select data-field="role">
                  \${["system", "user", "assistant", "tool_request"].map((item) => \`<option value="\${item}" \${role === item ? "selected" : ""}>\${item}</option>\`).join("")}
                </select>
              </div>
              <label><input data-field="enabled" type="checkbox" \${layer.enabled ? "checked" : ""} /> Enabled</label>
            </div>
            \${isToolRequest ? \`<div class="row">
              <div>
                <label>Tool Name</label>
                <select data-field="toolName">
                  \${renderToolOptions(layer.toolName)}
                </select>
              </div>
              <div>
                <label>Tool Call ID</label>
                <input data-field="toolCallId" value="\${escapeAttr(layer.toolCallId || "")}" placeholder="call_1" />
              </div>
              <div></div>
            </div>
            <label>Tool Arguments</label>
            <textarea data-field="toolArguments" rows="3">\${escapeHtml(layer.toolArguments || "")}</textarea>
            <p class="muted">Tool result is generated by actually running this request when the LLM request is built. It is not editable.</p>\` : ""}
            \${showsThinking ? \`<label>\${isToolRequest ? "Thinking / Assistant Tool Call Content" : "Thinking / Assistant Content"}</label>
            <textarea data-field="thinking" rows="3">\${escapeHtml(layer.thinking || "")}</textarea>\` : ""}
            \${showsContent ? \`<label>Content</label>
            <textarea data-field="content" rows="7">\${escapeHtml(layer.content || "")}</textarea>\` : ""}
            <div class="prompt-actions">
              <button type="button" data-action="up" \${index === 0 ? "disabled" : ""}>Up</button>
              <button type="button" data-action="down" \${index === count - 1 ? "disabled" : ""}>Down</button>
              <button type="button" data-action="delete" class="secondary">Delete</button>
            </div>
          </details>
        \`;
      }

      function renderToolOptions(selected) {
        const names = promptTools.map((tool) => tool.name);
        const current = selected || names[0] || "check_chat";
        const allNames = names.includes(current) ? names : [current, ...names];
        return allNames.map((name) => \`<option value="\${escapeAttr(name)}" \${current === name ? "selected" : ""}>\${escapeHtml(name)}</option>\`).join("");
      }

      function bindPromptLayer(layer, index, collection) {
        const activeProfile = promptEditorMode === "talk" ? talkPromptProfile : promptProfile;
        const root = document.querySelector('[data-layer-collection="' + cssEscape(collection) + '"][data-layer-id="' + cssEscape(layer.id) + '"]');
        if (!root) return;
        root.querySelector('[data-field="title"]').addEventListener("input", (event) => { layer.title = event.target.value; });
        root.querySelector('[data-field="role"]').addEventListener("change", (event) => {
          layer.role = event.target.value;
          if (layer.role !== "tool_request") {
            delete layer.toolName;
            delete layer.toolCallId;
            delete layer.toolArguments;
          }
          if (layer.role !== "assistant" && layer.role !== "tool_request") delete layer.thinking;
          renderPromptProfile();
        });
        root.querySelector('[data-field="enabled"]').addEventListener("change", (event) => { layer.enabled = event.target.checked; });
        root.querySelector('[data-field="toolName"]')?.addEventListener("change", (event) => { layer.toolName = event.target.value; });
        root.querySelector('[data-field="toolCallId"]')?.addEventListener("input", (event) => { layer.toolCallId = event.target.value; });
        root.querySelector('[data-field="thinking"]')?.addEventListener("input", (event) => { layer.thinking = event.target.value; });
        root.querySelector('[data-field="toolArguments"]')?.addEventListener("input", (event) => { layer.toolArguments = event.target.value; });
        root.querySelector('[data-field="content"]')?.addEventListener("input", (event) => { layer.content = event.target.value; });
        root.querySelector('[data-action="delete"]').addEventListener("click", () => {
          activeProfile[collection] = activeProfile[collection].filter((item) => item.id !== layer.id);
          renderPromptProfile();
        });
        root.querySelector('[data-action="up"]').addEventListener("click", () => movePromptLayer(index, -1, collection));
        root.querySelector('[data-action="down"]').addEventListener("click", () => movePromptLayer(index, 1, collection));
      }

      function movePromptLayer(index, delta, collection) {
        const activeProfile = promptEditorMode === "talk" ? talkPromptProfile : promptProfile;
        const layers = [...activeProfile[collection]].sort((a, b) => a.order - b.order);
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= layers.length) return;
        const currentOrder = layers[index].order;
        layers[index].order = layers[nextIndex].order;
        layers[nextIndex].order = currentOrder;
        renderPromptProfile();
      }

      async function savePromptProfile() {
        const isTalk = promptEditorMode === "talk";
        const body = isTalk ? talkPromptProfile : promptProfile;
        const result = await fetch(isTalk ? "/admin/api/talk-prompt-profile" : "/admin/api/prompt-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("prompt-status").textContent = result.ok ? "Prompt profile saved." : "Prompt profile save failed.";
        if (result.profile) {
          if (isTalk) talkPromptProfile = result.profile;
          else promptProfile = result.profile;
          if (isTalk) talkPromptVariables = result.variables || {};
          else promptVariables = result.variables || {};
          renderPromptProfile();
          await refreshChatPromptPreview(isTalk ? "talk" : "chat");
        }
        await refreshLLMRequests();
      }

      async function refreshChatPromptPreview(mode = "chat") {
        const elementId = mode === "talk" ? "talkPromptPreview" : "chatPromptPreview";
        const element = $(elementId);
        if (!element) return;
        if (promptSideView === "variables") {
          element.outerHTML = renderPromptSideContent(mode, "Save Prompt Profile to refresh preview.");
          return;
        }
        element.textContent = "Loading preview...";
        const payload = await fetch("/admin/api/llm-requests").then((res) => res.json());
        const preview = mode === "talk" ? payload.talkProfilePreview : payload.profilePreview;
        element.innerHTML = preview ? renderLLMRequestBlock(mode === "talk" ? "Current Talk Prompt Profile Prebuild" : "Current Prompt Profile Prebuild", preview) : "No " + (mode === "talk" ? "Talk" : "Chat") + " prompt preview available.";
      }

      let shellData = null;
      let shellOrder = { personalities: [], relationships: [], outfits: [] };
      const shellCategories = [
        { key: "personalities", title: "性格 / 语气" },
        { key: "relationships", title: "关系 / 称呼" },
        { key: "outfits", title: "服装 / Cosplay" }
      ];

      async function refreshShellEditor() {
        const [data, orderPayload] = await Promise.all([
          fetch("/admin/api/shell").then((res) => res.json()),
          fetch("/admin/api/shell-ui/order").then((res) => res.json())
        ]);
        shellData = data;
        shellOrder = orderPayload.order || shellOrder;
        shellCategories.forEach((category) => {
          shellData[category.key] = applyShellOrder(category.key, shellData[category.key] || []);
        });
        renderShellEditor();
      }

      function renderShellEditor() {
        if (!shellData) return;
        $("shellEditor").innerHTML = \`
          <div class="shell-head">
            <h2>Daily Shell</h2>
            <button type="button" id="shell-reroll" class="secondary">Reroll Today</button>
          </div>
          <details class="prompt-layer">
            <summary>Today<span>\${escapeHtml(shellData.daily?.date || "")}</span></summary>
            <p class="muted">Created at: \${escapeHtml(shellData.daily?.createdAt || "")}</p>
            <pre>\${escapeHtml(JSON.stringify(shellData.todayVariables || {}, null, 2))}</pre>
          </details>
          <details class="prompt-layer">
            <summary>Shell Settings<span>daily refresh clock</span></summary>
            <label for="shellRolloverHour">Daily Refresh Clock (0-23)</label>
            <input id="shellRolloverHour" inputmode="numeric" value="\${escapeAttr(shellData.settings?.rolloverHour ?? 4)}" />
            <button type="button" id="shell-settings-save">Save Shell Settings</button>
          </details>
          <details class="prompt-layer" open>
            <summary>语气 / 称呼<span>top</span></summary>
            <div class="shell-grid">
              \${shellCategories.slice(0, 2).map((category) => renderShellCategory(category)).join("")}
            </div>
          </details>
          <details class="prompt-layer" open>
            <summary>服装<span>bottom</span></summary>
            \${renderShellCategory(shellCategories[2])}
          </details>
        \`;
        $("shell-reroll").addEventListener("click", rerollShell);
        $("shell-settings-save").addEventListener("click", saveShellSettings);
        shellCategories.forEach((category) => bindShellCategory(category.key));
      }

      function renderShellCategory(category) {
        const options = shellData[category.key] || [];
        return \`
          <div class="prompt-layer shell-category-\${escapeAttr(category.key)}" data-shell-category="\${escapeAttr(category.key)}">
            <div class="shell-head">
              <h2>\${escapeHtml(category.title)}</h2>
              <span class="muted" data-shell-category-count>\${options.length} options</span>
            </div>
            <div class="shell-category-body">
              \${renderShellGroups(category.key, options)}
            </div>
          </div>
        \`;
      }

      function renderShellGroups(category, options) {
        const groups = new Map();
        options.forEach((option, index) => {
          const group = option.group || "root";
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group).push({ option, index });
        });
        return [...groups.entries()].map(([group, items]) => renderShellGroup(category, group, items)).join("");
      }

      function renderShellGroup(category, group, items = shellGroupItems(category, group), open = false) {
        return \`
          <details class="shell-group" data-shell-group="\${escapeAttr(group)}" \${open ? "open" : ""}>
            <summary>
              <strong>\${escapeHtml(group)}</strong>
              <div class="shell-group-actions">
                <span class="muted" data-shell-group-count>\${items.length} items</span>
                <button type="button" class="shell-group-add" data-action="add-group" data-shell-group-add="\${escapeAttr(group)}" title="Add to \${escapeAttr(group)}" aria-label="Add to \${escapeAttr(group)}">+</button>
              </div>
            </summary>
            \${items.map(({ option, index }) => renderShellOption(category, option, index)).join("")}
          </details>
        \`;
      }

      function shellGroupItems(category, group) {
        return (shellData[category] || [])
          .map((option, index) => ({ option, index }))
          .filter(({ option }) => (option.group || "root") === group);
      }

      function applyShellOrder(category, options) {
        const order = shellOrder[category] || [];
        if (!order.length) return options;
        const byId = new Map(options.map((option) => [option.id, option]));
        const sorted = order.map((id) => byId.get(id)).filter(Boolean);
        const seen = new Set(sorted.map((option) => option.id));
        return [...sorted, ...options.filter((option) => !seen.has(option.id))];
      }

      function renderShellOption(category, option, index) {
        return \`
          <details class="shell-option" data-shell-index="\${index}">
            <summary>
              <span class="shell-title">\${escapeHtml(option.name || "New Shell")}</span>
              <span class="shell-marker" data-field="marker"></span>
              <button type="button" data-action="up" title="Move up">↑</button>
              <button type="button" data-action="down" title="Move down">↓</button>
              <button type="button" class="shell-save" data-action="save-one" title="Save">S</button>
            </summary>
            <div class="row">
              <div>
                <label>ID</label>
                <input data-field="id" value="\${escapeAttr(option.id || "")}" />
              </div>
              <div></div>
            </div>
            <label>Name</label>
            <input data-field="name" value="\${escapeAttr(option.name || "")}" />
            <label>Group</label>
            <input data-field="group" value="\${escapeAttr(option.group || "")}" placeholder="root / 原神 / ..." />
            \${category === "outfits" ? \`
              <label>Image</label>
              <div class="shell-image-drop" data-field="imageDrop">
                <span class="muted">拖入图片自动上传</span>
                <img class="shell-image-preview \${option.imageUrl ? "" : "hidden"}" data-field="imagePreview" src="\${escapeAttr(shellImageSrc(option.imageUrl || ""))}" alt="" />
              </div>
            \` : ""}
            <label>Content</label>
            <textarea data-field="content" rows="6">\${escapeHtml(option.content || "")}</textarea>
            <button type="button" data-action="delete" class="secondary">Delete</button>
          </details>
        \`;
      }

      function bindShellCategory(category) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        if (!root) return;
        root.querySelectorAll(".shell-group").forEach((groupRoot) => bindShellGroup(groupRoot, category));
      }

      function bindShellGroup(groupRoot, category) {
        if (!groupRoot) return;
        groupRoot.querySelector('[data-action="add-group"]')?.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const group = event.currentTarget.dataset.shellGroupAdd || "root";
          shellData[category].push({ id: category.slice(0, -1) + "_" + Date.now(), name: "New Shell", content: "", group });
          rerenderShellGroup(category, group, true);
          updateShellCategoryCount(category);
        });
        groupRoot.querySelectorAll(".shell-option").forEach((optionRoot) => bindShellOption(optionRoot, category));
      }

      function rerenderShellGroup(category, group, open) {
        const categoryRoot = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        const groupRoot = categoryRoot?.querySelector('[data-shell-group="' + cssEscape(group) + '"]');
        const items = shellGroupItems(category, group);
        if (!items.length) {
          groupRoot?.remove();
          return;
        }
        const shouldOpen = open ?? Boolean(groupRoot?.open);
        const html = renderShellGroup(category, group, items, shouldOpen);
        if (groupRoot) groupRoot.outerHTML = html;
        else categoryRoot?.querySelector(".shell-category-body")?.insertAdjacentHTML("beforeend", html);
        bindShellGroup(categoryRoot?.querySelector('[data-shell-group="' + cssEscape(group) + '"]'), category);
      }

      function updateShellCategoryCount(category) {
        const categoryRoot = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        const categoryCount = categoryRoot?.querySelector("[data-shell-category-count]");
        if (categoryCount) categoryCount.textContent = shellData[category].length + " options";
      }

      function bindShellOption(optionRoot, category) {
        if (!optionRoot) return;
        const index = Number(optionRoot.dataset.shellIndex);
        const option = shellData[category][index];
        option._previousId = option._previousId || option.id;
        optionRoot.querySelector('[data-field="id"]').addEventListener("input", (event) => { option.id = event.target.value; markShellOption(optionRoot, "dirty"); });
        optionRoot.querySelector('[data-field="name"]').addEventListener("input", (event) => { option.name = event.target.value; markShellOption(optionRoot, "dirty"); });
        optionRoot.querySelector('[data-field="group"]').addEventListener("input", (event) => { option.group = event.target.value; markShellOption(optionRoot, "dirty"); });
        bindShellImageDrop(optionRoot, option, category, index);
        optionRoot.querySelector('[data-field="content"]').addEventListener("input", (event) => { option.content = event.target.value; markShellOption(optionRoot, "dirty"); });
        optionRoot.querySelector('[data-action="save-one"]').addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          try {
            await saveShellOption(category, currentShellIndex(optionRoot));
          } catch (error) {
            $("shell-status").textContent = "Shell save failed: " + (error?.message || "unknown error");
          }
        });
        optionRoot.querySelector('[data-action="up"]').addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          moveShellOption(category, currentShellIndex(optionRoot), -1).catch((error) => {
            $("shell-status").textContent = "Shell order save failed: " + (error?.message || "unknown error");
          });
        });
        optionRoot.querySelector('[data-action="down"]').addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          moveShellOption(category, currentShellIndex(optionRoot), 1).catch((error) => {
            $("shell-status").textContent = "Shell order save failed: " + (error?.message || "unknown error");
          });
        });
        optionRoot.querySelector('[data-action="delete"]').addEventListener("click", async () => {
          if (shellData[category].length <= 1) {
            $("shell-status").textContent = "Each shell category must keep at least one option.";
            return;
          }
          try {
            await deleteShellOption(category, currentShellIndex(optionRoot));
          } catch (error) {
            $("shell-status").textContent = "Shell delete failed: " + (error?.message || "unknown error");
          }
        });
      }

      async function moveShellOption(category, index, delta) {
        const options = shellData[category];
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= options.length) return;
        const current = options[index];
        options[index] = options[nextIndex];
        options[nextIndex] = current;
        await saveShellOrder(category);
        $("shell-status").textContent = "Shell order saved.";
        moveShellOptionNode(category, index, nextIndex, delta);
      }

      async function saveShellOption(category, index) {
        const optionRoot = document.querySelector('[data-shell-category="' + cssEscape(category) + '"] [data-shell-index="' + index + '"]');
        const option = shellData[category][index];
        const previousGroup = option?.group || "root";
        const result = await persistShellOption(category, index);
        $("shell-status").textContent = "Shell saved: " + (option?.name || option?.id || category);
        shellData[category][index] = { ...result.option, _previousId: result.option.id };
        const nextGroup = result.option.group || "root";
        if (previousGroup !== nextGroup) {
          rerenderShellGroup(category, previousGroup);
          rerenderShellGroup(category, nextGroup, true);
          return;
        }
        optionRootLabel(category, index, result.option);
        if (optionRoot) {
          markShellOption(optionRoot, "saved");
          optionRoot.open = false;
        }
      }

      async function persistShellOption(category, index) {
        const option = shellData[category][index];
        const previousId = option?._previousId || option?.id;
        const payload = { ...option };
        delete payload._previousId;
        const result = await fetch("/admin/api/shell-option", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, previousId, option: payload })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellData[category][index] = { ...result.option, _previousId: result.option.id };
        return result;
      }

      async function deleteShellOption(category, index) {
        const option = shellData[category][index];
        const id = option?._previousId || option?.id;
        const result = await fetch("/admin/api/shell-option", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, id })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellData[category].splice(index, 1);
        shellOrder = result.order || shellOrder;
        $("shell-status").textContent = "Shell deleted: " + (option?.name || id || category);
        rerenderShellGroup(category, option?.group || "root");
        updateShellCategoryCount(category);
      }

      function optionRootLabel(category, index, option) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"] [data-shell-index="' + index + '"] .shell-title');
        if (root) root.textContent = option.name || "New Shell";
      }

      function markShellOption(optionRoot, state) {
        const marker = optionRoot.querySelector('[data-field="marker"]');
        if (!marker) return;
        marker.textContent = state === "dirty" ? "[●]" : state === "saved" ? "[M]" : "";
      }

      function moveShellOptionNode(category, index, nextIndex, delta) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        const current = root?.querySelector('[data-shell-index="' + index + '"]');
        const target = root?.querySelector('[data-shell-index="' + nextIndex + '"]');
        if (!current || !target || !current.parentElement || current.parentElement !== target.parentElement) return;
        if (delta < 0) {
          target.before(current);
        } else {
          target.after(current);
        }
        current.dataset.shellIndex = String(nextIndex);
        target.dataset.shellIndex = String(index);
      }

      function currentShellIndex(optionRoot) {
        return Number(optionRoot.dataset.shellIndex);
      }

      async function saveShellOrder(category) {
        shellOrder[category] = shellData[category].map((option) => option.id);
        const result = await fetch("/admin/api/shell-ui/order", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, order: shellOrder[category] })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellOrder = result.order || shellOrder;
      }

      function shellImageSrc(imageUrl) {
        const value = String(imageUrl || "");
        if (!value) return "";
        if (/^https?:\\/\\//.test(value) || value.startsWith("data:")) return value;
        const prefix = "memory-files/shell/";
        if (value.startsWith(prefix)) return "/admin/assets/shell/" + value.slice(prefix.length).split("/").map(encodeURIComponent).join("/");
        return value;
      }

      function updateShellImagePreview(optionRoot, imageUrl, bustCache) {
        const preview = optionRoot.querySelector('[data-field="imagePreview"]');
        if (!preview) return;
        const baseSrc = shellImageSrc(imageUrl);
        const src = baseSrc && bustCache ? baseSrc + (baseSrc.includes("?") ? "&" : "?") + "v=" + Date.now() : baseSrc;
        preview.src = src;
        preview.classList.toggle("hidden", !src);
      }

      async function rerollShell() {
        const result = await fetch("/admin/api/shell/reroll", { method: "POST" }).then((res) => res.json());
        $("shell-status").textContent = result.todayVariables ? "Daily shell rerolled." : "Daily shell reroll failed.";
        shellData = result;
        renderShellEditor();
        await refreshPromptProfile();
        await refreshLLMRequests();
      }

      async function saveShellSettings() {
        const result = await fetch("/admin/api/shell-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rolloverHour: Number($("shellRolloverHour").value) })
        }).then((res) => res.json());
        $("shell-status").textContent = result.ok ? "Shell settings saved." : "Shell settings save failed: " + (result.error || "unknown error");
        if (result.ok) {
          shellData = result;
          renderShellEditor();
        }
      }

      async function uploadShellOutfitImage(optionRoot, option, category, index, file) {
        if (!file) {
          $("shell-status").textContent = "Drop an image file.";
          return;
        }
        if (!String(file.type || "").startsWith("image/")) {
          $("shell-status").textContent = "Drop an image file.";
          return;
        }
        $("shell-status").textContent = "Uploading image...";
        const imageBlob = await convertImageToJpeg(file);
        const result = await fetch("/admin/api/shell/outfit-image", {
          method: "POST",
          headers: {
            "content-type": "image/jpeg",
            "x-shell-id": encodeURIComponent(option.id || "outfit")
          },
          body: imageBlob
        }).then((res) => res.json());
        if (!result.ok) {
          $("shell-status").textContent = "Image upload failed: " + (result.error || "unknown error");
          return;
        }
        option.imageUrl = result.imageUrl;
        updateShellImagePreview(optionRoot, result.imageUrl, true);
        const saved = await persistShellOption(category, index);
        shellData[category][index] = { ...saved.option, _previousId: saved.option.id };
        optionRootLabel(category, index, saved.option);
        markShellOption(optionRoot, "saved");
        $("shell-status").textContent = "Image uploaded and saved: " + (saved.option.name || saved.option.id || "outfit");
      }

      function bindShellImageDrop(optionRoot, option, category, index) {
        const drop = optionRoot.querySelector('[data-field="imageDrop"]');
        if (!drop) return;
        ["dragenter", "dragover"].forEach((name) => {
          drop.addEventListener(name, (event) => {
            event.preventDefault();
            event.stopPropagation();
            drop.classList.add("dragging");
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          });
        });
        ["dragleave", "dragend"].forEach((name) => {
          drop.addEventListener(name, (event) => {
            event.preventDefault();
            event.stopPropagation();
            drop.classList.remove("dragging");
          });
        });
        drop.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          drop.classList.remove("dragging");
          const file = [...(event.dataTransfer?.files || [])].find((item) => String(item.type || "").startsWith("image/"));
          if (!file) {
            $("shell-status").textContent = "Drop an image file.";
            return;
          }
          uploadShellOutfitImage(optionRoot, option, category, index, file).catch((error) => {
            $("shell-status").textContent = "Image upload failed: " + (error?.message || "unknown error");
          });
        });
      }

      function convertImageToJpeg(file) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const image = new Image();
          image.onload = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = image.naturalWidth || image.width;
              canvas.height = image.naturalHeight || image.height;
              const context = canvas.getContext("2d");
              context.fillStyle = "#fff";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(image, 0, 0);
              canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);
                blob ? resolve(blob) : reject(new Error("image_convert_failed"));
              }, "image/jpeg", 0.92);
            } catch (error) {
              URL.revokeObjectURL(url);
              reject(error);
            }
          };
          image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("image_load_failed"));
          };
          image.src = url;
        });
      }

      async function uploadTtsReferenceAudio() {
        const file = $("ttsReferenceAudio").files?.[0];
        if (!file) {
          $("tts-preview-status").textContent = "Choose a WAV, MP3, or M4A voice sample first.";
          return;
        }
        const referenceText = $("ttsReferenceText").value.trim();
        if (!referenceText) {
          $("tts-preview-status").textContent = "Enter the text spoken in the reference audio first.";
          return;
        }
        $("tts-preview-status").textContent = "Uploading voice sample...";
        const result = await fetch("/admin/api/tts/reference-audio", {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name || "reference.wav"),
            "x-reference-text": encodeURIComponent(referenceText)
          },
          body: file
        }).then((res) => res.json());
        if (!result.ok) {
          $("tts-preview-status").textContent = "Voice sample upload failed: " + (result.error || "unknown error");
          return;
        }
        $("tts-reference-status").textContent = "Current reference: " + result.referenceAudio + " + " + result.referenceText + " (" + Math.round((result.size || 0) / 1024) + " KB)";
        $("tts-preview-status").textContent = "Voice sample converted to " + result.sampleRate + " Hz / " + result.channels + " ch PCM WAV, first " + result.maxDurationSeconds + "s kept.";
        await refreshLogs();
      }

      async function generateTtsPreview() {
        $("tts-preview-status").textContent = "Generating preview...";
        $("ttsPreviewAudio").removeAttribute("src");
        const result = await fetch("/admin/api/tts/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: $("ttsPreviewText").value })
        }).then((res) => res.json());
        if (!result.ok) {
          $("tts-preview-status").textContent = "Preview failed: " + (result.error || "unknown error");
          return;
        }
        $("ttsPreviewAudio").src = result.audioUrl + (result.audioUrl.includes("?") ? "&" : "?") + "v=" + Date.now();
        $("tts-preview-status").textContent = "Preview generated: " + result.assetId;
        await refreshLogs();
      }

      async function refreshLogs() {
        const system = await fetch("/admin/api/logs").then((res) => res.json());
        $("logs").innerHTML = system.logs.map((entry) => \`<div class="log-line log-\${entry.level}">[\${entry.time}\${entry.utcTime ? " utc=" + entry.utcTime : ""}] [\${entry.level.toUpperCase()}] \${escapeHtml(entry.message)}</div>\`).join("");
        $("logs").scrollTop = $("logs").scrollHeight;
        const messages = await fetch("/admin/api/message-logs").then((res) => res.json());
        $("messageLogs").innerHTML = messages.logs.map((entry) => {
          const time = entry.createdAt || entry.time;
          const utc = entry.createdAtUtc || entry.timeUtc || "";
          const kind = entry.contentType || entry.kind;
          const target = entry.conversationId || entry.target || "";
          const summary = entry.contentText || entry.summary || "";
          const state = entry.status ? " " + entry.status : "";
          const flags = [entry.isRead ? "read" : "", entry.isRecalled ? "recalled" : ""].filter(Boolean).join(",");
          return \`<div class="log-line">[\${time}\${utc ? " utc=" + utc : ""}] [\${entry.direction}\${state}] [\${entry.plugin}/\${kind}] \${escapeHtml(target)}\${flags ? " · " + escapeHtml(flags) : ""} · \${escapeHtml(summary)}</div>\`;
        }).join("");
        $("messageLogs").scrollTop = $("messageLogs").scrollHeight;
        const events = await fetch("/admin/api/message-event-logs").then((res) => res.json());
        $("eventLogs").innerHTML = events.logs.map((entry) => {
          const status = entry.status ? " " + entry.status : "";
          const target = entry.target || entry.sessionId || entry.rawMessageId || "";
          const error = entry.error ? " · error=" + entry.error : "";
          return \`<div class="log-line">[\${entry.time}] [\${entry.direction}\${status}] [\${entry.plugin}/\${entry.kind}] \${escapeHtml(target)} · \${escapeHtml(entry.summary || "")}\${escapeHtml(error)}</div>\`;
        }).join("");
        $("eventLogs").scrollTop = $("eventLogs").scrollHeight;
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
      }
      function escapeAttr(value) { return escapeHtml(value); }
      function cssEscape(value) { return String(value).replace(/["\\\\]/g, "\\\\$&"); }
      function valueAtPath(object, key) {
        return String(key || "").split(".").reduce((value, part) => value && typeof value === "object" ? value[part] : undefined, object);
      }
      function setValueAtPath(object, key, value) {
        const parts = String(key || "").split(".").filter(Boolean);
        let cursor = object;
        parts.forEach((part, index) => {
          if (index === parts.length - 1) {
            cursor[part] = value;
            return;
          }
          cursor[part] = cursor[part] && typeof cursor[part] === "object" ? cursor[part] : {};
          cursor = cursor[part];
        });
      }

      $("llm-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        await saveCurrentLLMApiPreset();
      });
      bindLLMApiPresetFormDirtyTracking();
      $("llmPresetSelect").addEventListener("change", () => {
        const preset = selectedLLMApiPreset();
        if (preset) {
          applyLLMApiPresetToForm(preset);
          $("save-status").textContent = "Preset loaded.";
          return;
        }
        clearLLMApiForm();
      });
      $("llm-preset-save").addEventListener("click", saveCurrentLLMApiPreset);
      $("llm-preset-rename").addEventListener("click", renameSelectedLLMApiPreset);
      $("llm-preset-delete").addEventListener("click", deleteSelectedLLMApiPreset);

      $("feishu-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { enabled: $("feishuEnabled").checked, connectionMode: form.get("connectionMode"), appId: form.get("appId"), requireMention: $("feishuRequireMention").checked };
        const appSecret = form.get("appSecret");
        if (appSecret) body.appSecret = appSecret;
        const result = await fetch("/admin/api/config/feishu", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("feishu-status").textContent = result.ok ? "Feishu config saved." : "Failed to save Feishu config.";
        await refresh();
      });

      $("wechat-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { enabled: $("wechatEnabled").checked, baseURL: form.get("baseURL"), pollTimeoutMs: form.get("pollTimeoutMs") };
        const result = await fetch("/admin/api/config/wechat", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("wechat-status").textContent = result.ok ? "WeChat config saved." : "Failed to save WeChat config.";
        await refresh();
      });

      $("agent-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { inboundDebounceMs: form.get("inboundDebounceMs"), timezone: form.get("timezone"), defaultTargetPlugin: form.get("defaultTargetPlugin") };
        const result = await fetch("/admin/api/config/agent", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Agent config saved." : "Failed to save agent config.";
        await refresh();
      });
      $("core-profile-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = { appearanceDescription: form.get("appearanceDescription"), librarySetting: form.get("librarySetting") };
        const result = await fetch("/admin/api/core-profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("core-profile-status").textContent = result.ok ? "Core profile saved." : "Failed to save core profile.";
        await refresh();
      });
      $("agent-state-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const body = { state: $("agentStateSelect").value, intimacy: $("agentIntimacy").value };
        const result = await fetch("/admin/api/agent-state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Agent state saved." : "Failed to save agent state.";
        await refreshAgentState();
      });
      $("heartbeat-pause").addEventListener("click", async () => {
        const result = await fetch("/admin/api/runtime/heartbeat/pause", { method: "POST" }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Heartbeat paused." : "Failed to pause heartbeat.";
        await refreshRuntimeStatus();
      });
      $("heartbeat-resume").addEventListener("click", async () => {
        const result = await fetch("/admin/api/runtime/heartbeat/resume", { method: "POST" }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Heartbeat started." : "Failed to start heartbeat.";
        await refreshRuntimeStatus();
      });
      $("memory-run-day").addEventListener("click", runMemoryDay);
      $("memory-clear-session").addEventListener("click", clearMemorySession);
      $("memory-undo-last").addEventListener("click", undoLastMemoryRun);
      $("memory-redo-last").addEventListener("click", redoLastMemoryRun);
      $("memory-delete-latest-sql").addEventListener("click", () => deleteLatestMemorySqlRecord("persistent"));
      $("memoryRunDate").addEventListener("change", async () => {
        memoryCalendarMonth = $("memoryRunDate").value.slice(0, 7);
        renderMemoryCalendar();
        await refreshMemoryDayMessages();
      });
      $("process-now").addEventListener("click", async () => {
        const result = await fetch("/admin/api/runtime/process-now", { method: "POST" }).then((res) => res.json());
        $("agent-status").textContent = result.ok ? "Pending messages processed." : "Failed to process pending messages.";
        await refreshRuntimeStatus();
        await refreshLogs();
        await refreshLLMRequests();
      });
      $("llm-chain-clear").addEventListener("click", async () => {
        const result = await fetch("/admin/api/llm-chain/clear", { method: "POST" }).then((res) => res.json());
        $("llmChainSessions").textContent = result.ok ? "Active session cleared." : "Failed to clear active session.";
        await refreshLLMRequests();
        await refreshLLMChain();
      });
      $("llm-run-cancel").addEventListener("click", async () => {
        const result = await fetch("/admin/api/llm-run/cancel", { method: "POST" }).then((res) => res.json());
        $("llmChainSessions").textContent = result.ok
          ? (result.hadActiveRequest ? "Current LLM run cancellation requested." : "LLM loop cancellation requested.")
          : "Failed to cancel current LLM run.";
        await refreshLLMRequests();
        await refreshLLMChain();
        await refreshLogs();
      });

      $("feishu-start").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/start", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime started." : "Cannot start Feishu: " + (r.error || "unknown error"); await refresh(); });
      $("feishu-stop").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/feishu/stop", { method: "POST" }).then((res) => res.json()); $("feishu-status").textContent = r.ok ? "Feishu runtime stopped." : "Cannot stop Feishu."; await refresh(); });
      let wechatLoginTimer;
      $("wechat-login").addEventListener("click", async () => {
        clearInterval(wechatLoginTimer);
        $("wechat-login-status").textContent = "Requesting QR code...";
        const r = await fetch("/admin/api/plugins/wechat/login/qrcode", { method: "POST" }).then((res) => res.json());
        if (!r.ok) {
          $("wechat-login-status").textContent = "Cannot get QR: " + (r.error || "unknown error");
          return;
        }
        if (r.qrcodeSvg) {
          $("wechat-qr").innerHTML = r.qrcodeSvg;
        } else if (r.qrcodeBase64) {
          const src = r.qrcodeBase64.startsWith("data:") ? r.qrcodeBase64 : "data:image/png;base64," + r.qrcodeBase64;
          $("wechat-qr").innerHTML = \`<img alt="WeChat login QR" src="\${escapeAttr(src)}" />\`;
        } else if (r.qrcodeUrl) {
          $("wechat-qr").innerHTML = \`<img alt="WeChat login QR" src="\${escapeAttr(r.qrcodeUrl)}" />\`;
        } else if (r.qrcodeContent) {
          $("wechat-qr").innerHTML = \`<pre>\${escapeHtml(r.qrcodeContent)}</pre>\`;
        } else {
          $("wechat-qr").innerHTML = \`<pre>\${escapeHtml(r.qrcode)}</pre>\`;
        }
        $("wechat-login-status").textContent = "Scan QR in WeChat, then confirm login on phone.";
        wechatLoginTimer = setInterval(async () => {
          const status = await fetch("/admin/api/plugins/wechat/login/status?qrcode=" + encodeURIComponent(r.qrcode)).then((res) => res.json());
          if (!status.ok) {
            $("wechat-login-status").textContent = "Login poll failed: " + (status.error || "unknown error");
            return;
          }
          $("wechat-login-status").textContent = "Login status: " + status.status;
          if (status.status === "confirmed" || status.status === "expired") {
            clearInterval(wechatLoginTimer);
            if (status.status === "confirmed") {
              $("wechat-status").textContent = "WeChat logged in and started.";
              await refresh();
            }
          }
        }, 2000);
      });
      $("wechat-start").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/wechat/start", { method: "POST" }).then((res) => res.json()); $("wechat-status").textContent = r.ok ? "WeChat runtime started." : "Cannot start WeChat: " + (r.error || "unknown error"); await refresh(); });
      $("wechat-stop").addEventListener("click", async () => { const r = await fetch("/admin/api/plugins/wechat/stop", { method: "POST" }).then((res) => res.json()); $("wechat-status").textContent = r.ok ? "WeChat runtime stopped." : "Cannot stop WeChat."; await refresh(); });
      $("send-test-markdown").addEventListener("click", async () => sendTest("test-markdown", { markdown: $("testMarkdown").value }, "Markdown"));
      $("send-test-image").addEventListener("click", async () => sendTest("test-image", { assetId: $("testImagePath").value }, "Image"));
      $("send-test-audio").addEventListener("click", async () => sendTest("test-audio", { assetId: $("testAudioPath").value }, "Audio"));
      $("tts-upload-reference").addEventListener("click", uploadTtsReferenceAudio);
      $("tts-generate-preview").addEventListener("click", generateTtsPreview);
      $("toolPreviewSelect").addEventListener("change", () => renderToolPreviewDefaultInput(true));
      $("tool-preview-reset").addEventListener("click", () => renderToolPreviewDefaultInput(true));
      $("tool-preview-run").addEventListener("click", runToolPreview);
      $("tokenUsageRange").addEventListener("change", refreshTokenUsage);
      $("tokenUsageBucket").addEventListener("change", refreshTokenUsage);
      $("tokenUsageModel").addEventListener("change", refreshTokenUsage);
      $("tokenUsageAgent").addEventListener("change", refreshTokenUsage);
      $("tokenUsageRefresh").addEventListener("click", refreshTokenUsage);
      $("pluginBack").addEventListener("click", closePluginConfig);
      $("pluginSearch").addEventListener("input", refreshPlugins);
      $("pluginGrid").addEventListener("click", async (event) => {
        const configButton = event.target.closest("[data-plugin-config]");
        if (configButton && !configButton.disabled) {
          await openPluginConfig(configButton.dataset.pluginConfig);
          return;
        }
        const reloadButton = event.target.closest("[data-plugin-reload]");
        if (reloadButton && !reloadButton.disabled) {
          const pluginId = reloadButton.dataset.pluginReload;
          const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/reload", { method: "POST" }).then((res) => res.json());
          $("plugin-status").textContent = result.ok ? pluginId + " reloaded." : "Reload failed: " + (result.error || "unknown error");
          await refreshPlugins();
        }
      });
      $("pluginGrid").addEventListener("change", async (event) => {
        const input = event.target.closest("[data-plugin-switch]");
        if (!input || input.disabled) return;
        const pluginId = input.dataset.pluginSwitch;
        const action = input.checked ? "enable" : "disable";
        const result = await fetch("/admin/api/plugins/" + encodeURIComponent(pluginId) + "/" + action, { method: "POST" }).then((res) => res.json());
        $("plugin-status").textContent = result.ok ? pluginId + " " + action + "d." : "Switch failed: " + (result.error || "unknown error");
        await refreshPlugins();
      });
      $("tool-view").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("view"), {}));
      $("tool-search").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("search"), { content: $("toolSearchContent").value, direction: $("toolSearchDirection").value || "backward" }));
      $("tool-send").addEventListener("click", async () => runMessagingTool(activeMessagingToolPath("send"), { type: $("toolSendType").value || "message", content: $("toolSendContent").value }));
      function activeMessagingToolPath(action) {
        const active = document.querySelector("[data-channel-tab].active")?.dataset.channelTab;
        return active === "wechat" ? "wechat-" + action : action;
      }
      async function sendTest(path, body, label) {
        const result = await fetch("/admin/api/plugins/feishu/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("send-test-status").textContent = result.ok ? label + " test sent." : label + " test failed: " + (result.error || "unknown error");
        await refreshLogs();
        await refreshLLMRequests();
      }
      async function runMessagingTool(path, body) {
        const result = await fetch("/admin/api/tools/messaging/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((res) => res.json());
        $("tool-result").textContent = result.content || result.error || "";
        await refreshLogs();
        await refreshLLMRequests();
      }
      refresh();
    </script>
  </body>
</html>`;
}
