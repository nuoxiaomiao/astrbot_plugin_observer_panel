// ============================================================================
// 常量定义
// ============================================================================

export const initialQuery = new URLSearchParams(window.location.search);
export const qs = initialQuery;
export const token = qs.get("token") || "";

export const LEVELS = {
  error: { label: "错误", badge: "bad" },
  warn: { label: "警告", badge: "warn" },
  info: { label: "信息", badge: "ok" },
  debug: { label: "调试", badge: "debug" },
  trace: { label: "追踪", badge: "debug" },
  other: { label: "其他", badge: "" },
};

export const DIAGNOSTIC_LEVELS = {
  ok: { label: "健康", badge: "ok" },
  info: { label: "提示", badge: "debug" },
  warn: { label: "注意", badge: "warn" },
  bad: { label: "异常", badge: "bad" },
};

export const MODULE_CHART_LIMIT = 10;
export const TRACE_ANALYSIS_ENTRY_LIMIT = 1500;
export const IMPORTANT_EVENT_TYPES = new Set(["tool_call", "tool_result", "message_out", "provider_response", "memory", "waking", "message_cleanup", "slow", "warn", "error"]);

// 与后端 LOG_TIMESTAMP_RE 保持一致，用于从日志行解析时间戳
export const LOG_TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/;

// 模块标签映射
export const CORE_MODULE_LABELS = {
  "core.event_bus": "核心: 事件总线",
  "core.pipeline": "核心: 消息管线",
  "core.provider": "核心: 模型调度",
  "core.star": "核心: 插件系统",
  "core.star_handler": "核心: 插件处理",
  "core.session": "核心: 会话",
  "core.config": "核心: 配置",
  "core.astrbot_config": "核心: 配置",
  "core.zip_updator": "核心: 版本更新",
  "star.session_plugin_manager": "核心: 会话插件管理",
  "star.star_manager": "核心: 插件管理",
  "pipeline.scheduler": "核心: Pipeline 调度",
  "pipeline.context_utils": "核心: Pipeline Hook",
  "waking_check.stage": "核心: 唤醒检查",
  "result_decorate.stage": "核心: 结果装饰",
  "respond.stage": "核心: 响应阶段",
  "agent_sub_stages.internal": "核心: Agent 子阶段",
  "runners.tool_loop_agent_runner": "核心: Agent 工具循环",
  "runners.base": "核心: Agent Runner",
  "sources.openai_source": "模型: OpenAI",
  "sources.request_retry": "模型: 请求重试",
  "utils.reply_decision": "核心: 回复决策",
  "utils.history_storage": "核心: 历史存储",
  "utils.logger": "核心: 日志",
};

export const METHOD_MODULE_LABELS = {
  "method.star_request": "插件调度",
  "method.llm_request": "模型请求",
  "method.provider_request": "模型请求",
};

export const PLUG_MODULE_LABELS = {
  "core.event_handler": "插件模块: 事件处理",
  "managers.conversation_manager": "插件模块: 会话管理",
  "processors.memory_processor": "插件模块: 记忆处理",
  "storage.conversation_store": "插件模块: 对话存储",
  "utils.__init__": "插件模块: 工具函数",
  "event_handler_modules.group_capture": "插件模块: 群聊捕获",
  "event_handler_modules.memory_recall": "插件模块: 记忆召回",
  "event_handler_modules.memory_reflection": "插件模块: 记忆反射",
  "event_handler_modules.message_utils": "插件模块: 消息工具",
  "retrieval.hybrid_retriever": "插件模块: 混合检索",
  "astrbot.group_chat_context": "插件模块: 群聊上下文",
};

