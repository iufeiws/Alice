# Plugin 配置与资源存放规则

本文档定义 plugin 的本机配置目录和资源目录。新插件接入后台 Plugin registry 时必须遵守该规则。

## 配置目录

插件运行配置统一保存到：

```text
config/plugin/{plugin_id}/config.json
```

规则：

- `config/` 是本机运行配置目录，不进入 Git。
- 配置文件保存插件开关、provider 选择、API preset 名称、小型结构化参数和资源路径。
- 配置文件不保存模型、音频、图片、生成结果等大文件内容。
- 配置文件不保存 API key；需要 API key 的 provider 应引用后台统一 API preset，或在插件配置中只保存 provider 要求的最小本机密钥字段。
- Admin 保存新配置时只写 `config/plugin/{plugin_id}/config.json`。
- 历史 `plugins/{plugin_id}/config.json` 只能作为迁移读取来源，不能作为新写入目标。

当前例外：

- `plugins/tts/config.json` 和 `plugins/japanese-voice/config.json` 是 TTS 的历史兼容读取来源；新 TTS 配置只写 `config/plugin/tts/config.json`。

## 资源目录

插件资源统一保存到：

```text
assets/plugin/{plugin_id}/...
```

规则：

- 模型、参考音频、测试音频、图片和其它大文件走资源目录，不写入 `config/`。
- 配置文件只保存资源路径。
- 后台上传接口必须拒绝路径穿越和插件资源根目录之外的路径。

TTS 语音模型 preset 使用专用目录：

```text
assets/tts/preset/{preset}/model/
assets/tts/preset/{preset}/reference.*
assets/tts/preset/{preset}/reference.txt
```

这是 TTS plugin 的既有模型 preset 约定；它仍属于资源目录规则，不属于配置目录。
