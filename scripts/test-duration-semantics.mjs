#!/usr/bin/env node
/**
 * 耗时语义：wallMs（端到端）vs generationMs（stats 生成段）、TTFT≤0→null。
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

function approx(actual, expected, tol = 1) {
  return Math.abs(Number(actual) - Number(expected)) <= tol;
}

function completeEntry({
  id,
  spanId,
  startTsMs,
  endTsMs,
  genStartSec,
  genEndSec,
  ttft = 0,
  response = "ok",
}) {
  const stats = {
    start_time: genStartSec,
    end_time: genEndSec,
    time_to_first_token: ttft,
    token_usage: { output: 8 },
  };
  const payload = {
    action: "astr_agent_complete",
    span_id: spanId,
    time: endTsMs / 1000,
    sender_name: "user",
    umo: "PrivateMessage:1",
    message_outline: "hello",
    fields: {
      resp: response,
      stats,
      chat_provider: { id: "openai", model: "test" },
    },
  };
  return {
    id,
    raw: JSON.stringify(payload),
    message: `complete ${spanId}`,
    summary: `complete ${spanId}`,
    timestamp: endTsMs,
    moduleName: "trace",
    scope: "trace",
    fileMtime: 0,
    globalIndex: 0,
    // 由 parser.buildTraceInfo 注入；fixture 直接挂等价对象
    trace: null,
  };
}

async function main() {
  const {
    normalizeEpochMs,
    durationMsFromStats,
    timeToFirstTokenMsFromStats,
    buildTraceInfo,
  } = await importBrowserModule("web/js/log/parser.js");
  const { buildTraceInsights } = await importBrowserModule("web/js/log/analytics.js");

  let passed = 0;
  const cases = [];

  function run(name, fn) {
    cases.push({ name, fn });
  }

  run("normalizeEpochMs: seconds and ms", () => {
    assert(normalizeEpochMs(1_700_000_000) === 1_700_000_000_000, "sec→ms");
    assert(normalizeEpochMs(1_700_000_000_000) === 1_700_000_000_000, "ms stays");
    assert(normalizeEpochMs(0) == null, "0 invalid");
    assert(normalizeEpochMs(-1) == null, "neg invalid");
  });

  run("durationMsFromStats: second epoch pair", () => {
    const ms = durationMsFromStats({ start_time: 1000, end_time: 1004.56 });
    assert(approx(ms, 4560), `got ${ms}`);
  });

  run("durationMsFromStats: ms epoch pair", () => {
    const ms = durationMsFromStats({
      start_time: 1_700_000_000_000,
      end_time: 1_700_000_004_560,
    });
    assert(approx(ms, 4560), `got ${ms}`);
  });

  run("timeToFirstTokenMsFromStats: 0 / missing → null", () => {
    assert(timeToFirstTokenMsFromStats({ time_to_first_token: 0 }) == null, "0");
    assert(timeToFirstTokenMsFromStats({ time_to_first_token: 0.0 }) == null, "0.0");
    assert(timeToFirstTokenMsFromStats({}) == null, "missing");
    assert(timeToFirstTokenMsFromStats({ time_to_first_token: 0.12 }) === 120, "0.12s→120ms");
  });

  run("buildTraceInfo: generationMs + invalid ttft", () => {
    const trace = buildTraceInfo({
      action: "astr_agent_complete",
      span_id: "s1",
      time: 1_700_000_043,
      fields: {
        resp: "hi",
        stats: {
          start_time: 1_700_000_000,
          end_time: 1_700_000_004.56,
          time_to_first_token: 0,
          token_usage: { output: 1 },
        },
        chat_provider: { id: "p", model: "m" },
      },
    });
    assert(approx(trace.generationMs, 4560), `gen=${trace.generationMs}`);
    assert(approx(trace.durationMs, 4560), `compat duration=${trace.durationMs}`);
    assert(trace.timeToFirstTokenMs == null, `ttft=${trace.timeToFirstTokenMs}`);
  });

  run("session wallMs vs generationMs", () => {
    const startTs = 1_700_000_000_000;
    const endTs = startTs + 43_000;
    const genStart = startTs / 1000 + 10; // 模型 10s 后开始
    const genEnd = genStart + 4.56;
    const spanId = "wall-vs-gen";

    const prepare = {
      id: "e-prepare",
      raw: "prepare",
      message: "prepare",
      summary: "prepare",
      timestamp: startTs,
      moduleName: "trace",
      scope: "trace",
      fileMtime: 0,
      globalIndex: 0,
      trace: {
        action: "astr_agent_prepare",
        spanId,
        time: startTs,
        senderName: "user",
        umo: "PrivateMessage:1",
        messageOutline: "hello",
        providerId: "openai",
        model: "test",
      },
    };

    const completePayload = {
      action: "astr_agent_complete",
      span_id: spanId,
      time: endTs / 1000,
      sender_name: "user",
      umo: "PrivateMessage:1",
      message_outline: "hello",
      fields: {
        resp: "reply body",
        stats: {
          start_time: genStart,
          end_time: genEnd,
          time_to_first_token: 0.0,
          token_usage: { output: 12 },
        },
        chat_provider: { id: "openai", model: "test" },
      },
    };
    const completeTrace = buildTraceInfo(completePayload);
    const complete = {
      id: "e-complete",
      raw: JSON.stringify(completePayload),
      message: "complete",
      summary: "complete",
      timestamp: endTs,
      moduleName: "trace",
      scope: "trace",
      fileMtime: 0,
      globalIndex: 1,
      trace: {
        ...completeTrace,
        spanId,
        senderName: "user",
        umo: "PrivateMessage:1",
        messageOutline: "hello",
      },
    };

    const insights = buildTraceInsights([prepare, complete]);
    const session = (insights.allTraceSessions || insights.sessions || []).find((s) => s.spanId === spanId)
      || insights.sessions?.[0];
    assert(session, "session missing");
    assert(session.status === "complete", `status=${session.status}`);
    assert(approx(session.generationMs, 4560), `generationMs=${session.generationMs}`);
    assert(approx(session.wallMs, 43_000), `wallMs=${session.wallMs}`);
    // durationMs 兼容字段 = 墙钟优先
    assert(approx(session.durationMs, 43_000), `durationMs=${session.durationMs}`);
    assert(session.timeToFirstTokenMs == null, `ttft should be null, got=${session.timeToFirstTokenMs}`);
    assert(session.wallMs >= session.generationMs, "wall should be >= generation");
  });

  for (const { name, fn } of cases) {
    try {
      fn();
      passed += 1;
      console.log(`ok  ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}`);
      console.error(err?.stack || err);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\n${passed}/${cases.length} passed`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});