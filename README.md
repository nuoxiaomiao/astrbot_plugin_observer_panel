# AstrBot Observer Panel

独立端口 WebUI 插件，用于查看系统资源、AstrBot 运行状态和基于日志文件的运行洞察。

## 安装

### Linux / macOS

```bash
cd data/plugins
git clone https://github.com/nuoxiaomiao/astrbot_plugin_observer_panel.git
```

### Windows

在 AstrBot 数据目录的 `data\plugins` 下克隆（PowerShell 示例）：

```powershell
cd data\plugins
git clone https://github.com/nuoxiaomiao/astrbot_plugin_observer_panel.git
```

依赖：

```text
aiohttp>=3.9.0
psutil>=5.9.0
```

- **Linux**：主机指标优先走 `/proc`、`/sys`（不强制 psutil）。
- **Windows / 其它平台**：系统页 CPU、内存、网卡、进程细节依赖 **psutil**；未安装时面板仍可启动，但主机指标会降级为空/0，并在诊断中提示。

Windows 若需局域网访问，请在防火墙放行配置的 WebUI 端口（默认 `7199`）。

## 当前能力

- 独立 `aiohttp` Web 服务，默认监听 `127.0.0.1:7199`
- 主机系统信息：CPU、内存、磁盘、网络接口、AstrBot 进程与 Python 运行时（跨平台）
- 三栏工作台布局：左侧导航与状态，中间主工作区，右侧事件证据详情
- 总览、AstrBot、日志分析、系统四个主视图
- 基于日志文件的事件识别、重要信息聚合、原始日志检索与分页
- 常见密钥脱敏显示
- 界面密码登录（配置 `access_token` 作为密码），登录后写入 HttpOnly 会话 Cookie（随机 session，不含密码明文）

## 使用

启用插件后访问：

```text
http://127.0.0.1:7199/
```

如果设置了 `access_token`（面板登录密码），打开上述地址后在登录页输入密码即可。成功后写入站点 Cookie，刷新无需重复输入；顶栏可「退出」。

> 兼容：旧书签 `/?token=密码` 仍可用，但推荐界面登录，避免令牌出现在地址栏/历史记录。

## 配置重点

- `host`: 默认 `127.0.0.1`，只允许本机访问。需要局域网访问时改成 `0.0.0.0`。
- `port`: WebUI 端口，默认 `7199`。
- `access_token`: **面板登录密码**。监听 `0.0.0.0`/`::` 时必须配置；即便只绑本机，也建议配置以防同机旁路访问。
- `refresh_interval_seconds`: 前端自动刷新间隔，默认 `5` 秒。
- `astrbot.logs_dir`: AstrBot 日志目录，默认 `data/logs`。相对路径会按 **当前工作目录**、**插件 data 父目录** 等候选解析（适配 Windows 不同启动目录）。也可写绝对路径，例如 `D:\AstrBot\data\logs`。**`log_files` 只允许落在此目录内**。
- `astrbot.log_files`: 日志文件名或 `logs_dir` 内绝对路径列表。
- `astrbot.tail_lines`: 每个日志文件读取的最大行数。
- `astrbot.tail_bytes`: 每个日志文件读取的最大字节数。
- `ui.log_page_size`: 原始日志每页行数，默认 `80`。
- `ui.privacy_mode`: **服务端 + 前端**隐藏消息/工具/原始日志正文；`/api/logs` 与 `/api/logs/stream` 的 `lines` 在开启时会被遮罩。
- `log_stream.enabled`: 是否启用文件增量 SSE（默认 `true`）。关闭后前端仅用 `/api/logs` 轮询。
- `log_stream.interval_ms`: 文件增量扫描间隔，默认 `500`。
- `log_stream.prefer_logbroker`: 若 AstrBot 核心提供 LogBroker，则 fan-in 到同一 SSE（虚拟路径 `runtime:logbroker`），失败静默。

## API

### `GET /api/health`

返回插件健康状态：

```json
{
  "ok": true,
  "plugin": "astrbot_plugin_observer_panel",
  "version": "0.4.5",
  "uptime_seconds": 123.456,
  "log_mode": "stream",
  "log_stream_available": true,
  "log_stream_enabled": true,
  "log_broker_available": false,
  "log_broker_enabled": false,
  "cached_logs": 0,
  "now": 1701234567890
}
```