/** 按模块前缀归类（normalizeModuleGroup 优先查表） */
export const MODULE_PREFIX_LABELS = {
  "pipeline.": { label: "核心: Pipeline", className: "module-core", keyPrefix: "pipeline" },
  "runners.": { label: "核心: Agent Runner", className: "module-core", keyPrefix: "runners" },
  "agent_sub_stages.": { label: "核心: Agent 子阶段", className: "module-core", keyPrefix: "agent" },
  "waking_check.": { label: "核心: 唤醒检查", className: "module-core", keyPrefix: "waking" },
  "result_decorate.": { label: "核心: 结果装饰", className: "module-core", keyPrefix: "decorate" },
  "respond.": { label: "核心: 响应阶段", className: "module-core", keyPrefix: "respond" },
  "sources.": { label: "模型请求", className: "module-model", keyPrefix: "model" },
  "managers.": { label: "插件模块: 会话管理", className: "module-plugin", keyPrefix: "managers" },
  "processors.": { label: "插件模块: 处理器", className: "module-plugin", keyPrefix: "processors" },
  "storage.": { label: "插件模块: 存储", className: "module-plugin", keyPrefix: "storage" },
  "event_handler_modules.": { label: "插件模块: 事件处理", className: "module-plugin", keyPrefix: "event_handler" },
  "retrieval.": { label: "插件模块: 检索", className: "module-plugin", keyPrefix: "retrieval" },
  "aiocqhttp.": { label: "平台: aiocqhttp", className: "module-platform", keyPrefix: "platform:aiocqhttp" },
  "qqofficial.": { label: "平台: QQ 官方", className: "module-platform", keyPrefix: "platform:qqofficial" },
};

export const TRACE_ACTION_LABELS = {
  astr_agent_prepare: "Trace: Agent 准备",
  astr_agent_complete: "Trace: Agent 完成",
  astr_agent_error: "Trace: Agent 错误",
  agent_tool_call: "Trace: 工具调用",
  agent_tool_result: "Trace: 工具结果",
  provider_request: "Trace: 模型请求",
  provider_response: "Trace: 模型响应",
  sel_persona: "Trace: 选择人格",
  AstrMessageEvent: "Trace: 消息事件",
};

// 网络接口状态（/sys/class/net/*/operstate）中文映射
export const INTERFACE_STATE_LABELS = {
  up: "在线",
  down: "断开",
  unknown: "未知",
  dormant: "休眠",
  lowerlayerdown: "下层断开",
  notpresent: "未接入",
  testing: "测试中",
};

// 快捷键键名中文/可读映射
export const SHORTCUT_KEY_LABELS = {
  " ": "空格",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export const EVENT_TYPES = {
  message_in: { label: "收到消息", badge: "ok", className: "event-message-in" },
  persona: { label: "规则选择", badge: "debug", className: "event-persona" },
  model_start: { label: "开始生成", badge: "debug", className: "event-model" },
  provider_response: { label: "模型响应", badge: "info", className: "event-provider" },
  tool_call: { label: "工具调用", badge: "warn", className: "event-tool" },
  tool_result: { label: "工具返回", badge: "ok", className: "event-tool" },
  message_out: { label: "发送回复", badge: "ok", className: "event-message-out" },
  message_cleanup: { label: "消息清理", badge: "info", className: "event-cleanup" },
  memory: { label: "记忆操作", badge: "info", className: "event-memory" },
  waking: { label: "唤醒检查", badge: "info", className: "event-waking" },
  hook: { label: "Pipeline Hook", badge: "debug", className: "event-hook" },
  decorate: { label: "结果装饰", badge: "debug", className: "event-decorate" },
  agent_stage: { label: "Agent 阶段", badge: "debug", className: "event-agent-stage" },
  pipeline: { label: "Pipeline", badge: "debug", className: "event-pipeline" },
  plugin_lifecycle: { label: "插件生命周期", badge: "debug", className: "event-plugin-lifecycle" },
  conversation: { label: "会话操作", badge: "debug", className: "event-conversation" },
  slow: { label: "慢请求", badge: "warn", className: "event-slow" },
  warn: { label: "警告", badge: "warn", className: "event-warn" },
  error: { label: "错误", badge: "bad", className: "event-error" },
};

export const DEFAULT_RUNNING_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_SLOW_SESSION_MS = 30 * 1000;
export const DEFAULT_SLOW_TOOL_MS = 15 * 1000;
export const DEFAULT_IMPORTANT_EVENT_LIMIT = 80;
export const DEFAULT_LOG_PAGE_SIZE = 80;
export const DEFAULT_RAW_CLIP_LENGTH = 5000;

// 浏览器通知
export const NOTIFY_COOLDOWN_MS = 60 * 1000;
export const NOTIFY_LAST_KEY = "op_last_notify_ts";

// UI 本地存储键
export const SIDEBAR_COLLAPSED_KEY = "op_sidebar_collapsed";
export const COMPACT_KEY = "op_compact";
export const THEME_KEY = "op_theme";
export const DRAG_LAYOUT_PREFIX = "op_layout_";