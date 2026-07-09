#!/usr/bin/env node
/**
 * 真实 AstrBot plain 日志识别回归（脱敏片段，不依赖 18MB 全量文件）。
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const moduleUrlCache = new Map();

globalThis.window = globalThis.window || { location: { search: "" } };
globalThis.window.location = globalThis.window.location || { search: "" };
globalThis.window.location.search = globalThis.window.location.search || "";

function stripSpecifierQuery(specifier) {
  const marker = specifier.search(/[?#]/);
  return marker === -1 ? specifier : specifier.slice(0, marker);
}

async function browserModuleDataUrl(absPath) {
  const normalizedPath = path.normalize(absPath);
  if (moduleUrlCache.has(normalizedPath)) return moduleUrlCache.get(normalizedPath);

  const source = await readFile(normalizedPath, "utf8");
  const dir = path.dirname(normalizedPath);
  const specifiers = new Set();
  const collect = (_match, prefix, specifier, suffix) => {
    specifiers.add(specifier);
    return `${prefix}${specifier}${suffix}`;
  };
  source
    .replace(/(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g, collect)
    .replace(/(\bimport\s*["'])(\.{1,2}\/[^"']+)(["'])/g, collect);

  const replacements = new Map();
  for (const specifier of specifiers) {
    const depPath = path.resolve(dir, stripSpecifierQuery(specifier));
    replacements.set(specifier, await browserModuleDataUrl(depPath));
  }

  let transformed = source
    .replace(/(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (match, prefix, specifier, suffix) => {
      return `${prefix}${replacements.get(specifier) || specifier}${suffix}`;
    })
    .replace(/(\bimport\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (match, prefix, specifier, suffix) => {
      return `${prefix}${replacements.get(specifier) || specifier}${suffix}`;
    });

  transformed += `\n//# sourceURL=${pathToFileURL(normalizedPath).href}\n`;
  const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(transformed)}`;
  moduleUrlCache.set(normalizedPath, dataUrl);
  return dataUrl;
}

async function importBrowserModule(relativePath) {
  const absPath = path.resolve(repoRoot, relativePath);
  return import(await browserModuleDataUrl(absPath));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mockFile(lines, pathName = "/data/logs/astrbot.log") {
  return {
    source: "astrbot",
    sourceName: "AstrBot",
    path: pathName,
    readable: true,
    base_line: 0,
    line_count: lines.length,
    mtime: 1_700_000_000,
    lines,
  };
}

async function main() {
  const { parseLogLine, buildLogEntries, buildFileLogEntries } = await importBrowserModule("web/js/log/parser.js");
  const {
    plainLogEvent,
    isPlainToolCallLog,
    isPlainProviderResponseLog,
    normalizeModuleGroup,
    parseEventBusMessage,
  } = await importBrowserModule("web/js/log/analytics.js");
  const { summarizePlainLog } = await importBrowserModule("web/js/utils/log-text.js");
  const { state } = await importBrowserModule("web/js/state.js");

  // 清空缓存，避免跨 case 污染
  state.logCache.fileEntries = new Map();

  let passed = 0;
  const cases = [];

  function test(name, fn) {
    cases.push({ name, fn });
  }

  // 1) 标准 Core DBUG + module:line
  test("标准 DBUG 行 level/module", () => {
    const line = "[2026-07-09 13:49:50.000] [Core] [DBUG] [pipeline.scheduler:93]: pipeline execution completed.";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(entry.level === "debug", `level=${entry.level}`);
    assert(entry.moduleName.includes("pipeline.scheduler"), `module=${entry.moduleName}`);
    assert(entry.scope === "Core", `scope=${entry.scope}`);
    assert(entry.summary === "Pipeline 完成" || /Pipeline/.test(entry.summary), `summary=${entry.summary}`);
    const event = plainLogEvent(entry);
    assert(event?.type === "pipeline", `event=${event?.type}`);
  });

  // 2) WARN + [v4.26.4] + request_retry
  test("WARN 版本括号 + request_retry", () => {
    const line = "[2026-07-09 12:07:58.911] [Core] [WARN] [v4.26.4] [sources.request_retry:68]: [OpenAI] Request failed with retryable error; retrying (2/5): Error code: 429 - {'error': {'message': 'rate limit'}}";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(entry.level === "warn", `level=${entry.level}`);
    assert(entry.scope === "Core", `scope=${entry.scope}`);
    assert(/request_retry/.test(entry.moduleName), `module=${entry.moduleName}`);
    assert(!/v4\.26/.test(entry.scope), "version must not be scope");
    assert(/模型重试|429|2\/5/.test(entry.summary), `summary=${entry.summary}`);
    const event = plainLogEvent(entry);
    assert(event?.type === "warn", `event=${event?.type}`);
    assert(isPlainToolCallLog(entry) == null, "retry must not be tool_call");
  });

  // 3) event_bus 入站
  test("event_bus 入站 message_in", () => {
    const line = "[2026-07-09 14:37:03.648] [Core] [INFO] [core.event_bus:74]: [测试群] [bot(aiocqhttp)] Alice/10001: hello world";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(entry.level === "info", `level=${entry.level}`);
    const bus = parseEventBusMessage(entry);
    assert(bus?.sender === "Alice", `sender=${bus?.sender}`);
    assert(/Alice|hello|频道/.test(entry.summary), `summary=${entry.summary}`);
    const event = plainLogEvent(entry);
    assert(event?.type === "message_in", `event=${event?.type}`);
  });

  // 4) openai completion 超长：provider_response，摘要非垃圾前缀，且不误报 tool
  test("ChatCompletion 摘要 + 不误报 tool", () => {
    const line = "[2026-07-09 13:49:30.665] [Core] [DBUG] [sources.openai_source:567]: completion: ChatCompletion(id='gen-abc123xyz', choices=[Choice(finish_reason='stop', index=0, message=ChatCompletionMessage(content='短回复内容', role='assistant', tool_calls=None))], model='gpt-test')";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(entry.level === "debug", `level=${entry.level}`);
    assert(/openai_source/.test(entry.moduleName), `module=${entry.moduleName}`);
    assert(/模型完成/.test(entry.summary), `summary=${entry.summary}`);
    assert(!/^completion:\s*ChatCompletion\(id=/.test(entry.summary), "summary should not dump repr prefix");
    assert(isPlainProviderResponseLog(entry) === true, "should be provider response");
    assert(isPlainToolCallLog(entry) == null, "must not false-positive tool_call");
    const event = plainLogEvent(entry);
    assert(event?.type === "provider_response", `event=${event?.type}`);
  });

  // 5) pipeline execution completed
  test("pipeline execution completed", () => {
    const line = "[2026-07-09 14:37:03.682] [Core] [DBUG] [pipeline.scheduler:93]: pipeline execution completed.";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    const group = normalizeModuleGroup(entry);
    assert(/Pipeline|pipeline/i.test(group.label), `label=${group.label}`);
    assert(group.className !== "module-other", `class=${group.className}`);
    assert(plainLogEvent(entry)?.type === "pipeline");
  });

  // 6) hook(OnLLMRequestEvent) -> plugin
  test("hook 事件与摘要", () => {
    const line = "[2026-07-09 13:49:50.306] [Core] [DBUG] [pipeline.context_utils:95]: hook(OnLLMRequestEvent) -> demo_plugin - on_llm_request";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(/Hook|hook|demo_plugin/i.test(entry.summary), `summary=${entry.summary}`);
    const event = plainLogEvent(entry);
    assert(event?.type === "hook", `event=${event?.type}`);
  });

  // 7) 无 ts 续行 JSON 附着上一行
  test("无时间戳续行附着", () => {
    state.logCache.fileEntries = new Map();
    const lines = [
      "[2026-07-09 11:58:52.740] [Plug] [DBUG] [processors.memory_processor:484]: [MemoryProcessor] JSON 预览:",
      "{",
      '  "summary": "ok"',
      "}",
    ];
    const file = mockFile(lines);
    const entries = buildFileLogEntries(file);
    assert(entries.length === 1, `entries=${entries.length}`);
    assert(entries[0].continued === true, "continued flag");
    assert(entries[0].continuationLines >= 2, `continuationLines=${entries[0].continuationLines}`);
    assert(entries[0].timestamp > 0, "timestamp inherited");
    assert(entries[0].level === "debug", `level=${entries[0].level}`);
    assert(/memory_processor/.test(entries[0].moduleName), `module=${entries[0].moduleName}`);
    assert(entries[0].raw.includes('"summary"'), "raw contains continuation body");
  });

  // 8) 非 provider 的 tool 字样正文：不误报（普通 INFO 行含 tool 描述）
  test("普通正文含 tool 字样不误报", () => {
    const line = "[2026-07-09 12:00:00.000] [Core] [INFO] [core.pipeline:10]: ready toolkit loaded for session";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(isPlainToolCallLog(entry) == null, "should not match tool_call");
  });

  // 9) ERRO + 版本括号
  test("ERRO 级别与版本括号", () => {
    const line = "[2026-07-09 12:08:23.150] [Core] [ERRO] [v4.26.4] [core.zip_updator:206]: 解析版本信息时发生异常: timeout";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(entry.level === "error", `level=${entry.level}`);
    assert(entry.scope === "Core", `scope=${entry.scope}`);
    assert(/zip_updator/.test(entry.moduleName), `module=${entry.moduleName}`);
    assert(plainLogEvent(entry)?.type === "error");
  });

  // 10) RawMessage 摘要
  test("RawMessage 摘要", () => {
    const line = "[2026-07-09 14:42:55.350] [Core] [DBUG] [aiocqhttp.aiocqhttp_platform_adapter:129]: [aiocqhttp] RawMessage <Event, {'self_id': 1, 'user_id': 2, 'message_type': 'group', 'raw_message': 'hi', 'nickname': 'Bob', 'group_id': '99'}>";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    assert(/平台消息|Bob|hi/.test(entry.summary), `summary=${entry.summary}`);
    const group = normalizeModuleGroup(entry);
    assert(group.className === "module-platform", `class=${group.className}`);
  });

  // 11) 高频模块标签：conversation_manager 不落 other
  test("会话管理模块标签", () => {
    const line = "[2026-07-09 12:00:01.000] [Plug] [DBUG] [managers.conversation_manager:88]: 添加消息完成";
    const entry = parseLogLine(line, mockFile([line]), 0, 0);
    const group = normalizeModuleGroup(entry);
    assert(group.className !== "module-other", `class=${group.className} label=${group.label}`);
    assert(/会话|conversation/i.test(group.label), `label=${group.label}`);
  });

  // 12) summarizePlainLog 直接：plugin 调度
  test("plugin -> 摘要", () => {
    const summary = summarizePlainLog("plugin -> astrbot - handle_session_control_agent", "plugin -> astrbot - handle_session_control_agent", {
      moduleName: "method.star_request:46",
    });
    assert(/插件调度/.test(summary), `summary=${summary}`);
  });

  for (const item of cases) {
    try {
      item.fn();
      passed += 1;
      console.log(`ok  ${item.name}`);
    } catch (err) {
      console.error(`FAIL ${item.name}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});