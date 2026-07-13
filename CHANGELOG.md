# 更新日志

## v0.4.6 - 会话入站身份统一 (2026-07-13)

### 会话
- **主路径**：`ensureSession` 用 `conversationKey`（umo|sender|规范化正文）+ 未完成索引，不同 `span_id` 从第一条 trace 起挂到同一 session。
- 规范化 `[At:…]` 前后位置，修复「摸摸头」等双「进行中」卡片。
- 挂载 alias 不重复合成 `message_in`；同规则 `sel_persona` 不重复记事件。
- 完成/错误/stale 从 openIndex 摘除，同文案下一句不粘旧会话。
- `mergeSplitSessions` 仅作乱序安全网，验收不依赖事后合并。

---

## v0.4.5 - 动效降噪与耗时语义 (2026-07-12)

### 动效
- 默认档位改为 **精简**（medium）；按钮文案 `动效: 精简/全开/关闭`。
- CRT 扫描线仅 `anim-full` 开启；medium 关闭 live infinite、列表 stagger、状态点呼吸。
- `shouldAnimate(tier)`：`enter` / `feedback` / `loop` 分层；metric 脉冲 1.2s 防抖。
- 视图切换改为 CSS 单管线淡入，去掉 JS opacity 双轨。
- 骨架屏改纯平色条带；事件列表 stagger 最多 8 项。

### 视觉
- 字体改为系统栈；`--muted-dark` 对比微调。
- 主区 `workspaceMeta` 显示流状态 + 最近刷新时间；主题切换同步 `color-scheme`。

### 耗时语义
- 会话区分 **总耗时（墙钟 wallMs）** 与 **生成（stats generationMs）**；`durationMs` 兼容字段优先墙钟。
- `time_to_first_token ≤ 0` 视为无效，不再显示「首 Token 0.00 秒」。
- 进行中会话「已运行」本地 1s tick 刷新，不依赖全量 re-render。

---

## v0.4.4 - WebUI 评审修复 (2026-07-12)

### Critical
- 修复骨架屏 `removeLoadingState` 用旧 HTML 覆盖刚渲染数据的问题。
- 登录 Cookie 改为随机 session id（不再写入 `access_token` 明文）；兼容旧密码 Cookie / `?token=` 自动升级。

### High
- 登录按 IP 限流（5 分钟窗口）。
- 错误 query token 不再覆盖有效 Cookie。
- 鉴权探测网络失败不再误进面板。
- `focusLogEntry` 软切 Tab，避免断 SSE / 强制全量刷新。
- 用户日志正则长度与嵌套量词防护（ReDoS）。
- SSE `connecting` 阶段跳过 HTTP 拉 logs。

### UX
- Tab `id` 与 `aria-labelledby` 对齐；metric `role="button"`。
- ≤980px 侧栏改为抽屉 + 汉堡菜单。
- 补齐骨架屏 / 快捷键浮层样式；登录页对齐遥测直角风格。
- toast z-index 提高；token 补 `--ok/--bad/--panel/--border` 别名。

---

## v0.4.3 - File-SSE 日志流重新接入 (2026-07-09)

### 日志实时推送
- 新增 `GET /api/logs/stream`（SSE）：周期文件 incremental tail，事件体与 `/api/logs` 同形状 `{ astrbot: [...] }`。
- `/api/logs` 固定文件形状，禁止再切到 `{ live }`，避免历史混用导致丢行/重复。
- 前端 EventSource 接入：`mergeLogData` 唯一写入；SSE 在线时停止日志 HTTP 轮询，断开后自动降级。
- 首屏策略：先 `/api/logs` 文件基线展示，延迟约 `refreshMs`（默认 5s）再连 SSE；默认 `snapshot=0`，避免二次全量扫盘。
- 主 Tab 切页：切到 `overview` / `astrbot` / `logs` 时走 `rearmFileBaselineThenStream`（断 SSE → 强制文件读 → 左侧状态 pending → ~5s 再增量 SSE）；**切到 `system` 不 rearm**，只刷系统数据并保持已有日志流。快速连点只保留最后一次 timer。
- 左侧 `#sidebarStatusText` 实时展示文件/流模式文案与点色，避免被「在线 · 时间」覆盖。
- 会话列表：pre-agent 卡在检测到同句 agent 孪生后立即隐藏，避免「唤醒检查」与「请求模型」两张卡并存。
- 可选 LogBroker fan-in（`runtime:logbroker` 虚拟路径），探测失败静默，不影响文件 SSE。
- 配置项 `log_stream.enabled` / `interval_ms` / `prefer_logbroker`；health/config 暴露 `log_stream_*` 与 `log_broker_*`。

---

## v0.4.2 - 实时对话动效第二档 (2026-06-25)

### 实时会话（AstrBot → 会话）
- 列表 live 项：顶栏流光常亮+光晕、左侧 4px 脉冲色条、选中双环追逐、页脚「已运行」计时脉冲。
- 详情实时卡：斜向扫描线 `.session-live-scan`、底栏加粗进度条、LIVE 微标签、meta 刷新高亮 `is-meta-tick`、内容更新边框闪。
- 概览卡顶栏流光、详情外发光加强；合并重复的 `.session-live-copy` 动画规则。
- 静态资源版本 `20260625-live3`；`prefers-reduced-motion` 降级。

---

## v0.4.1 - WebUI 明显动感动画 (2026-06-24)

