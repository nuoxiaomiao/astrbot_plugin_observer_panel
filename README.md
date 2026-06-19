# AstrBot Observer Panel

独立端口 WebUI 插件，用于查看系统资源、AstrBot 运行状态和基于日志的运行洞察。

## 安装

通过 GitHub 链接安装。在 AstrBot 插件目录下克隆本仓库后重启 AstrBot：

```bash
cd data/plugins
git clone https://github.com/nuoxiaomiao/astrbot_plugin_observer_panel.git
```

## 功能

- 独立 `aiohttp` Web 服务，默认监听 `127.0.0.1:7199`
- 主机系统信息：CPU、内存、磁盘、网络接口、AstrBot 进程与 Python 运行时
- 三栏工作台布局：左侧导航与状态，中间主工作区，右侧事件证据详情
- 默认极简总览：系统健康、关键运行态、重要事件和实时工具
- 大屏关键态：活动会话、运行工具、最近发送、慢请求和错误事件
- AstrBot 页用二级标签页展示会话、模型和日志维度可视化
- 健康诊断：资源阈值、日志可读性、最近错误和平台可用性
- **实时日志流**：可选启用 LogBroker 零延迟日志监控（SSE）或纯文件轮询；`enable_log_stream=false` 时完全关闭 SSE，只通过定时轮询读取日志
- 基于 trace 日志识别：收到消息、规则选择、模型开始/响应、工具调用/返回、发送回复、慢请求和错误事件
- 基于普通日志识别：平台收到消息、记忆操作、唤醒检查、Pipeline Hook、结果装饰、Agent 阶段、Pipeline、消息清理、会话操作、插件生命周期、警告和错误
- 重要信息聚焦工具调用、工具返回、发送回复、模型响应、记忆操作、唤醒检查、消息清理、慢请求、警告和错误，支持事件类型筛选、右侧证据详情、原文定位和同一 `span_id` 会话链路
- 会话来源、规则分布、用户活跃、模型耗时与 Token、事件类型、工具平均耗时和模块分布等可视化
- 日志页桌面端分栏展示重要信息和原始日志，原始日志支持分页、级别筛选和搜索
- 自动刷新保留已展开的证据详情、会话链路和原始日志原文，不会因为刷新自动收起
- 日志 tail 支持增量刷新、后端缓存、前端按文件解析缓存和 DOM 渲染缓存，减少大日志文件下的重复读取与重绘
- 原始日志超长原文展开时会裁剪，避免单行 trace 撑爆页面
- 常见密钥脱敏显示

## 使用

启用插件后访问：

```text
http://127.0.0.1:7199/
```

如果设置了 `access_token`，可以手动在浏览器地址里附加令牌：

```text
http://127.0.0.1:7199/?token=你的令牌
```

大屏模式：

```text
http://127.0.0.1:7199/?screen=1
```

### 实时日志流使用示例

#### 使用 SSE（推荐）

```javascript
const token = 'your_token';
const eventSource = new EventSource(
  `http://127.0.0.1:7199/api/logs/stream?history=50&token=${token}`
);

eventSource.onmessage = (event) => {
  const logEntry = JSON.parse(event.data);
  console.log(`[${logEntry.level}] ${logEntry.data}`);
};

eventSource.onerror = () => {
  console.error('Connection lost, reconnecting...');
};
```

#### 使用轮询

```bash
# 获取最新日志
curl "http://127.0.0.1:7199/api/logs/live?limit=100&token=your_token"