### `POST /api/login`

Body：`{"password":"..."}`。校验 `access_token`，成功时 Set-Cookie `observer_panel_token` 为随机 session id（非密码）。失败按 IP 限流。

### `POST /api/logout`

清除认证 Cookie。

### `GET /api/logs?source=astrbot`

返回日志文件 tail 结果。支持 `cursor` 增量刷新。载荷形状固定为 `{ astrbot: [file...], source: "file" }`，**不会**在 LogBroker 可用时切换为 live 结构。

返回示例：

```json
{
  "ok": true,
  "data": {
    "astrbot": [
      {
        "path": "data/logs/astrbot.log",
        "exists": true,
        "readable": true,
        "size": 12345,
        "mtime": 1701234567.89,
        "lines": ["..."],
        "truncated": false,
        "line_count": 300,
        "base_line": 0,
        "ends_with_newline": true,
        "cursor": {
          "path": "data/logs/astrbot.log",
          "size": 12345,
          "mtime": 1701234567.89,
          "line_count": 300,
          "base_line": 0,
          "ends_with_newline": true
        }
      }
    ],
    "source": "file"
  },
  "now": 1701234568000
}
```

### `GET /api/logs/stream`

SSE 实时推送。事件 `data` 为 JSON：

- `type: "hello"` — 连接确认
- `type: "snapshot"` — 全量 tail 快照（仅 `?snapshot=1` 时发送；默认关闭）
- `type: "logs"` — 文件增量（与 `/api/logs` 同形状的 `astrbot[]`）
- 注释行 `: heartbeat` — 约 30s 保活

鉴权与其它 `/api/*` 相同（Cookie / query token）。前端策略：先 `GET /api/logs` 建文件基线，约一个刷新周期（默认 5s）后再连 SSE（`snapshot=0` 仅增量）；**切换到日志相关主 Tab（总览 / AstrBot / 日志）时同样先断流、强制文件读，再等约 5s 回增量流；切到系统页不重装日志流**。连接成功后停止日志 HTTP 轮询，断开后自动降级；左侧状态栏同步显示文件/实时流切换。

## 安全说明

- 日志推送与文件 tail 共用沙箱、脱敏与 `privacy_mode`；`/api/logs` 数据模型不因流式改变。
- 配置了 `access_token` 后：登录页与静态资源可匿名加载；除 `/api/login`、`/api/logout` 外的 `/api/*`（含 SSE）需有效会话 Cookie（兼容旧密码 Cookie 自动升级；亦兼容正确的 query token / Bearer，成功后升级为 session）。
- 未配置 `access_token` 且监听所有网卡（`0.0.0.0`/`::`）时，远程请求会被整体拒绝；本机 loopback 仍可访问。
- Cookie `Secure` 仅在 TLS 直连（`request.secure`）时设置；不默认信任 `X-Forwarded-Proto`。
- `ui.privacy_mode=true` 时 `/api/logs` 与 `/api/logs/stream` 会遮罩正文，不能仅靠前端开关。
- `astrbot.log_files` 受 `logs_dir` 沙箱约束，不能用来读取任意系统文件。
- 进程 `cmdline` 会走密钥正则脱敏（Linux 读 `/proc`；Windows 经 psutil 采集）。

## 故障排查

1. 打开面板一直停在登录页 / API 401：
   - 确认 `access_token` 与输入密码一致
   - 浏览器需允许 Cookie（`observer_panel_token`）
   - 可点顶栏「退出」后重新登录

2. 日志为空：
   - 检查 `astrbot.logs_dir` 和 `astrbot.log_files`
   - Windows 上若相对路径找不到，请改成日志目录的**绝对路径**
   - 确认文件落在 `logs_dir` 内且进程有读权限

3. Windows 系统页 CPU/内存/网卡为空：
   - 安装 `psutil` 并重启 AstrBot
   - 诊断区会提示「系统指标能力有限」

4. 远程访问失败：
   - 监听所有网卡时请配置 `access_token`（登录密码）并在登录页输入
   - 反向代理若终止 TLS，请自行确保浏览器侧 HTTPS 可达；面板不默认根据 `X-Forwarded-Proto` 标记 Cookie Secure
   - Windows 检查防火墙是否放行端口