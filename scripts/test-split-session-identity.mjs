#!/usr/bin/env node
/**
 * 会话身份：从第一条 trace 起同一 conversationKey 只对应一个 session（非事后合并）。
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

function entry({
  id,
  spanId,
  action,
  timestamp,
  senderName = "江楠",
  umo = "糯小喵:GroupMessage:777879783",
  messageOutline,
  response = "",
  personaId = "精小喵_group_lxfight",
  providerId = "openai",
  model = "test",
}) {
  const fields = {
    persona_id: personaId,
    resp: response,
    chat_provider: { id: providerId, model },
    stats: action === "astr_agent_complete"
      ? {
        start_time: timestamp / 1000 - 2,
        end_time: timestamp / 1000,
        time_to_first_token: 0,
        token_usage: { output: 8 },
      }
      : {},
  };
  return {
    id,
    raw: JSON.stringify({ action, span_id: spanId }),
    message: `${action} ${spanId}`,
    summary: `${action} ${spanId}`,
    timestamp,
    moduleName: "trace",
    scope: "trace",
    fileMtime: 0,
    globalIndex: 0,
    trace: {
      action,
      spanId,
      time: timestamp,
      senderName,
      umo,
      messageOutline,
      response,
      personaId,
      providerId,
      model,
      generationMs: action === "astr_agent_complete" ? 2000 : null,
      durationMs: action === "astr_agent_complete" ? 2000 : null,
      timeToFirstTokenMs: null,
      tokenUsage: action === "astr_agent_complete" ? { output: 8 } : {},
    },
  };
}

async function main() {
  const {
    buildTraceInsights,
    normalizeMessageOutlineForMatch,
    conversationKeyFrom,
    messageDedupeKey,
  } = await importBrowserModule("web/js/log/analytics.js");

  let passed = 0;
  const cases = [];
  function run(name, fn) {
    cases.push({ name, fn });
  }

  run("normalize At prefix/suffix", () => {
    const a = normalizeMessageOutlineForMatch("[At:3283689683] 摸摸头");
    const b = normalizeMessageOutlineForMatch("摸摸头 [At:3283689683]");
    assert(a && a === b, `a=${a} b=${b}`);
    assert(
      messageDedupeKey("江楠", "[At:1] 摸摸头") === messageDedupeKey("江楠", "摸摸头 [At:1]"),
      "dedupe key",
    );
  });

  run("At 前后缀双 span → 一条会话 + alias", () => {
    const t0 = 1_700_000_000_000;
    const entries = [
      entry({
        id: "e1",
        spanId: "span-pre",
        action: "sel_persona",
        timestamp: t0,
        messageOutline: "[At:3283689683] 摸摸头",
      }),
      entry({
        id: "e2",
        spanId: "span-agent",
        action: "astr_agent_prepare",
        timestamp: t0 + 6500,
        messageOutline: "摸摸头 [At:3283689683]",
      }),
      entry({
        id: "e3",
        spanId: "span-agent",
        action: "astr_agent_complete",
        timestamp: t0 + 9000,
        messageOutline: "摸摸头 [At:3283689683]",
        response: "好呀",
      }),
    ];
    const insights = buildTraceInsights(entries);
    const all = insights.allTraceSessions || [];
    const visible = insights.sessions || [];
    assert(all.length === 1, `allTraceSessions=${all.length}`);
    assert(visible.length === 1, `visible=${visible.length}`);
    const s = all[0];
    assert(s.spanId === "span-pre", `primary=${s.spanId}`);
    assert((s.aliasSpanIds || []).includes("span-agent"), `aliases=${JSON.stringify(s.aliasSpanIds)}`);
    assert(s.status === "complete", `status=${s.status}`);
    assert(s.enteredAgentFlow === true, "enteredAgentFlow");
    const messageIns = (insights.events || []).filter((e) => e.type === "message_in" && e.spanId === s.spanId);
    // 合成 message_in 只一次（可能还有 plain，这里只看 trace 挂到 session 的）
    const sessionMessageIns = messageIns.length;
    assert(sessionMessageIns === 1, `message_in count=${sessionMessageIns}`);
  });

  run("完成后再发同文案 → 两条会话", () => {
    const t0 = 1_700_100_000_000;
    const entries = [
      entry({
        id: "a1",
        spanId: "s1",
        action: "sel_persona",
        timestamp: t0,
        messageOutline: "[At:1] 摸摸头",
      }),
      entry({
        id: "a2",
        spanId: "s1b",
        action: "astr_agent_complete",
        timestamp: t0 + 5000,
        messageOutline: "摸摸头 [At:1]",
        response: "1",
      }),
      entry({
        id: "b1",
        spanId: "s2",
        action: "sel_persona",
        timestamp: t0 + 60_000,
        messageOutline: "[At:1] 摸摸头",
      }),
      entry({
        id: "b2",
        spanId: "s2b",
        action: "astr_agent_complete",
        timestamp: t0 + 65_000,
        messageOutline: "摸摸头 [At:1]",
        response: "2",
      }),
    ];
    const insights = buildTraceInsights(entries);
    assert((insights.allTraceSessions || []).length === 2, `all=${insights.allTraceSessions?.length}`);
    assert((insights.sessions || []).length === 2, `vis=${insights.sessions?.length}`);
  });

  run("不同正文不合并", () => {
    const t0 = 1_700_200_000_000;
    const entries = [
      entry({
        id: "c1",
        spanId: "x1",
        action: "sel_persona",
        timestamp: t0,
        messageOutline: "[At:1] 摸摸头",
      }),
      entry({
        id: "c2",
        spanId: "x2",
        action: "sel_persona",
        timestamp: t0 + 3000,
        messageOutline: "[At:1] 摸摸肚子",
      }),
    ];
    const insights = buildTraceInsights(entries);
    assert((insights.allTraceSessions || []).length === 2, `all=${insights.allTraceSessions?.length}`);
  });

  run("conversationKey 含 umo", () => {
    const k1 = conversationKeyFrom({
      umo: "A:GroupMessage:1",
      senderName: "江楠",
      messageOutline: "[At:1] hi",
    });
    const k2 = conversationKeyFrom({
      umo: "B:GroupMessage:2",
      senderName: "江楠",
      messageOutline: "hi [At:1]",
    });
    assert(k1 && k2 && k1 !== k2, `k1=${k1} k2=${k2}`);
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