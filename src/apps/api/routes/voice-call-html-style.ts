import type { VoiceCallConfigResponse } from "./voice-call-contract.js";

export function renderVoiceCallStyle(config: VoiceCallConfigResponse): string {
  return `    :root {
      --call-bg: #151311;
      --call-panel: #211d19;
      --call-panel-2: #2a241e;
      --call-gold: #d7aa77;
      --call-gold-muted: #8b6847;
      --call-red: #d94b4b;
      --call-red-dark: #7f1f1f;
      --call-text: #f0d0aa;
      --call-text-muted: #b8926b;
      --call-shadow: rgba(0, 0, 0, 0.38);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; background: var(--call-bg); color: var(--call-text); overflow: hidden; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      overflow-x: hidden;
      display: grid;
      place-items: start center;
    }
    body.voice-call-popup-window {
      place-items: start start;
    }
    button { font: inherit; }
    .voice-call-app {
      position: relative;
      width: var(--surface-width, min(100vw, calc(100dvh * 9 / 16), ${config.ui.maxWidthPx}px));
      height: var(--surface-height, min(100dvh, calc(100vw * 16 / 9), ${Math.round(config.ui.maxWidthPx * 16 / 9)}px));
      aspect-ratio: 9 / 16;
      margin: 0 auto;
      display: grid;
      grid-template-rows: 64px auto 68px minmax(84px, 1fr) 104px;
      padding: max(10px, env(safe-area-inset-top)) 18px max(10px, env(safe-area-inset-bottom));
      background:
        radial-gradient(circle at 50% 8%, rgba(215, 170, 119, 0.12), transparent 36%),
        linear-gradient(180deg, #191410 0%, #0f0d0c 100%);
    }
    .voice-call-app.portrait-collapsed {
      width: var(--surface-collapsed-width, var(--surface-width, min(100vw, calc(100dvh * 9 / 16), ${config.ui.maxWidthPx}px)));
      height: var(--surface-collapsed-height, min(100dvh, 360px));
      aspect-ratio: 4 / 3;
      align-self: start;
      grid-template-rows: 44px var(--collapsed-portrait-size, 96px) minmax(48px, 1fr) 64px;
      padding: 8px 12px;
    }
    .dial-screen {
      position: absolute;
      inset: 0;
      z-index: 5;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto minmax(0, 1fr);
      justify-items: center;
      align-items: center;
      padding: max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom));
      background:
        radial-gradient(circle at 50% 34%, rgba(215, 170, 119, 0.14), transparent 34%),
        linear-gradient(180deg, #191410 0%, #0f0d0c 100%);
    }
    .dial-content {
      grid-row: 2;
      width: min(100%, 300px);
      display: grid;
      justify-items: center;
      gap: 18px;
      text-align: center;
    }
    .dial-actions {
      display: grid;
      grid-template-columns: 1fr 48px;
      gap: 10px;
      width: min(100%, 220px);
    }
    .dial-title {
      margin: 0;
      font-size: 24px;
      line-height: 1.16;
      font-weight: 600;
      color: var(--call-text);
    }
    .dial-subtitle {
      min-height: 20px;
      margin: 0;
      font-size: 14px;
      line-height: 1.5;
      color: var(--call-text-muted);
    }
    [data-phase="connected"] .dial-screen,
    [data-phase="reconnecting"] .dial-screen,
    [data-phase="ended"] .dial-screen,
    [data-phase="error"] .dial-screen { display: none; }
    .app-bar {
      grid-row: 1;
      grid-column: 1;
      min-height: 64px;
      display: grid;
      grid-template-columns: 48px 1fr 48px;
      align-items: center;
      gap: 8px;
    }
    .voice-call-app.portrait-collapsed .app-bar {
      min-height: 44px;
    }
    .icon-button, .control-button, .call-button {
      border: 1px solid rgba(215, 170, 119, 0.42);
      color: var(--call-text);
      background: rgba(33, 29, 25, 0.88);
      box-shadow: 0 12px 32px var(--call-shadow);
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }
    .call-button:disabled {
      cursor: default;
      opacity: 0.62;
    }
    .icon-button {
      width: 44px;
      height: 44px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .voice-call-app.portrait-collapsed .icon-button {
      width: 40px;
      height: 40px;
    }
    .icon-button svg, .control-button svg, .call-button svg { width: 21px; height: 21px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .voice-call-app.portrait-collapsed .icon-button svg { width: 19px; height: 19px; }
    .status-block { text-align: center; min-width: 0; }
    .status-title { display: inline-flex; align-items: center; gap: 8px; font-size: 16px; line-height: 1.2; color: var(--call-text); }
    .status-subtitle { margin-top: 4px; font-size: 12px; line-height: 1.2; color: var(--call-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--call-red); box-shadow: 0 0 16px rgba(217, 75, 75, 0.9); display: none; }
    [data-phase="connected"] .live-dot, [data-phase="reconnecting"] .live-dot { display: inline-block; }
    .character-stage {
      grid-row: 2;
      grid-column: 1;
      position: relative;
      min-height: 0;
      display: grid;
      align-content: start;
      justify-items: center;
      padding: 0;
    }
    .portrait-frame {
      width: min(100%, 64dvh, ${config.ui.maxWidthPx - 36}px);
      aspect-ratio: 1 / 1;
      max-height: 100%;
      position: relative;
      margin: 0;
      overflow: hidden;
      border: 1px solid rgba(215, 170, 119, 0.58);
      background: var(--call-panel);
      box-shadow: 0 22px 54px rgba(0, 0, 0, 0.46);
    }
    .voice-call-app.portrait-collapsed .portrait-frame {
      width: var(--collapsed-portrait-size, 112px);
      height: var(--collapsed-portrait-size, 112px);
      min-width: var(--collapsed-portrait-size, 112px);
      min-height: var(--collapsed-portrait-size, 112px);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.34);
    }
    .portrait-frame::before, .portrait-frame::after {
      content: "";
      position: absolute;
      inset: 10px;
      border: 1px solid rgba(215, 170, 119, 0.28);
      pointer-events: none;
    }
    .portrait-frame::after {
      inset: auto 14px 14px;
      height: 20%;
      border-top: 0;
      opacity: 0.5;
    }
    .portrait {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      filter: saturate(0.92) contrast(1.04);
    }
    [data-phase="idle"] .portrait, [data-phase="ended"] .portrait { filter: saturate(0.72) brightness(0.82); }
    .call-button {
      min-width: 132px;
      height: 48px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      padding: 0 18px;
      background: rgba(42, 36, 30, 0.92);
    }
    .popup-button {
      width: 48px;
      min-width: 0;
      padding: 0;
    }
    .preload-status { min-height: 18px; font-size: 12px; color: var(--call-text-muted); text-shadow: 0 1px 8px #000; }
    .wave-panel {
      grid-row: 3;
      grid-column: 1;
      height: 68px;
      display: grid;
      align-items: center;
      padding: 0;
      margin: 0;
    }
    .voice-call-app.portrait-collapsed .wave-panel {
      grid-row: 3;
      height: 100%;
      align-self: stretch;
      opacity: 0.32;
      z-index: 0;
      pointer-events: none;
    }
    #waveform {
      width: 100%;
      height: 58px;
      display: block;
    }
    .voice-call-app.portrait-collapsed #waveform {
      height: 100%;
    }
    .controls {
      grid-row: 5;
      grid-column: 1;
      height: 104px;
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr) 58px;
      align-items: center;
      gap: 10px;
      padding-top: 10px;
    }
    .voice-call-app.portrait-collapsed .controls {
      grid-row: 4;
    }
    .control-wrap { display: grid; justify-items: center; min-width: 0; }
    .control-button {
      width: 58px;
      height: 58px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .center-control {
      width: 100%;
      height: 58px;
      border-radius: 6px;
      border: 1px solid rgba(215, 170, 119, 0.38);
      color: var(--call-text);
      background: rgba(33, 29, 25, 0.78);
      box-shadow: 0 12px 32px var(--call-shadow);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      overflow: visible;
    }
    #holdTalkButton, #holdTalkButton * {
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
      touch-action: none;
    }
    .center-control.active { display: flex; }
    .center-control svg {
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      overflow: visible;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .control-button.danger {
      background: var(--call-red-dark);
      border-color: rgba(217, 75, 75, 0.8);
      color: #ffd8ca;
    }
    .control-button.selected, .center-control.selected, .center-control.pressed {
      background: rgba(215, 170, 119, 0.2);
      border-color: rgba(215, 170, 119, 0.82);
      color: #ffe1bd;
    }
    .control-label { display: none; }
    .message-input {
      width: 100%;
      min-width: 0;
      height: 58px;
      resize: none;
      border: 0;
      padding: 17px 12px 8px;
      color: var(--call-text);
      background: transparent;
      outline: none;
      font: inherit;
      font-size: 16px;
      line-height: 1.35;
      overflow-y: auto;
    }
    .message-input::placeholder { color: rgba(184, 146, 107, 0.76); }
    .message-input:focus { outline: none; }
    .transcript-panel {
      grid-row: 4;
      grid-column: 1;
      min-height: 0;
      display: grid;
      align-content: end;
      gap: 8px;
      padding: 12px 0 6px;
      overflow: hidden;
    }
    .voice-call-app.portrait-collapsed .transcript-panel {
      grid-row: 3;
      position: relative;
      z-index: 1;
      align-content: center;
      gap: 18px;
      padding: 4px 0;
    }
    .transcript-line {
      min-height: 22px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--call-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .transcript-line.alice {
      color: var(--call-text);
      display: grid;
      gap: 4px;
    }
    .transcript-line.alice .previous {
      color: var(--call-text-muted);
    }
    .transcript-line.alice .previous,
    .transcript-line.alice .current {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .transcript-line.user { text-align: right; color: #e1b785; }
    .overlay {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(10, 8, 7, 0.72);
      z-index: 10;
    }
    .overlay[aria-hidden="false"] { display: flex; }
    .dialog {
      width: min(100%, 360px);
      border: 1px solid rgba(215, 170, 119, 0.34);
      background: #1f1a16;
      padding: 18px;
      box-shadow: 0 26px 64px rgba(0, 0, 0, 0.5);
    }
    .dialog h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.25; }
    .dialog p { margin: 0 0 16px; color: var(--call-text-muted); font-size: 14px; line-height: 1.55; }
    .dialog-actions { display: flex; gap: 10px; justify-content: flex-end; }
    .dialog-actions button {
      min-height: 40px;
      border: 1px solid rgba(215, 170, 119, 0.45);
      background: var(--call-panel-2);
      color: var(--call-text);
      padding: 0 14px;
      border-radius: 6px;
    }
    .sr-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .voice-call-app.desktop-popup .dial-actions { grid-template-columns: 1fr; }
    .voice-call-app.desktop-popup #openPopupButton { display: none; }
    @media (max-height: 680px) {
      .voice-call-app { grid-template-rows: 56px auto 58px minmax(64px, 1fr) 92px; padding-inline: 14px; }
      .app-bar { min-height: 56px; }
      .controls { height: 92px; padding-top: 8px; }
      .control-button { width: 52px; height: 52px; }
      .center-control { height: 52px; }
      .portrait-frame { width: min(100%, 54dvh, ${config.ui.maxWidthPx - 28}px); }
      .voice-call-app.portrait-collapsed {
        grid-template-rows: 44px var(--collapsed-portrait-size, 88px) minmax(42px, 1fr) 60px;
        padding: 6px 10px;
      }
      .voice-call-app.portrait-collapsed .portrait-frame { width: var(--collapsed-portrait-size, 96px); height: var(--collapsed-portrait-size, 96px); }
      .voice-call-app.portrait-collapsed .controls { height: 60px; padding-top: 4px; }
      .voice-call-app.portrait-collapsed .control-button { width: 48px; height: 48px; }
      .voice-call-app.portrait-collapsed .center-control { height: 48px; }
    }`;
}
