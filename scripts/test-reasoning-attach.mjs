#!/usr/bin/env node
/**
 * 模型思考（reasoning）抽取 / 绑定 fixture。
 * 不依赖真实日志文件，用内存 entry 覆盖 repr / JSON / 别名 / 多会话绑定。
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

function plainEntry({ id, raw, timestamp, moduleName = "sources.openai_source" }) {
  return {
    id,
    raw,
    message: raw,
    summary: raw.slice(0, 80),
    timestamp,
    moduleName,
    fileMtime: 0,
  };
}

function completeTraceEntry({
  id,
  spanId,
  timestamp,
  response = "",
  messageOutline = "hello",
  senderName = "user",
  reasoningContent,
}) {
  const fields = {
    resp: response,
  };
  if (reasoningContent != null) fields.reasoning_content = reasoningContent;
  const payload = {
    type: "trace",
    action: "astr_agent_complete",
    span_id: spanId,
    time: timestamp / 1000,
    sender_name: senderName,
    message_outline: messageOutline,
    fields: {
      ...fields,
      stats: {
        start_time: timestamp / 1000 - 2,
        end_time: timestamp / 1000,
        token_usage: { output: 12 },
      },
      chat_provider: { id: "openai", model: "test" },
    },
  };
  return {
    id,
    raw: JSON.stringify(payload),
    message: `trace ${spanId}`,
    summary: `complete ${spanId}`,
    timestamp,
    moduleName: "trace",
    scope: "trace",
    fileMtime: 0,
    globalIndex: 0,
    // 直接挂上 buildTraceInfo 风格对象，避免 fixture 依赖 parser 细节
    trace: {
      action: "astr_agent_complete",
      spanId,
      time: timestamp,
      senderName,
      umo: "PrivateMessage:1",
      messageOutline,
      response,
      reasoningContent: reasoningContent || "",
      durationMs: 2000,
      timeToFirstTokenMs: 300,
      tokenUsage: { output: 12 },
      providerId: "openai",
      model: "test",
    },
  };
}

function prepareTraceEntry({ id, spanId, timestamp, messageOutline = "hello", senderName = "user" }) {
  return {
    id,
    raw: `prepare ${spanId}`,
    message: `prepare ${spanId}`,
    summary: `prepare ${spanId}`,
    timestamp,
    moduleName: "trace",
    scope: "trace",
    fileMtime: 0,
    globalIndex: 0,
    trace: {
      action: "astr_agent_prepare",
      spanId,
      time: timestamp,
      senderName,
      umo: "PrivateMessage:1",
      messageOutline,
      providerId: "openai",
      model: "test",
    },
  };
}

async function main() {
  const { extractPlainReasoningCandidate, buildTraceInsights } = await importBrowserModule(
    "web/js/log/analytics.js",
  );

  let passed = 0;
  const cases = [];

  function run(name, fn) {
    cases.push({ name, fn });
  }

  // --- extract: Python repr + ChatCompletion ---
  run("repr reasoning_content + ChatCompletion", () => {
    const entry = plainEntry({
      id: "e-repr",
      timestamp: 1_700_000_000_000,
      raw: "completion: ChatCompletion(id='cmp-1', choices=[Choice(message=ChatCompletionMessage(content='你好世界足够长的回复文本', reasoning_content='先分析用户意图再回答'))])",
    });
    const candidate = extractPlainReasoningCandidate(entry);
    assert(candidate, "应抽出候选");
    assert(candidate.reasoningContent.includes("先分析用户意图"), `reasoning: ${candidate.reasoningContent}`);
    assert(candidate.responseText.includes("你好世界"), `response: ${candidate.responseText}`);
    assert(candidate.kind === "completion", `kind=${candidate.kind}`);
  });

  // --- extract: JSON field ---
  run("JSON reasoning_content", () => {
    const entry = plainEntry({
      id: "e-json",
      timestamp: 1_700_000_000_100,
      raw: 'provider dump {"id":"x1","content":"最终回复文本足够长","reasoning_content":"JSON 形态的思考过程"}',
    });
    const candidate = extractPlainReasoningCandidate(entry);
    assert(candidate, "应抽出 JSON 候选");
    assert(candidate.reasoningContent === "JSON 形态的思考过程", candidate.reasoningContent);
    assert(candidate.responseText.includes("最终回复"), candidate.responseText);
  });

  // --- extract: alias thinking= ---
  run("alias thinking=", () => {
    const entry = plainEntry({
      id: "e-think",
      timestamp: 1_700_000_000_200,
      raw: "LLMResponse(content='短答', thinking='别名字段也能抽出思考')",
    });
    const candidate = extractPlainReasoningCandidate(entry);
    assert(candidate, "应抽出 thinking 别名");
    assert(candidate.reasoningContent.includes("别名字段"), candidate.reasoningContent);
  });

  // --- extract: no false positive without field ---
  run("no reasoning field → null", () => {
    const entry = plainEntry({
      id: "e-none",
      timestamp: 1_700_000_000_300,
      raw: "completion: ChatCompletion(id='c', content='only content')",
    });
    assert(extractPlainReasoningCandidate(entry) == null, "无思考字段应为空");
  });

  // --- extract: non-provider payload must not become candidate ---
  run("non-provider reasoning payload → null", () => {
    const entry = plainEntry({
      id: "e-noise",
      timestamp: 1_700_000_000_400,
      moduleName: "core.event_bus",
      raw: "debug dump reasoning_content='不该成为候选的噪音思考' content='x'",
    });
    assert(extractPlainReasoningCandidate(entry) == null, "非 provider 上下文不得成候选");
  });

  // --- attach: two sessions, different response ---
  run("two sessions bind own reasoning by response", () => {
    const t0 = 1_710_000_000_000;
    const entries = [
      prepareTraceEntry({ id: "p1", spanId: "span-a", timestamp: t0, messageOutline: "q1" }),
      completeTraceEntry({
        id: "c1",
        spanId: "span-a",
        timestamp: t0 + 5000,
        response: "回复A足够长的正文内容用于匹配",
        messageOutline: "q1",
      }),
      prepareTraceEntry({ id: "p2", spanId: "span-b", timestamp: t0 + 1000, messageOutline: "q2" }),
      completeTraceEntry({
        id: "c2",
        spanId: "span-b",
        timestamp: t0 + 6000,
        response: "回复B足够长的另一段正文内容",
        messageOutline: "q2",
      }),
      plainEntry({
        id: "r1",
        timestamp: t0 + 4800,
        raw: "completion: ChatCompletion(id='cmp-a', content='回复A足够长的正文内容用于匹配', reasoning_content='思考A专属')",
      }),
      plainEntry({
        id: "r2",
        timestamp: t0 + 5800,
        raw: "completion: ChatCompletion(id='cmp-b', content='回复B足够长的另一段正文内容', reasoning_content='思考B专属')",
      }),
    ];
    entries.forEach((entry, index) => {
      entry.globalIndex = index;
    });
    const insights = buildTraceInsights(entries);
    const bySpan = new Map((insights.allTraceSessions || []).map((s) => [s.spanId, s]));
    const a = bySpan.get("span-a");
    const b = bySpan.get("span-b");
    assert(a?.status === "complete", "session A complete");
    assert(b?.status === "complete", "session B complete");
    assert(a.reasoningContent === "思考A专属", `A reasoning=${a?.reasoningContent}`);
    assert(b.reasoningContent === "思考B专属", `B reasoning=${b?.reasoningContent}`);
    assert(a.reasoningSource === "plain", `A source=${a?.reasoningSource}`);
  });

  // --- attach: multi-candidate, no response text → nearest when well separated ---
  run("multi candidate without response → nearest when separated", () => {
    const t0 = 1_720_000_000_000;
    const entries = [
      prepareTraceEntry({ id: "p3", spanId: "span-c", timestamp: t0, messageOutline: "empty-resp" }),
      completeTraceEntry({
        id: "c3",
        spanId: "span-c",
        timestamp: t0 + 10_000,
        response: "",
        messageOutline: "empty-resp",
      }),
      plainEntry({
        id: "r-far",
        timestamp: t0 + 1000,
        raw: "completion: ChatCompletion(id='far', content='x', reasoning_content='远的思考')",
      }),
      plainEntry({
        id: "r-near",
        timestamp: t0 + 9500,
        raw: "completion: ChatCompletion(id='near', content='y', reasoning_content='近的思考')",
      }),
    ];
    entries.forEach((entry, index) => {
      entry.globalIndex = index;
    });
    const insights = buildTraceInsights(entries);
    const session = (insights.allTraceSessions || []).find((s) => s.spanId === "span-c");
    assert(session?.status === "complete", "session complete");
    assert(session.reasoningContent === "近的思考", `got=${session?.reasoningContent}`);
  });

  // --- attach: multi-candidate empty response too close → skip ---
  run("multi candidate empty response close in time → skip", () => {
    const t0 = 1_721_000_000_000;
    const completeTs = t0 + 10_000;
    const entries = [
      prepareTraceEntry({ id: "p3b", spanId: "span-c2", timestamp: t0, messageOutline: "empty-close" }),
      completeTraceEntry({
        id: "c3b",
        spanId: "span-c2",
        timestamp: completeTs,
        response: "",
        messageOutline: "empty-close",
      }),
      plainEntry({
        id: "r-a",
        timestamp: completeTs - 800,
        raw: "completion: ChatCompletion(id='a', content='x', reasoning_content='候选甲')",
      }),
      plainEntry({
        id: "r-b",
        timestamp: completeTs - 400,
        raw: "completion: ChatCompletion(id='b', content='y', reasoning_content='候选乙')",
      }),
    ];
    entries.forEach((entry, index) => {
      entry.globalIndex = index;
    });
    const insights = buildTraceInsights(entries);
    const session = (insights.allTraceSessions || []).find((s) => s.spanId === "span-c2");
    assert(session?.status === "complete", "session complete");
    assert(!session.reasoningContent, `should skip ambiguous bind, got=${session?.reasoningContent}`);
  });

  // --- attach: delayed plain log within +30s window ---
  run("plain log after complete within +30s window", () => {
    const t0 = 1_730_000_000_000;
    const completeTs = t0 + 5000;
    const entries = [
      prepareTraceEntry({ id: "p4", spanId: "span-d", timestamp: t0 }),
      completeTraceEntry({
        id: "c4",
        spanId: "span-d",
        timestamp: completeTs,
        response: "延迟落盘回复正文足够长",
      }),
      plainEntry({
        id: "r-late",
        timestamp: completeTs + 25_000,
        raw: "completion: ChatCompletion(id='late', content='延迟落盘回复正文足够长', reasoning_content='落盘偏晚的思考')",
      }),
    ];
    entries.forEach((entry, index) => {
      entry.globalIndex = index;
    });
    const insights = buildTraceInsights(entries);
    const session = (insights.allTraceSessions || []).find((s) => s.spanId === "span-d");
    assert(session?.reasoningContent === "落盘偏晚的思考", `got=${session?.reasoningContent}`);
  });

  // --- trace direct reasoning still wins ---
  run("trace reasoningContent preferred over plain", () => {
    const t0 = 1_740_000_000_000;
    const entries = [
      prepareTraceEntry({ id: "p5", spanId: "span-e", timestamp: t0 }),
      completeTraceEntry({
        id: "c5",
        spanId: "span-e",
        timestamp: t0 + 3000,
        response: "trace 直写回复",
        reasoningContent: "来自 trace 的思考",
      }),
      plainEntry({
        id: "r5",
        timestamp: t0 + 2900,
        raw: "completion: ChatCompletion(id='t', content='trace 直写回复', reasoning_content='来自 plain 的思考')",
      }),
    ];
    entries.forEach((entry, index) => {
      entry.globalIndex = index;
    });
    const insights = buildTraceInsights(entries);
    const session = (insights.allTraceSessions || []).find((s) => s.spanId === "span-e");
    assert(session?.reasoningContent === "来自 trace 的思考", `got=${session?.reasoningContent}`);
    assert(session?.reasoningSource === "trace", `source=${session?.reasoningSource}`);
  });

  // --- UI gate: complete + reasoning → 会出现「模型思考」步骤 ---
  run("UI gate: complete session with reasoning shows step", () => {
    const t0 = 1_750_000_000_000;
    const entries = [
      prepareTraceEntry({ id: "p6", spanId: "span-ui", timestamp: t0 }),
      completeTraceEntry({
        id: "c6",
        spanId: "span-ui",
        timestamp: t0 + 4000,
        response: "用于 UI 门闩的回复正文足够长",
      }),
      plainEntry({
        id: "r6",
        timestamp: t0 + 3900,
        raw: "completion: ChatCompletion(id='ui', content='用于 UI 门闩的回复正文足够长', reasoning_content='UI 可见的思考正文')",
      }),
    ];
    entries.forEach((entry, index) => {
      entry.globalIndex = index;
    });
    const insights = buildTraceInsights(entries);
    const session = (insights.sessions || insights.allTraceSessions || []).find((s) => s.spanId === "span-ui");
    assert(session, "session exists");
    assert(session.reasoningContent === "UI 可见的思考正文", `reasoning=${session?.reasoningContent}`);
    // 与 web/js/views/astrbot.js buildSessionJourney 同一门闩
    const showReasoningStep = Boolean(
      session.reasoningContent
      && (session.status === "complete" || session.displayStatus === "empty"),
    );
    assert(showReasoningStep, `UI gate failed status=${session.status} display=${session.displayStatus}`);
  });

  console.log("Reasoning extract/attach fixture");
  for (const item of cases) {
    try {
      item.fn();
      console.log(`  PASS  ${item.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL  ${item.name}`);
      console.error(`        ${err?.message || err}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 2;
});