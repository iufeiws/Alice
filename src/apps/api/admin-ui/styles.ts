export function renderAdminStyles(): string {
  return `      :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
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
      .shell-outfit-images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
      .shell-image-box { min-width: 0; }
      .shell-on-body-box { border: 1px solid #d7dce3; border-radius: 6px; padding: 10px; background: #f8fafc; }
      .shell-on-body-box button { margin-top: 10px; }
      .shell-on-body-box label { margin-top: 10px; }
      .shell-on-body-status { min-height: 16px; margin-top: 8px; }
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
      .tts-config-layout { display: grid; gap: 16px; }
      .tts-provider-panels { display: grid; gap: 12px; margin-top: 14px; }
      .tts-provider-panel { border-top: 1px solid #e4e7eb; padding-top: 12px; }
      .tts-provider-panel h2 { margin-bottom: 8px; }
      details.plugin-config-section summary { cursor: pointer; font-weight: 900; }
      details.plugin-config-section summary h2 { display: inline; margin: 0; }
      #main-initiated-behaviors { max-width: 100%; overflow: hidden; }
      .behavior-layout { width: 100%; max-width: 100%; min-width: 0; display: grid; gap: 16px; align-items: start; }
      .behavior-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
      .behavior-toolbar h2 { margin: 0 0 4px; }
      .behavior-toolbar label { margin: 0; min-width: 220px; }
      .behavior-toolbar-actions { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .behavior-toolbar-actions label { min-width: 120px; }
      .behavior-toolbar-actions input { min-width: 180px; }
      .behavior-table-wrap { width: 100%; max-width: 100%; min-width: 0; overflow: hidden; border: 1px solid #d7dce3; border-radius: 8px; }
      .behavior-table { --column-indent: clamp(6px, 0.9vw, 14px); width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
      .behavior-table th, .behavior-table td { border-bottom: 1px solid #e4e7eb; padding: 8px var(--column-indent); text-align: left; vertical-align: middle; overflow-wrap: anywhere; word-break: break-word; }
      .behavior-table th { color: #667085; font-weight: 800; background: #f8fafc; }
      .behavior-table tr:last-child td { border-bottom: 0; }
      .behavior-table button { margin: 0; padding: 6px 9px; max-width: 100%; white-space: normal; }
      .behavior-table-actions { display: flex; gap: 6px; flex-wrap: wrap; }
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
        .prompt-preview-head, .plugin-toolbar, .plugin-config-head, .plugin-section-head, .behavior-toolbar, .behavior-toolbar-actions, .behavior-config-head, .shell-head, .shell-option summary, .shell-group summary { align-items: stretch; flex-wrap: wrap; }
        .plugin-toolbar label, .behavior-toolbar label, .behavior-toolbar-actions label, .usage-controls label, .memory-controls label { min-width: min(100%, 180px); flex: 1 1 180px; }
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
        .usage-controls, .memory-controls, .prompt-actions, .tool-preview-actions, .behavior-toolbar-actions, .behavior-config-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
        .prompt-actions button, .tool-preview-actions button, .behavior-toolbar-actions button, .behavior-config-actions button { margin: 0; width: 100%; }
        .plugin-card { min-height: 0; }
        .plugin-card-head { grid-template-columns: 34px minmax(0, 1fr); }
        .plugin-icon { width: 34px; height: 34px; }
        .plugin-switch { width: auto; }
        .shell-image-preview { max-width: 100%; }
        .terminal-actions { margin-left: 0; }
      }`;
}
