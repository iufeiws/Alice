import { defaultVoiceCallConfigResponse, voiceCallRoutes } from "./voice-call-contract.js";

export function renderVoiceCallHtml(): string {
  const config = defaultVoiceCallConfigResponse();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Alice Voice Call</title>
  <style>
    :root {
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
    .transcript-line.alice { color: var(--call-text); }
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
    }
  </style>
</head>
<body>
  <main class="voice-call-app" data-phase="idle">
    <section class="dial-screen" aria-label="拨打 Alice">
      <div class="dial-content">
        <p class="dial-title">准备通话</p>
        <p class="dial-subtitle" id="preloadStatus">点击拨打后开始</p>
        <div class="dial-actions">
          <button class="call-button" type="button" id="callButton" aria-label="拨打">
            <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.32 1.77.59 2.61a2 2 0 0 1-.45 2.11L8 9.7a16 16 0 0 0 6.3 6.3l1.26-1.25a2 2 0 0 1 2.11-.45c.84.27 1.71.47 2.61.59A2 2 0 0 1 22 16.92z"></path></svg>
            <span>拨打</span>
          </button>
          <button class="call-button popup-button" type="button" id="openPopupButton" aria-label="打开桌面小窗">
            <svg viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2"></path><path d="M16 4h2a2 2 0 0 1 2 2v2"></path><path d="M20 16v2a2 2 0 0 1-2 2h-2"></path><path d="M8 20H6a2 2 0 0 1-2-2v-2"></path><path d="M9 9h6v6H9z"></path></svg>
          </button>
        </div>
      </div>
    </section>

    <header class="app-bar">
      <button class="icon-button" type="button" id="topHangupButton" aria-label="挂断">
        <svg viewBox="0 0 24 24"><path d="M10.68 13.31a16 16 0 0 0 2.64 0"></path><path d="m5.1 17.2 2.1-2.1a2 2 0 0 0 .54-1.83l-.32-1.44a12.7 12.7 0 0 1 9.16 0l-.32 1.44a2 2 0 0 0 .54 1.83l2.1 2.1a2 2 0 0 0 2.82 0l.68-.68a2 2 0 0 0 .21-2.6C20.9 10.4 16.72 8 12 8s-8.9 2.4-11.11 5.92a2 2 0 0 0 .21 2.6l.68.68a2 2 0 0 0 2.82 0z"></path></svg>
      </button>
      <div class="status-block" aria-live="polite">
        <div class="status-title"><span class="live-dot"></span><span id="statusTitle">准备通话</span></div>
        <div class="status-subtitle" id="statusSubtitle">点击拨打后开始</div>
      </div>
      <button class="icon-button" type="button" id="portraitCollapseButton" aria-label="收缩画面">
        <svg viewBox="0 0 24 24"><path d="M8 3v5H3"></path><path d="M16 3v5h5"></path><path d="M8 21v-5H3"></path><path d="M16 21v-5h5"></path></svg>
      </button>
    </header>

    <section class="character-stage" aria-label="Alice 通话形象">
      <figure class="portrait-frame">
        <img class="portrait" src="${config.ui.portraitUrl}" alt="Alice" draggable="false">
      </figure>
    </section>

    <section class="wave-panel" aria-label="语音活动">
      <canvas id="waveform" width="680" height="116"></canvas>
    </section>

    <section class="transcript-panel" aria-label="实时对话">
      <div class="transcript-line alice" id="aliceTranscript">Alice 的实时回复会显示在这里</div>
      <div class="transcript-line user" id="userTranscript">你的实时输入会显示在这里</div>
    </section>

    <nav class="controls" aria-label="通话控制">
      <div class="control-wrap">
        <button class="control-button" type="button" id="modeButton" aria-label="切换输入模式">
          <svg viewBox="0 0 24 24"><path d="M4 7h16"></path><path d="M4 12h16"></path><path d="M4 17h16"></path></svg>
        </button>
      </div>
      <div class="center-control active" id="textControl">
        <textarea class="message-input" id="messageInput" inputmode="text" autocomplete="off" rows="1" placeholder="输入文字" aria-label="文字输入"></textarea>
      </div>
      <button class="center-control" type="button" id="holdTalkButton" aria-label="长按说话">
        <svg viewBox="0 0 24 24"><path d="M8 3h7a2 2 0 0 1 2 2v16H6V5a2 2 0 0 1 2-2z"></path><path d="M10 3V1"></path><path d="M13 7h1"></path><path d="M9 11h5"></path><path d="M9 15h5"></path><path d="M9 19h5"></path><path d="M18 8h2v7h-2"></path></svg>
      </button>
      <button class="center-control" type="button" id="realtimeMuteButton" aria-label="静音">
        <svg viewBox="0 0 24 24"><path d="M9 9v3a3 3 0 0 0 5 2.24"></path><path d="M15 9V5a3 3 0 0 0-5.12-2.12"></path><path d="M19 10v2a7 7 0 0 1-1.3 4.06"></path><path d="M5 10v2a7 7 0 0 0 9.75 6.44"></path><path d="M12 19v3"></path><path d="M4 4l16 16"></path></svg>
      </button>
      <div class="control-wrap">
        <button class="control-button" type="button" id="waitButton" aria-label="等待">
          <svg viewBox="0 0 24 24"><path d="M8 5v14"></path><path d="M16 5v14"></path></svg>
        </button>
      </div>
    </nav>
    <div class="sr-status" id="srStatus" aria-live="polite"></div>
  </main>

  <div class="overlay" id="overlay" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="overlayTitle">
    <div class="dialog">
      <h2 id="overlayTitle">需要麦克风权限</h2>
      <p id="overlayMessage">请允许浏览器访问麦克风后继续。</p>
      <div class="dialog-actions">
        <button type="button" id="overlayExit">退出</button>
        <button type="button" id="overlayRetry">重试</button>
      </div>
    </div>
  </div>

  <audio id="remoteAudio" autoplay playsinline></audio>

  <script type="module">
    const routes = ${JSON.stringify(voiceCallRoutes)};
    const initialIceServers = ${JSON.stringify(config.iceServers)};
    const inboundAudio = ${JSON.stringify(config.inboundAudio)};
    const app = document.querySelector(".voice-call-app");
    const statusTitle = document.getElementById("statusTitle");
    const statusSubtitle = document.getElementById("statusSubtitle");
    const preloadStatus = document.getElementById("preloadStatus");
    const callButton = document.getElementById("callButton");
    const openPopupButton = document.getElementById("openPopupButton");
    const topHangupButton = document.getElementById("topHangupButton");
    const portraitCollapseButton = document.getElementById("portraitCollapseButton");
    const modeButton = document.getElementById("modeButton");
    const waitButton = document.getElementById("waitButton");
    const messageInput = document.getElementById("messageInput");
    const textControl = document.getElementById("textControl");
    const holdTalkButton = document.getElementById("holdTalkButton");
    const aliceTranscript = document.getElementById("aliceTranscript");
    const userTranscript = document.getElementById("userTranscript");
    const overlay = document.getElementById("overlay");
    const overlayTitle = document.getElementById("overlayTitle");
    const overlayMessage = document.getElementById("overlayMessage");
    const overlayRetry = document.getElementById("overlayRetry");
    const overlayExit = document.getElementById("overlayExit");
    const srStatus = document.getElementById("srStatus");
    const remoteAudio = document.getElementById("remoteAudio");
    const canvas = document.getElementById("waveform");
    const ctx = canvas.getContext("2d");

    let phase = "idle";
    let socket;
    let peer;
    let localStream;
    let localAnalyser;
    let remoteAnalyser;
    let audioContext;
    let pcmSource;
    let pcmProcessor;
    let pcmSink;
    let pcmWorkletUrl;
    let speechActive = false;
    let connectedAt = 0;
    let elapsedTimer;
    let animationFrame;
    let pendingRemoteIce = [];
    let waiting = false;
    let inputMode = "text";
    let textInputInterruptSent = false;
    let remoteStream;
    let popupResizeTimer;
    let pageHolding = false;
    let stableViewportWidth = 0;
    let stableViewportHeight = 0;
    let popupShouldCenter = true;
    const inputModes = ["text", "hold_to_talk"];
    const popupWidth = 420;
    const popupHeight = 747;
    const popupMinContentDelta = 3;
    const popupResizeIntervalMs = 5000;
    const modeIcons = {
      text: '<svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M8 9h.01"></path><path d="M12 9h.01"></path><path d="M16 9h.01"></path><path d="M8 13h8"></path><path d="M9 16h6"></path></svg>',
      hold_to_talk: '<svg viewBox="0 0 24 24"><path d="M8 3h7a2 2 0 0 1 2 2v16H6V5a2 2 0 0 1 2-2z"></path><path d="M10 3V1"></path><path d="M13 7h1"></path><path d="M9 11h5"></path><path d="M9 15h5"></path><path d="M9 19h5"></path><path d="M18 8h2v7h-2"></path></svg>'
    };
    const modeNames = {
      text: "文字输入",
      hold_to_talk: "长按录音"
    };

    const phaseText = {
      idle: ["准备通话", "点击拨打后开始"],
      preloading: ["准备中", "正在加载语音服务"],
      permission_required: ["需要麦克风权限", "点击允许后继续"],
      connecting: ["连接中", "正在建立通话"],
      ringing: ["呼叫中", "等待 Alice 接听"],
      connected: ["通话中", "00:00"],
      reconnecting: ["重连中", "保持页面打开"],
      ended: ["已挂断", "通话已结束"],
      error: ["通话异常", "请重试"]
    };

    callButton.addEventListener("click", () => void startCall());
    openPopupButton.addEventListener("click", openDesktopPopup);
    overlayRetry.addEventListener("click", () => {
      hideOverlay();
      void startCall();
    });
    overlayExit.addEventListener("click", () => {
      hideOverlay();
      endCall("exit");
    });
    topHangupButton.addEventListener("click", () => endCall("manual"));
    portraitCollapseButton.addEventListener("click", togglePortraitCollapsed);
    modeButton.addEventListener("click", cycleInputMode);
    waitButton.addEventListener("click", toggleWait);
    holdTalkButton.addEventListener("pointerdown", startHoldToTalk);
    holdTalkButton.addEventListener("pointerup", stopHoldToTalk);
    holdTalkButton.addEventListener("pointercancel", stopHoldToTalk);
    holdTalkButton.addEventListener("pointerleave", stopHoldToTalk);
    holdTalkButton.addEventListener("contextmenu", (event) => event.preventDefault());
    messageInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      sendTextInput();
    });
    messageInput.addEventListener("focus", keepSurfaceAnchored);
    messageInput.addEventListener("input", handleTextInputChange);
    window.visualViewport?.addEventListener("resize", keepSurfaceAnchored);
    window.addEventListener("resize", configureSurfaceSize);
    window.addEventListener("pagehide", () => holdCall("pagehide"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") holdCall("visibility");
    });
    configureSurfaceSize();
    configureDesktopPopup();
    applyInputMode();

    async function startCall() {
      try {
        if (phase !== "idle" && phase !== "ended" && phase !== "error") return;
        hideOverlay();
        setPhase("preloading", "正在连接后台");
        callButton.disabled = true;
        const config = await loadConfig();
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        });
        ensureAudioAnalyser(localStream, "local");
        await startPcmStreaming(localStream);
        peer = new RTCPeerConnection({ iceServers: config.iceServers || initialIceServers });
        peer.addTransceiver("audio", { direction: "recvonly" });
        peer.addEventListener("track", (event) => {
          remoteStream = event.streams[0] || new MediaStream([event.track]);
          remoteAudio.srcObject = remoteStream;
          ensureAudioAnalyser(remoteStream, "remote");
          void remoteAudio.play().catch(() => showError("远端音频播放失败", "点击页面后继续播放。"));
        });
        peer.addEventListener("connectionstatechange", () => {
          if (peer.connectionState === "connected") setPreConnectedPhase("connecting", "链路已建立，等待首段音频");
          if (peer.connectionState === "connecting") setPreConnectedPhase("connecting");
          if (peer.connectionState === "disconnected") setPhase("reconnecting");
          if (peer.connectionState === "failed") showError("通话连接失败", "WebRTC 建立失败，请重试。");
          if (peer.connectionState === "closed") setPhase("ended");
        });
        peer.addEventListener("icecandidate", (event) => {
          if (event.candidate && socket?.readyState === WebSocket.OPEN) {
            sendSignal({ type: "ice", candidate: event.candidate });
          }
        });
        await openSignaling(config.routes?.signaling || routes.signaling);
        await unlockAudio();
      } catch (error) {
        stopLocalAudio();
        if (error && error.name === "NotAllowedError") {
          callButton.disabled = false;
          setPhase("permission_required");
          showError("需要麦克风权限", "请在浏览器设置中允许麦克风访问。");
          return;
        }
        showError("通话异常", error?.message || String(error));
      }
    }

    async function loadConfig() {
      const response = await fetch(routes.config, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("无法加载通话配置");
      return await response.json();
    }

    async function openSignaling(signalingPath) {
      const wsUrl = new URL(signalingPath, window.location.href);
      wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.searchParams.set("callId", crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
      socket = new WebSocket(wsUrl);
      socket.addEventListener("open", async () => {
        setPhase("ringing");
        sendSignal({ type: "hello", locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        sendSignal({ type: "offer", sdp: offer.sdp });
      });
      socket.addEventListener("message", (event) => void handleServerSignal(JSON.parse(event.data)));
      socket.addEventListener("error", () => showError("无法连接通话服务", "信令连接失败。"));
      socket.addEventListener("close", () => {
        if (pageHolding) return;
        if (phase !== "ended" && phase !== "error") setPhase("ended");
      });
    }

    async function handleServerSignal(message) {
      if (message.type === "answer") {
        await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
        for (const candidate of pendingRemoteIce.splice(0)) {
          await peer.addIceCandidate(candidate).catch(() => {});
        }
        return;
      }
      if (message.type === "ice") {
        if (peer?.remoteDescription) await peer.addIceCandidate(message.candidate).catch(() => {});
        else pendingRemoteIce.push(message.candidate);
        return;
      }
      if (message.type === "status") {
        applyBackendStatus(message.state, message.detail);
        return;
      }
      if (message.type === "error") {
        showError("通话异常", message.message || message.error);
      }
    }

    function applyBackendStatus(state, detail) {
      if (state === "asr.preflight.started") setPreConnectedPhase("preloading", "正在检查语音识别");
      if (state === "asr.preflight.ready") setPreConnectedPhase("preloading", "语音识别可用");
      if (state === "tts.prepare.started") setPreConnectedPhase("preloading", "正在准备语音合成");
      if (state === "tts.prepare.ready") setPreConnectedPhase("preloading", "语音合成可用");
      if (state === "asr.preflight.failed") showError("语音识别不可用", detail || "ASR 测试失败。");
      if (state === "webrtc.answer.created") setPreConnectedPhase("connecting");
      if (state === "webrtc.connection" && detail === "connected") setPreConnectedPhase("connecting", "链路已建立，等待首段音频");
      if (state === "tts.queue.waiting") setPreConnectedPhase("connecting", "正在准备 Alice 的第一段声音");
      if (state === "tts.queue.ready") setPreConnectedPhase("connecting", "首段音频准备完毕");
      if (state === "voice_call.connected") markConnected();
      if (state === "voice_call.playback_text_cache" && detail) aliceTranscript.textContent = detail;
      if (state === "tts.failed") showError("语音生成失败", detail || "TTS 服务异常。");
    }

    function setPreConnectedPhase(nextPhase, detail) {
      if (phase === "connected" || phase === "reconnecting" || phase === "ended" || phase === "error") return;
      setPhase(nextPhase, detail);
    }

    function markConnected() {
      if (phase === "connected") return;
      connectedAt = Date.now();
      setPhase("connected");
      clearInterval(elapsedTimer);
      elapsedTimer = setInterval(updateElapsed, 1000);
      updateElapsed();
    }

    function updateElapsed() {
      const seconds = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
      const minutesText = String(Math.floor(seconds / 60)).padStart(2, "0");
      const secondsText = String(seconds % 60).padStart(2, "0");
      statusSubtitle.textContent = minutesText + ":" + secondsText;
    }

    function setPhase(nextPhase, detail) {
      phase = nextPhase;
      app.dataset.phase = nextPhase;
      const text = phaseText[nextPhase] || phaseText.error;
      statusTitle.textContent = text[0];
      statusSubtitle.textContent = detail || text[1];
      if (nextPhase === "idle" || nextPhase === "preloading" || nextPhase === "connecting" || nextPhase === "ringing" || nextPhase === "permission_required") {
        preloadStatus.textContent = detail || text[1];
      }
      srStatus.textContent = text[0] + " " + (detail || text[1]);
    }

    function showError(title, message) {
      setPhase("error", message);
      callButton.disabled = false;
      overlayTitle.textContent = title;
      overlayMessage.textContent = message;
      overlay.setAttribute("aria-hidden", "false");
    }

    function hideOverlay() {
      overlay.setAttribute("aria-hidden", "true");
    }

    function sendSignal(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    }

    function endCall(reason) {
      sendSignal({ type: "hangup", reason });
      socket?.close();
      peer?.close();
      stopLocalAudio();
      clearInterval(elapsedTimer);
      callButton.disabled = false;
      setPhase("ended");
    }

    function holdCall(reason) {
      if (phase === "idle" || phase === "ended" || phase === "error") return;
      pageHolding = true;
      sendSignal({ type: "hold", reason });
      stopTalking();
      for (const track of localStream?.getAudioTracks?.() || []) track.enabled = false;
      clearInterval(elapsedTimer);
      setPhase("reconnecting", "页面已暂停，返回后继续");
    }

    function toggleWait() {
      waiting = !waiting;
      waitButton.classList.toggle("selected", waiting);
      waitButton.setAttribute("aria-label", waiting ? "取消等待" : "等待");
      sendSignal({ type: "wait", active: waiting });
    }

    function sendTextInput() {
      const payloadText = normalizeTypedInputText(messageInput.value) || "-已撤回-";
      sendSignal({ type: "text-input", text: payloadText });
      userTranscript.textContent = payloadText;
      messageInput.value = "";
      textInputInterruptSent = false;
      statusSubtitle.textContent = "已发送文字";
    }

    function normalizeTypedInputText(text) {
      return String(text || "").replace(/[\\u0000-\\u001F\\u007F\\u200B-\\u200D\\u2060\\uFEFF\\uFFFC]/g, "").trim();
    }

    function handleTextInputChange() {
      keepSurfaceAnchored();
      const text = normalizeTypedInputText(messageInput.value);
      if (text.length <= 1) {
        return;
      }
      if (textInputInterruptSent) return;
      textInputInterruptSent = true;
      sendSignal({ type: "interrupt", reason: "manual" });
    }

    function cycleInputMode() {
      const index = inputModes.indexOf(inputMode);
      inputMode = inputModes[(index + 1) % inputModes.length];
      applyInputMode();
      sendSignal({ type: "input-mode", mode: inputMode });
    }

    function applyInputMode() {
      textControl.classList.toggle("active", inputMode === "text");
      holdTalkButton.classList.toggle("active", inputMode === "hold_to_talk");
      const nextMode = inputModes[(inputModes.indexOf(inputMode) + 1) % inputModes.length];
      modeButton.innerHTML = modeIcons[nextMode];
      modeButton.setAttribute("aria-label", "切换到" + modeNames[nextMode]);
      if (inputMode === "text") messageInput.focus({ preventScroll: true });
    }

    function startHoldToTalk(event) {
      if (inputMode !== "hold_to_talk") return;
      event.preventDefault();
      startTalking();
      holdTalkButton.classList.add("pressed");
      userTranscript.textContent = "正在录音";
    }

    function stopHoldToTalk() {
      if (inputMode !== "hold_to_talk") return;
      stopTalking();
      holdTalkButton.classList.remove("pressed");
      userTranscript.textContent = "录音已结束";
    }

    function startTalking() {
      if (speechActive || !socket || socket.readyState !== WebSocket.OPEN) return;
      void audioContext?.resume?.();
      speechActive = true;
      sendSignal({ type: "hold-to-talk", active: true });
    }

    function stopTalking() {
      if (!speechActive) return;
      speechActive = false;
      sendSignal({ type: "hold-to-talk", active: false });
    }

    function togglePortraitCollapsed() {
      const collapsed = !app.classList.contains("portrait-collapsed");
      app.classList.toggle("portrait-collapsed", collapsed);
      portraitCollapseButton.setAttribute("aria-label", collapsed ? "展开画面" : "收缩画面");
      configureSurfaceSize();
      fitDesktopPopup(false);
      keepSurfaceAnchored();
    }

    function configureSurfaceSize() {
      const popupMode = new URLSearchParams(window.location.search).get("window") === "1";
      if (popupMode) {
        const collapsedWidth = popupWidth;
        const collapsedHeight = Math.round(popupWidth * 3 / 4);
        const fixedCollapsedRows = 44 + 48 + 64 + 16;
        app.style.setProperty("--surface-width", popupWidth + "px");
        app.style.setProperty("--surface-height", popupHeight + "px");
        app.style.setProperty("--surface-collapsed-width", collapsedWidth + "px");
        app.style.setProperty("--surface-collapsed-height", collapsedHeight + "px");
        app.style.setProperty("--collapsed-portrait-size", Math.max(64, Math.min(88, Math.floor(collapsedHeight - fixedCollapsedRows))) + "px");
        return;
      }
      const desktop = window.matchMedia?.("(pointer: fine)").matches && screen.availWidth >= 900;
      if (!desktop) {
        stableViewportWidth = Math.max(stableViewportWidth, window.innerWidth);
        stableViewportHeight = Math.max(stableViewportHeight, window.innerHeight);
        const viewportWidth = Math.max(1, stableViewportWidth);
        const viewportHeight = Math.max(1, stableViewportHeight);
        const expandedWidth = Math.min(viewportWidth, Math.floor(viewportHeight * 9 / 16));
        const expandedHeight = Math.min(viewportHeight, Math.floor(expandedWidth * 16 / 9));
        const collapsedWidth = expandedWidth;
        const collapsedHeight = Math.min(viewportHeight, Math.floor(collapsedWidth * 3 / 4));
        app.style.setProperty("--surface-width", expandedWidth + "px");
        app.style.setProperty("--surface-height", expandedHeight + "px");
        app.style.setProperty("--surface-collapsed-width", collapsedWidth + "px");
        app.style.setProperty("--surface-collapsed-height", collapsedHeight + "px");
        const fixedCollapsedRows = 44 + 48 + 64 + 16;
        const mobileCollapsedSize = Math.max(56, Math.min(88, Math.floor(collapsedHeight - fixedCollapsedRows)));
        app.style.setProperty("--collapsed-portrait-size", mobileCollapsedSize + "px");
        return;
      }
      const expandedHeight = Math.min(860, Math.floor(screen.availHeight * 0.86));
      const expandedWidth = Math.round(expandedHeight * 9 / 16);
      const collapsedWidth = expandedWidth;
      const collapsedHeight = Math.min(Math.floor(expandedWidth * 3 / 4), Math.floor(screen.availHeight * 0.58));
      app.style.setProperty("--surface-width", expandedWidth + "px");
      app.style.setProperty("--surface-height", expandedHeight + "px");
      app.style.setProperty("--surface-collapsed-width", collapsedWidth + "px");
      app.style.setProperty("--surface-collapsed-height", collapsedHeight + "px");
      const fixedCollapsedRows = 44 + 48 + 64 + 16;
      app.style.setProperty("--collapsed-portrait-size", Math.max(64, Math.min(96, Math.floor(collapsedHeight - fixedCollapsedRows))) + "px");
    }

    function configureDesktopPopup() {
      const params = new URLSearchParams(window.location.search);
      if (params.get("window") !== "1") return;
      document.body.classList.add("voice-call-popup-window");
      app.classList.add("desktop-popup");
      requestAnimationFrame(() => fitDesktopPopup(true));
      clearInterval(popupResizeTimer);
      popupResizeTimer = window.setInterval(() => fitDesktopPopup(false), popupResizeIntervalMs);
    }

    function fitDesktopPopup(centerAfterResize) {
      const params = new URLSearchParams(window.location.search);
      if (params.get("window") !== "1") return;
      try {
        const targetHeight = app.classList.contains("portrait-collapsed")
          ? Math.round(popupWidth * 3 / 4)
          : popupHeight;
        const deltaWidth = popupWidth - window.innerWidth;
        const deltaHeight = targetHeight - window.innerHeight;
        if (Math.abs(deltaWidth) > popupMinContentDelta || Math.abs(deltaHeight) > popupMinContentDelta) {
          window.resizeBy(deltaWidth, deltaHeight);
        }
        if (centerAfterResize && popupShouldCenter) {
          requestAnimationFrame(() => {
            const targetLeft = getScreenAvailLeft();
            window.moveTo(
              targetLeft,
              getPopupInitialTop()
            );
            requestAnimationFrame(() => alignPopupLeftEdge(3));
          });
        }
      } catch {
        statusSubtitle.textContent = "浏览器未允许调整小窗大小";
      }
    }

    function getScreenAvailLeft() {
      return Number.isFinite(screen.availLeft) ? screen.availLeft : 0;
    }

    function getPopupScreenLeft() {
      return Number.isFinite(window.screenX) ? window.screenX : window.screenLeft || 0;
    }

    function getPopupInitialTop() {
      const top = (screen.availTop || 0) + Math.floor((screen.availHeight - window.outerHeight) / 2);
      return Math.max(screen.availTop || 0, top);
    }

    function alignPopupLeftEdge(remainingAttempts) {
      const targetLeft = getScreenAvailLeft();
      const shift = Math.round(targetLeft - getPopupScreenLeft());
      if (Math.abs(shift) > 0) window.moveBy(shift, 0);
      if (remainingAttempts > 0 && Math.abs(shift) > 1) {
        requestAnimationFrame(() => alignPopupLeftEdge(remainingAttempts - 1));
        return;
      }
      popupShouldCenter = false;
    }

    function openDesktopPopup() {
      const url = new URL(window.location.href);
      url.searchParams.set("window", "1");
      const chromeWidth = Math.max(0, window.outerWidth - window.innerWidth);
      const chromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
      const targetOuterWidth = popupWidth + chromeWidth;
      const targetOuterHeight = popupHeight + chromeHeight;
      const left = getScreenAvailLeft();
      const top = Math.max(screen.availTop || 0, (screen.availTop || 0) + Math.floor((screen.availHeight - targetOuterHeight) / 2));
      const features = [
        "popup=yes",
        "width=" + targetOuterWidth,
        "height=" + targetOuterHeight,
        "left=" + left,
        "top=" + top,
        "menubar=no",
        "toolbar=no",
        "location=no",
        "status=no",
        "resizable=no",
        "scrollbars=no"
      ].join(",");
      const popup = window.open(url.toString(), "alice_voice_call", features);
      if (!popup) {
        statusSubtitle.textContent = "浏览器拦截了小窗";
        return;
      }
      popup.focus?.();
    }

    function keepSurfaceAnchored() {
      if (!app.classList.contains("portrait-collapsed")) return;
      requestAnimationFrame(() => {
        document.scrollingElement?.scrollTo?.(0, 0);
        window.scrollTo(0, 0);
      });
    }

    async function unlockAudio() {
      remoteAudio.muted = false;
      remoteAudio.volume = 1;
      await remoteAudio.play().catch(() => {});
    }

    async function startPcmStreaming(stream) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext || !stream) throw new Error("浏览器不支持音频采集");
      audioContext ||= new AudioContext();
      if (!audioContext.audioWorklet) throw new Error("浏览器不支持 AudioWorklet 音频采集");
      await audioContext.resume?.();
      if (!pcmWorkletUrl) {
        pcmWorkletUrl = URL.createObjectURL(new Blob([pcmWorkletSource()], { type: "text/javascript" }));
        await audioContext.audioWorklet.addModule(pcmWorkletUrl);
      }
      pcmSource = audioContext.createMediaStreamSource(stream);
      pcmProcessor = new AudioWorkletNode(audioContext, "alice-pcm16-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        outputChannelCount: [1]
      });
      pcmProcessor.port.onmessage = (event) => {
        const message = event.data || {};
        if (message.type !== "pcm" || !message.buffer) return;
        if (!speechActive || !socket || socket.readyState !== WebSocket.OPEN) return;
        sendPcmChunk(new Uint8Array(message.buffer), message.timing);
      };
      pcmProcessor.port.postMessage({
        type: "config",
        targetRate: inboundAudio.sampleRateHz,
        chunkMs: inboundAudio.chunkMs
      });
      pcmSource.connect(pcmProcessor);
      pcmSink = audioContext.createGain();
      pcmSink.gain.value = 0;
      pcmProcessor.connect(pcmSink);
      pcmSink.connect(audioContext.destination);
    }

    function sendPcmChunk(bytes, timing) {
      if (!bytes.byteLength) return;
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      sendSignal({ type: "audio-chunk", data: btoa(binary), timing });
    }

    function pcmWorkletSource() {
      return \`
        class AlicePcm16Capture extends AudioWorkletProcessor {
          constructor() {
            super();
            this.targetRate = 16000;
            this.chunkMs = 100;
            this.pending = [];
            this.emittedSamples = 0;
            this.port.onmessage = (event) => {
              const data = event.data || {};
              if (data.type !== "config") return;
              this.targetRate = Number.isFinite(data.targetRate) && data.targetRate > 0 ? data.targetRate : 16000;
              this.chunkMs = Number.isFinite(data.chunkMs) && data.chunkMs > 0 ? data.chunkMs : 100;
            };
          }
          process(inputs, outputs) {
            const input = inputs[0]?.[0];
            const output = outputs[0]?.[0];
            if (output) output.fill(0);
            if (!input || !input.length) return true;
            const ratio = sampleRate / this.targetRate;
            const outputLength = Math.floor(input.length / ratio);
            for (let index = 0; index < outputLength; index += 1) {
              const sourceIndex = Math.min(input.length - 1, Math.floor(index * ratio));
              const sample = Math.max(-1, Math.min(1, input[sourceIndex] || 0));
              this.pending.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
            }
            const targetSamples = Math.max(1, Math.round(this.targetRate * this.chunkMs / 1000));
            while (this.pending.length >= targetSamples) {
              const chunk = new Int16Array(this.pending.splice(0, targetSamples));
              const startMs = Math.round(this.emittedSamples * 1000 / this.targetRate);
              this.emittedSamples += chunk.length;
              const endMs = Math.round(this.emittedSamples * 1000 / this.targetRate);
              this.port.postMessage({
                type: "pcm",
                buffer: chunk.buffer,
                timing: { startMs, endMs, durationMs: endMs - startMs }
              }, [chunk.buffer]);
            }
            return true;
          }
        }
        registerProcessor("alice-pcm16-capture", AlicePcm16Capture);
      \`;
    }

    function stopPcmStreaming() {
      pcmProcessor?.disconnect?.();
      pcmProcessor?.port?.close?.();
      pcmSink?.disconnect?.();
      pcmSource?.disconnect?.();
      pcmProcessor = undefined;
      pcmSink = undefined;
      pcmSource = undefined;
      speechActive = false;
    }

    function stopLocalAudio() {
      stopPcmStreaming();
      for (const track of localStream?.getTracks?.() || []) track.stop();
      localStream = undefined;
    }

    function downsampleToPcm16(input, sourceRate, targetRate) {
      const ratio = sourceRate / targetRate;
      const length = Math.floor(input.length / ratio);
      const output = new Int16Array(length);
      for (let index = 0; index < length; index += 1) {
        const sourceIndex = Math.floor(index * ratio);
        const sample = Math.max(-1, Math.min(1, input[sourceIndex] || 0));
        output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      return output;
    }

    function ensureAudioAnalyser(stream, side) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext || !stream) return;
      audioContext ||= new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      if (side === "local") localAnalyser = analyser;
      else remoteAnalyser = analyser;
    }

    function drawWaveform() {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);
      drawLayer(localAnalyser, "rgba(215, 170, 119, 0.78)", 1);
      drawLayer(remoteAnalyser, "rgba(217, 75, 75, 0.78)", -1);
      if (!localAnalyser && !remoteAnalyser) drawIdleLine();
      animationFrame = requestAnimationFrame(drawWaveform);
    }

    function drawIdleLine() {
      ctx.strokeStyle = "rgba(139, 104, 71, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const y = canvas.height / 2;
      for (let x = 0; x <= canvas.width; x += 18) {
        const dotY = y + Math.sin(x / 16 + Date.now() / 700) * 3;
        if (x === 0) ctx.moveTo(x, dotY);
        else ctx.lineTo(x, dotY);
      }
      ctx.stroke();
    }

    function drawLayer(analyser, color, direction) {
      if (!analyser) return;
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      const center = canvas.height / 2;
      const step = canvas.width / (data.length - 1);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let index = 0; index < data.length; index += 1) {
        const value = (data[index] - 128) / 128;
        const y = center + value * direction * 42;
        const x = index * step;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    drawWaveform();
  </script>
</body>
</html>`;
}
