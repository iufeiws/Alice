# MOSS TTS notes

- Runtime bootstrap is machine-local today: `npm run tts:moss:install` expects `.miniconda/_conda` to exist. A fresh checkout needs a documented Miniconda bootstrap step or a repo script before this is reproducible.
- WeChat iLink native voice remains unverified/likely unsupported for outbound bot sends. Text delivery worked, but `voice_item`/`audio_item`/SILK-style attempts returned success-like empty responses without delivering a voice message to the user. Prefer Feishu for real voice until this is solved.
