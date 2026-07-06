import type { VoiceCallConfigResponse } from "./voice-call-contract.js";

export function renderVoiceCallMarkup(config: VoiceCallConfigResponse): string {
  return `  <main class="voice-call-app" data-phase="idle">
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
      <div class="transcript-line alice" id="aliceTranscript">
        <div class="previous" id="alicePreviousTranscript"></div>
        <div class="current" id="aliceCurrentTranscript">Alice 的实时回复会显示在这里</div>
      </div>
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
`;
}