# 获取指定时间戳之后的日志
curl "http://127.0.0.1:7199/api/logs/live?since=1701234567.89&token=your_token"
```

## 配置重点

- `host`: 默认 `127.0.0.1`，只允许本机访问。需要局域网访问时改成 `0.0.0.0`。
- `port`: WebUI 端口，默认 `7199`。
- `access_token`: 面板 API 访问令牌。监听 `0.0.0.0` 且未设置令牌时，远程 API 请求会被拒绝，本机请求仍可访问。
- `enable_log_stream`: 是否启用 LogBroker 实时日志流（SSE），默认 `false`。关闭时只通过定时轮询读取日志文件，不再建立 SSE 连接。
- `astrbot.logs_dir`: AstrBot 日志目录，默认 `data/logs`（仅文件模式使用）。
- `astrbot.log_files`: AstrBot 日志文件名或绝对路径列表（仅文件模式使用）。
- `astrbot.tail_lines`: 每个日志文件读取的最大行数（仅文件模式使用）。
- `astrbot.tail_bytes`: 每个日志文件读取的最大字节数（仅文件模式使用）。
- `ui.slow_session_seconds`: 会话生成超过多少秒记为慢请求，默认 `30`。
- `ui.slow_tool_seconds`: 工具调用超过多少秒记为慢工具，默认 `15`。
- `ui.running_timeout_minutes`: 未完成会话或工具在多久内仍视为运行中，默认 `10`。
- `ui.important_event_limit`: 重要信息列表最多显示事件数，默认 `80`。
- `ui.log_page_size`: 原始日志每页行数，默认 `80`。
- `ui.privacy_mode`: 隐藏消息内容、工具参数、工具结果和原始日志正文，默认关闭。
- `thresholds`: 健康诊断阈值，包括 CPU、内存、磁盘、错误日志数量和日志未更新时间。

## API 参考

### 健康检查
```bash
GET /api/health
```

返回：
```json
{
  "ok": true,
  "plugin": "astrbot_plugin_observer_panel",
  "version": "0.3.0",
  "uptime_seconds": 123.456,
  "log_mode": "logbroker",
  "log_stream_available": true,
  "log_stream_enabled": true,
  "cached_logs": 500,
  "now": 1701234567890
}
```

### 实时日志流（SSE）
```bash
GET /api/logs/stream?history=50&token=xxx
```

参数：
- `history`: 回放历史日志数量（0-200，默认 50）

返回：Server-Sent Events 流

### 实时日志（轮询）
```bash
GET /api/logs/live?limit=100&since=1701234567.89&token=xxx
```

参数：
- `limit`: 返回日志数量（1-500，默认 100）
- `since`: Unix 时间戳，只返回此之后的日志

返回：
```json
{
  "ok": true,
  "data": {
    "logs": [...],
    "use_log_stream": true,
    "count": 42,
    "latest_ts": 1701234567.890
  },
  "now": 1701234568000
}
```

## 日志模式

### LogBroker 模式（推荐）

**条件**：
- AstrBot 核心版本支持 LogBroker
- 插件成功连接到 LogBroker 实例

**优势**：
- 零延迟（<10ms）
- 实时推送
- 最小 I/O 开销
- 内存缓存 500 条最近日志

**检查方式**：
```bash
curl "http://127.0.0.1:7199/api/health?token=xxx" | jq '.log_mode'
# 输出: "logbroker"
```

### 文件模式（兼容）

**条件**：
- LogBroker 不可用时自动启用
- 兼容所有 AstrBot 版本

**特性**：
- 读取 `data/logs/astrbot.log` 等文件
- 支持增量读取和缓存
- 延迟 100-500ms

> 注意：`/api/logs` 轮询端点默认使用文件读取模式。如需零延迟实时推送，请使用 `/api/logs/stream` SSE 端点。

## 故障排查

### LogBroker 模式未启用？

1. 检查健康状态：
```bash
curl "http://127.0.0.1:7199/api/health?token=xxx" | jq
```

2. 查看插件日志：
```bash
tail -f data/logs/astrbot.log | grep ObserverPanel
```

可能的原因：
- AstrBot 版本过旧，不支持 LogBroker
- LogBroker 未正确初始化
- 插件无法访问 core_lifecycle

3. 使用文件模式：
   - 文件模式会自动启用，功能完整可用
   - 唯一区别是延迟稍高（100-500ms vs <10ms）

## 安全说明

WebUI 只展示本机系统信息、AstrBot 运行信息和日志，不提供发送消息、退群、重启、退出等操作接口。日志和配置会做基础脱敏，但日志里如果存在特殊格式的密钥，仍建议只在可信网络访问。

## 技术架构

### LogBroker 模式架构

```
AstrBot Logger
    ↓
LogBroker (内存队列)
    ↓
Observer Panel 订阅
    ↓
内存缓存 (500条)
    ↓
SSE 推送 / HTTP 轮询
    ↓
前端 UI
```

### 性能对比

| 指标 | 文件模式 | LogBroker 模式 |
|------|---------|---------------|
| 延迟 | 100-500ms | <10ms |
| I/O 开销 | 高 | 极低 |
| 实时性 | 轮询（1-5秒） | 实时推送 |
| CPU 使用 | 中等 | 低 |

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)。
