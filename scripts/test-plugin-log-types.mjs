#!/usr/bin/env node
/**
 * 已装插件 plain 日志类型识别（脱敏真实样例）。
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
  const { parseLogLine } = await importBrowserModule("web/js/log/parser.js");
  const {
    plainLogEvent,
    isPlainToolCallLog,
    isPlainProviderResponseLog,
    normalizeModuleGroup,
  } = await importBrowserModule("web/js/log/analytics.js");
  const { IMPORTANT_EVENT_TYPES } = await importBrowserModule("web/js/config.js");

  let passed = 0;
  const cases = [];
  function test(name, fn) {
    cases.push({ name, fn });
  }

  function parse(line) {
    return parseLogLine(line, mockFile([line]), 0, 0);
  }

  test("Debounce 完整概率 → debounce + 模块中文", () => {
    const line =
      "[2026-07-13 15:33:38.890] [Plug] [DBUG] [astrbot_plugin_debounce.main:744]: 完整概率: 0.99 | 判定: 发送";
    const entry = parse(line);
    const event = plainLogEvent(entry);
    assert(event?.type === "debounce", `event=${event?.type}`);
    assert(IMPORTANT_EVENT_TYPES.has("debounce"), "important");
    assert(/防抖|0\.99|发送/.test(entry.summary), `summary=${entry.summary}`);
    const group = normalizeModuleGroup(entry);
    assert(group.className === "module-plugin", `class=${group.className}`);
    assert(/防抖|Debounce/i.test(group.label), `label=${group.label}`);
  });

  test("Debounce [Debounce] 行", () => {
    const line =
      "[2026-07-13 15:34:31.583] [Plug] [DBUG] [astrbot_plugin_debounce.main:815]: [Debounce] LLM响应成功,清空buffer: 777879783:3867943205";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "debounce");
  });

  test("糯小喵 merge → message_merge", () => {
    const line =
      "[2026-07-13 18:09:32.636] [Plug] [INFO] [astrbot_plugin_nuoxiaomiao.main:435]: [糯小喵] merge release (idle): key=demo:GroupMessage:1:2 parts=1 len=4";
    const entry = parse(line);
    const event = plainLogEvent(entry);
    assert(event?.type === "message_merge", `event=${event?.type}`);
    assert(/合并|merge|糯小喵/i.test(entry.summary), `summary=${entry.summary}`);
    const group = normalizeModuleGroup(entry);
    assert(/糯小喵/.test(group.label), `label=${group.label}`);
  });

  test("糯小喵 dropped dialogue → message_merge", () => {
    const line =
      "[2026-07-13 18:09:33.614] [Plug] [INFO] [astrbot_plugin_nuoxiaomiao.main:238]: [糯小喵] dropped dialogue: session=demo:GroupMessage:1 sender=10001 count>=3";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "message_merge");
  });

  test("Heartflow 冷却 → heartflow", () => {
    const line =
      "[2026-07-13 15:33:10.166] [Plug] [DBUG] [astrbot_plugin_Heartflow.main:557]: 冷却中，距上次回复还有 25s";
    const entry = parse(line);
    const event = plainLogEvent(entry);
    assert(event?.type === "heartflow", `event=${event?.type}`);
    assert(/心流|冷却|25/.test(entry.summary), `summary=${entry.summary}`);
    const group = normalizeModuleGroup(entry);
    assert(/心流|Heartflow/i.test(group.label), `label=${group.label}`);
  });

  test("meme_manager → meme", () => {
    const line =
      "[2026-07-13 15:33:49.939] [Plug] [INFO] [meme_manager.main:1165]: [meme_manager] 去重后的最终表情列表: []";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "meme");
    const group = normalizeModuleGroup(entry);
    assert(/表情/.test(group.label), `label=${group.label}`);
  });

  test("AstrNa 压缩 → context_compact", () => {
    const line =
      "[2026-07-13 15:33:44.301] [Plug] [DBUG] [modules.group_chat_context_optimizer:1032]: AstrNa 已压缩群聊上下文: session=demo:GroupMessage:1";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "context_compact");
    assert(/压缩|AstrNa/.test(entry.summary), `summary=${entry.summary}`);
  });

  test("Splitter Plug → output_pipeline，不吞核心 pipeline", () => {
    const out =
      "[2026-07-13 15:34:31.606] [Plug] [DBUG] [step.split:366]: [Splitter] 消息被分为 2 段";
    const entry = parse(out);
    assert(plainLogEvent(entry)?.type === "output_pipeline", "splitter");
    assert(/分段|2/.test(entry.summary), `summary=${entry.summary}`);

    const core =
      "[2026-07-09 13:49:50.000] [Core] [DBUG] [pipeline.scheduler:93]: pipeline execution completed.";
    const coreEntry = parse(core);
    assert(plainLogEvent(coreEntry)?.type === "pipeline", `core=${plainLogEvent(coreEntry)?.type}`);
  });

  test("智能引用 Plug core.pipeline → output_pipeline", () => {
    const line =
      "[2026-07-13 15:34:31.604] [Plug] [DBUG] [core.pipeline:105]: 智能引用已登记，等待首条实际发送消息判断, msg_id=1, threshold=1";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "output_pipeline");
  });

  test("群分析标签 → group_analysis", () => {
    const line =
      "[2026-07-13 12:00:00.000] [Plug] [INFO] [utils.logger:25]: [群分析插件] 群 123 自动分析任务执行成功";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "group_analysis", `event=${plainLogEvent(entry)?.type}`);
  });

  test("SpectreCore 大模型回复 → proactive", () => {
    const line =
      "[2026-07-13 15:36:09.782] [Plug] [DBUG] [spectrecore.main:81]: 收到大模型回复喵: LLMResponse(role='assistant')";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "proactive");
    const group = normalizeModuleGroup(entry);
    assert(/SpectreCore/i.test(group.label), `label=${group.label}`);
  });

  test("关系本 → relationship", () => {
    const line =
      "[2026-07-13 15:33:45.612] [Plug] [INFO] [astrbot_plugin_yeli_relationship.main:1498]: [关系本] 主动维护已更新 uid=1 scope=group:1 fields=note_auto";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "relationship");
  });

  test("回归：ChatCompletion 不误报 tool / 仍为 provider_response", () => {
    const line =
      "[2026-07-09 13:49:30.665] [Core] [DBUG] [sources.openai_source:567]: completion: ChatCompletion(id='gen-abc', choices=[Choice(finish_reason='stop', message=ChatCompletionMessage(content='hi', tool_calls=None))])";
    const entry = parse(line);
    assert(isPlainProviderResponseLog(entry) === true);
    assert(isPlainToolCallLog(entry) == null);
    assert(plainLogEvent(entry)?.type === "provider_response");
  });

  test("回归：request_retry 仍为 warn 非 tool", () => {
    const line =
      "[2026-07-09 12:07:58.911] [Core] [WARN] [v4.26.4] [sources.request_retry:68]: [OpenAI] Request failed with retryable error; retrying (2/5): Error code: 429";
    const entry = parse(line);
    assert(plainLogEvent(entry)?.type === "warn");
    assert(isPlainToolCallLog(entry) == null);
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