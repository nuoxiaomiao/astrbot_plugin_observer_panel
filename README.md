# AstrBot Observer Panel

独立端口 WebUI 插件，用于查看系统资源、AstrBot 运行状态和基于日志文件的运行洞察。

## 安装

```bash
cd data/plugins
git clone https://github.com/nuoxiaomiao/astrbot_plugin_observer_panel.git
```

## 当前能力

- 独立 `aiohttp` Web 服务，默认监听 `127.0.0.1:7199`
- 主机系统信息：CPU、内存、磁盘、网络接口、AstrBot 进程与 Python 运行时
- 三栏工作台布局：左侧导航与状态，中间主工作区，右侧事件证据详情
- 总览、AstrBot、日志分析、系统四个主视图
- 基于日志文件的事件识别、重要信息聚合、原始日志检索与分页
- 常见密钥脱敏显示
- 访问令牌鉴权，支持首次通过 `?token=` 访问后写入认证 Cookie

## 使用

启用插件后访问：

```text
http://127.0.0.1:7199/
```

如果设置了 `access_token`，可首次通过以下地址访问：

```text
http://127.0.0.1:7199/?token=你的令牌
```

认证通过后插件会写入站点 Cookie，后续静态资源和 API 请求无需继续在地址栏携带 `token`。

## 配置重点

- `host`: 默认 `127.0.0.1`，只允许本机访问。需要局域网访问时改成 `0.0.0.0`。
- `port`: WebUI 端口，默认 `7199`。
- `access_token`: 面板访问令牌。监听 `0.0.0.0`/`::` 时必须配置；即便只绑本机，也建议配置以防同机旁路访问。
- `refresh_interval_seconds`: 前端自动刷新间隔，默认 `5` 秒。
- `astrbot.logs_dir`: AstrBot 日志目录，默认 `data/logs`。**`log_files` 只允许落在此目录内**（相对路径拼接、绝对路径越界会被拒绝）。
- `astrbot.log_files`: 日志文件名或 `logs_dir` 内绝对路径列表。
- `astrbot.tail_lines`: 每个日志文件读取的最大行数。
- `astrbot.tail_bytes`: 每个日志文件读取的最大字节数。
- `ui.log_page_size`: 原始日志每页行数，默认 `80`。
- `ui.privacy_mode`: **服务端 + 前端**隐藏消息/工具/原始日志正文；`/api/logs` 的 `lines` 在开启时会被遮罩。

## API

### `GET /api/health`

返回插件健康状态：

```json
{
  "ok": true,
  "plugin": "astrbot_plugin_observer_panel",
  "version": "0.4.2",
  "uptime_seconds": 123.456,
  "log_mode": "file",
  "log_stream_available": false,
  "log_stream_enabled": false,
  "cached_logs": 0,
  "now": 1701234567890
}
```

### `GET /api/logs?source=astrbot`

返回日志文件 tail 结果。支持 `cursor` 增量刷新。

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

## 安全说明

- 当前版本不提供实时日志流入口，只支持文件轮询模式。
- 配置了 `access_token` 后，`/`、`/index.html`、静态资源和 `/api/*` 都要求通过认证。
- 未配置 `access_token` 且监听所有网卡（`0.0.0.0`/`::`）时，远程请求会被整体拒绝；本机 loopback 仍可访问。
- `ui.privacy_mode=true` 时 `/api/logs` 会遮罩正文，不能仅靠前端开关。
- `astrbot.log_files` 受 `logs_dir` 沙箱约束，不能用来读取任意系统文件。
- 进程 `cmdline` 会走密钥正则脱敏。

## 故障排查

1. 页面能打开但静态资源 401：
   - 首次访问请使用 `/?token=你的令牌`
   - 首屏认证成功后会自动写入 Cookie

2. 日志为空：
   - 检查 `astrbot.logs_dir` 和 `astrbot.log_files`
   - 确认文件落在 `logs_dir` 内且进程有读权限

3. 远程访问失败：
   - 监听所有网卡时请配置 `access_token`
   - 反向代理场景下确认 `Host` 和 `X-Forwarded-Proto` 传递正确
