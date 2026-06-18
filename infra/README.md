# Infra 说明

部署与本地运行辅助文件会放在这里。

当前状态：

- 尚无 Docker Compose 实现。
- 提供用户级 systemd + tmux 开机启动脚本。

当前本地运行路径：

```bash
npm run dev:api
```

## 开机启动

安装用户级 systemd 服务：

```bash
chmod +x infra/start-agent-tmux.sh infra/install-user-systemd-autostart.sh
infra/install-user-systemd-autostart.sh
systemctl --user start alice-agent-tmux.service
```

脚本会创建 `~/.config/systemd/user/alice-agent-tmux.service`，开机后启动 `alice-agent`
tmux session，并在其中运行：

```bash
npm run dev:api
```

`npm run dev:api` 退出后 tmux session 会保留，并落回一个交互 shell，方便修改后手动重新执行：

```bash
npm run dev:api
```

在 tmux 里按 `Ctrl-C` 只会停止当前 app，不会退出 tmux session。

因为需要机器开机但用户未登录时也启动，安装脚本会尝试启用 linger：

```bash
loginctl enable-linger yf
```

如果当前权限不允许，按脚本提示执行一次 `sudo loginctl enable-linger yf`。

常用命令：

```bash
tmux attach -t alice-agent
systemctl --user status alice-agent-tmux.service
systemctl --user restart alice-agent-tmux.service
systemctl --user stop alice-agent-tmux.service
```