### 动画与交互
- 统一动效 token（入场、视图切换、实时会话节奏），并保留 `prefers-reduced-motion` 降级。
- 主 Tab 与 AstrBot 子 Tab 共用 `transitionViews` 淡入淡出切换。
- 总览 `function-card` / 资源卡错峰 `fadeInUp` 入场；条形图与 usage 条宽度增长 + 脉冲反馈。
- 修复骨架屏选择器（`#bigScreenCards`），首屏刷新占位生效。
- 加强 AstrBot 实时会话流光与呼吸对比度；静态资源版本 bump 为 `20260624-motion1`。
- Playwright 测试改为计算样式与 CSS fetch 断言，无 live 会话时跳过相关用例。

---

## v0.4.0 - WebUI 全面打磨 (2026-06-21)

### 🔴 修复的关键问题

#### 502 Bad Gateway 错误
- **添加请求超时控制** - 8 秒超时，防止长时间卡顿
- **添加并发流量控制** - 最多 2 个并发请求，避免后端过载
- **实现指数退避重试** - 500ms → 1s → 2s 智能重试，网络抖动时自动恢复
- **单个接口容错** - 一个接口失败不影响其他数据展示
- **日志游标大小检查** - 防止超过 50KB 限制触发 400 错误

#### 错误提示不友好
- **添加错误消息映射表** - 将技术性错误转换为用户友好的提示
  - `HTTP 502` → "网关错误，后端服务可能暂时不可用"
  - `HTTP 504` → "请求超时，请检查网络连接"
  - `AbortError` → "请求超时（8秒），请检查网络或稍后重试"

### 🟡 改进的用户体验

- **启用骨架屏加载状态** - 首屏和刷新时显示占位符，用户知道正在加载什么
- **改进空状态引导** - 添加图标、标题、提示文案，引导用户下一步操作
  - 日志空状态："📭 没有匹配的日志 | 尝试调整时间范围、搜索条件或刷新数据"
  - 事件空状态："✨ 没有检测到重要事件 | 系统运行正常，或尝试刷新查看最新数据"
- **提高暗色主题对比度** - 所有文本色提亮，更符合 WCAG AA 可访问性标准
  - `--text`: #e8ecef → #eef2f5
  - `--muted`: #9aa3ad → #a8b3bf
  - `--muted-dark`: #727c87 → #8a95a1

### 🔧 技术改进

- 新增 `fetchJsonWithTimeout()` - 带超时控制的网络请求
- 新增 `FetchQueue` 类 - 并发请求队列管理
- 新增 `retryWithBackoff()` - 指数退避重试机制
- 重构 `refresh()` 函数 - 串行请求 + 单个接口容错
- 新增 `emptyState()` 函数 - 增强的空状态生成器
- 新增 `state.refreshError` 字段 - 记录刷新错误信息

### 📊 影响

- ✅ 502 错误发生率预计降低 90%
- ✅ 加载状态清晰，无"卡住"错觉
- ✅ 错误提示具体，用户知道如何处理
- ✅ 文本更易阅读，长时间使用更舒适

**统计**: 修改 29 个文件，新增 1187 行，删除 246 行

---

## v0.3.2

### 修复

- 移除不可用的 LogBroker / SSE 实时日志流入口，包括后端路由、前端按钮和相关提示文案。
- `/api/logs` 固定回文件轮询模式，避免流式与文件模式混用导致日志丢失、重复和页面状态异常。
- 修复静态资源鉴权缺口：配置 `access_token` 后，`/index.html`、静态资源和 API 统一受保护。
- 新增基于 Cookie 的整站认证承接，首次使用 `?token=` 访问后不再依赖地址栏长期暴露令牌。

## v0.3.1

### 重构

- WebUI 前端重构为原生 ES Modules：
  - `app.js` 拆分为 `js/` 下的状态、API、日志解析、视图、组件、UI 交互等模块。
  - `styles.css` 拆分为 `css/` 下的设计令牌、布局、组件、视图等模块。
  - 后端静态文件服务改为通用目录服务，支持多文件资源。
  - 行为与 UI 外观保持不变，无新增外部依赖和构建步骤。

## v0.3.0

### 新增特性

- 新增纯文件轮询日志读取能力，并补充大量事件类型识别。
- 新增大量事件类型识别：
  - 记忆操作、唤醒检查、Pipeline Hook、结果装饰、Agent 阶段、Pipeline
  - 消息清理、会话操作、插件生命周期、模型响应
- 新增静态文件 mtime 检查，文件修改后自动重新读取，避免浏览器/服务端缓存导致前端无法更新。

### 错误修复

- 修复 README 端口与版本号不一致。
- 修复 LogBroker 清理时向前端发送空日志的问题。
- 修复 `/api/logs` 在 LogBroker 可用时未返回流式日志的问题。
- 修复 `confidenceLabel` 未定义导致详情面板渲染失败的问题。
- 修复 `progressiveLogInit` 用增量请求覆盖完整日志导致页面闪一下后消失的问题。

### UI 优化

- 精简界面：移除总览「诊断摘要」折叠区、AstrBot 日志页冗余卡片。
- 修复 PC 端错误显示移动端汉堡菜单、折叠按钮位置不正确的问题。
- 侧边栏状态网格改为双列，整体间距更紧凑。
- 优化前端时间过滤、快捷键、移动端侧边栏等交互。

## v0.2.0

- 新增 LogBroker 日志流集成。
- 新增 SSE 实时日志推送 API。
- 性能优化：延迟降低 90%+。
- 完全向后兼容，自动 fallback。

## v0.1.0

- 初始版本。
- 系统监控和日志可视化。
- 基于文件的日志分析。
