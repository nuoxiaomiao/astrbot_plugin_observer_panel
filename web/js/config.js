// ============================================================================
// 常量定义
// ============================================================================

export const initialQuery = new URLSearchParams(window.location.search);
export const qs = initialQuery;
/** 兼容旧书签 ?token=；登录成功后以 Cookie 为准，可清空 */
let authToken = qs.get("token") || "";

export function getAuthToken() {
  return authToken;
}

export function setAuthToken(value) {
  authToken = String(value || "");
}

export function clearAuthToken() {
  authToken = "";
}

/** @deprecated 使用 getAuthToken；保留具名导出以免遗漏引用 */
export const token = authToken;

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
export const TRACE_ANALYSIS_ENTRY_LIMIT = 2500;
/** 分析窗裁剪时优先保留的 plain 思考候选条数 */
export const REASONING_CANDIDATE_KEEP = 100;
export const IMPORTANT_EVENT_TYPES = new Set([
  "tool_call",
  "tool_result",
  "message_out",
  "provider_response",
  "memory",
  "waking",
  "message_cleanup",
  "debounce",
  "message_merge",
  "heartflow",
  "context_compact",
  "tool_auth",
  "slow",
  "warn",
  "error",
]);

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
  "modules.group_chat_context_optimizer": "插件: AstrNa 上下文",
  "modules.identity_metadata": "插件: AstrNa 身份",
  "step.split": "插件: 输出管道分段",
  "core.send_tracker": "插件: 输出管道发送",
  "astrbot_plugin_debounce.main": "插件: 防抖 Debounce",
  "astrbot_plugin_heartflow.main": "插件: 心流 Heartflow",
  "astrbot_plugin_nuoxiaomiao.main": "插件: 糯小喵",
  "meme_manager.main": "插件: 表情包",
  "spectrecore.main": "插件: SpectreCore",
  "astrbot_plugin_yeli_relationship.main": "插件: 关系本",
  "astrbot_plugin_irmia_devkit.main": "插件: irmia 开发箱",
  "astrbot_plugin_pokepro.main": "插件: 戳一戳",
  "astrbot_plugin_period.main": "插件: Period 情绪",
  "astrbot_plugin_gitee_aiimg.main": "插件: 文生图",
};

/** plugin shortName → 中文展示（normalizeModuleGroup / pluginModuleGroup） */
export const PLUGIN_DISPLAY_NAMES = {
  debounce: "防抖 Debounce",
  heartflow: "心流 Heartflow",
  nuoxiaomiao: "糯小喵",
  nuoxiaomiao_guard: "糯小喵守卫",
  astrna: "AstrNa",
  meme_manager: "表情包",
  spectrecore: "SpectreCore",
  yeli_relationship: "关系本",
  irmia_devkit: "irmia 开发箱",
  irmia_task_scaffold: "任务脚手架",
  pokepro: "戳一戳",
  period: "Period 情绪",
  gitee_aiimg: "文生图",
  outputpro: "输出管道",
  livingmemory: "长期记忆",
  anysearch: "AnySearch",
  bili_resolver: "B站解析",
  qq_group_daily_analysis: "群日常分析",
  restart: "重启",
  observer_panel: "观察面板",
  llm_qqgrouptools: "群管工具",
  palette: "WebUI 美化",
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
  "modules.": { label: "插件: AstrNa 模块", className: "module-plugin", keyPrefix: "astrna_modules" },
  "step.": { label: "插件: 输出管道步骤", className: "module-plugin", keyPrefix: "output_step" },
  "meme_manager.": { label: "插件: 表情包", className: "module-plugin", keyPrefix: "meme" },
  "spectrecore.": { label: "插件: SpectreCore", className: "module-plugin", keyPrefix: "spectre" },
  "astrbot_plugin_debounce.": { label: "插件: 防抖 Debounce", className: "module-plugin", keyPrefix: "plugin:debounce" },
  "astrbot_plugin_heartflow.": { label: "插件: 心流 Heartflow", className: "module-plugin", keyPrefix: "plugin:heartflow" },
  "astrbot_plugin_nuoxiaomiao.": { label: "插件: 糯小喵", className: "module-plugin", keyPrefix: "plugin:nuoxiaomiao" },
  "astrbot_plugin_nuoxiaomiao_guard.": { label: "插件: 糯小喵守卫", className: "module-plugin", keyPrefix: "plugin:nuoxiaomiao_guard" },
  "astrbot_plugin_yeli_relationship.": { label: "插件: 关系本", className: "module-plugin", keyPrefix: "plugin:yeli_relationship" },
  "astrbot_plugin_outputpro.": { label: "插件: 输出管道", className: "module-plugin", keyPrefix: "plugin:outputpro" },
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
  debounce: { label: "防抖判定", badge: "warn", className: "event-debounce" },
  message_merge: { label: "消息合并", badge: "info", className: "event-message-merge" },
  heartflow: { label: "心流判定", badge: "info", className: "event-heartflow" },
  meme: { label: "表情匹配", badge: "debug", className: "event-meme" },
  context_compact: { label: "上下文压缩", badge: "info", className: "event-context-compact" },
  output_pipeline: { label: "出站管线", badge: "debug", className: "event-output-pipeline" },
  group_analysis: { label: "群分析任务", badge: "info", className: "event-group-analysis" },
  proactive: { label: "主动回复", badge: "debug", className: "event-proactive" },
  tool_auth: { label: "工具鉴权", badge: "warn", className: "event-tool-auth" },
  relationship: { label: "关系本", badge: "debug", className: "event-relationship" },
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

// UI 本地存储键
export const SIDEBAR_COLLAPSED_KEY = "op_sidebar_collapsed";
export const COMPACT_KEY = "op_compact";
export const THEME_KEY = "op_theme";
export const DRAG_LAYOUT_PREFIX = "op_layout_";