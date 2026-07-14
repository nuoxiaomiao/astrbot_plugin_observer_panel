#!/usr/bin/env node
/**
 * 模型请求快照：astr_agent_prepare → session.modelRequest
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
  return import(await browserModuleDataUrl(path.resolve(repoRoot, relativePath)));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { buildTraceInfo, normalizeToolNames } = await importBrowserModule("web/js/log/parser.js");
  const { buildTraceInsights } = await importBrowserModule("web/js/log/analytics.js");

  let passed = 0;
  const cases = [];
  function run(name, fn) {
    cases.push({ name, fn });
  }

  run("normalizeToolNames array/string", () => {
    assert(normalizeToolNames(["a", "b"]).join(",") === "a,b", "array");
    assert(normalizeToolNames("x, y").join(",") === "x,y", "csv");
    assert(normalizeToolNames('["p","q"]').join(",") === "p,q", "json");
  });

  run("buildTraceInfo extracts prepare snapshot", () => {
    const trace = buildTraceInfo({
      action: "astr_agent_prepare",
      span_id: "s1",
      time: 1_700_000_000,
      message_outline: "hello",
      fields: {
        system_prompt: "You are a cat.",
        tools: ["tool_a", "tool_b"],
        stream: false,
        chat_provider: { id: "prov", model: "m1" },
      },
    });
    assert(trace.systemPrompt === "You are a cat.", `prompt=${trace.systemPrompt}`);
    assert(trace.toolNames.join(",") === "tool_a,tool_b", `tools=${trace.toolNames}`);
    assert(trace.stream === false, `stream=${trace.stream}`);
    assert(trace.providerId === "prov" && trace.model === "m1", "provider");
  });

  run("session.modelRequest from prepare", () => {
    const t0 = 1_700_300_000_000;
    const entries = [
      {
        id: "e-prepare",
        raw: "prepare",
        message: "prepare",
        summary: "prepare",
        timestamp: t0,
        moduleName: "trace",
        scope: "trace",
        fileMtime: 0,
        globalIndex: 0,
        trace: {
          action: "astr_agent_prepare",
          spanId: "span-req",
          time: t0,
          senderName: "user",
          umo: "PrivateMessage:1",
          messageOutline: "hi",
          systemPrompt: "SYS PROMPT BODY",
          toolNames: ["search", "time"],
          stream: false,
          providerId: "openai",
          model: "gpt-test",
        },
      },
      {
        id: "e-complete",
        raw: "complete",
        message: "complete",
        summary: "complete",
        timestamp: t0 + 3000,
        moduleName: "trace",
        scope: "trace",
        fileMtime: 0,
        globalIndex: 1,
        trace: {
          action: "astr_agent_complete",
          spanId: "span-req",
          time: t0 + 3000,
          senderName: "user",
          umo: "PrivateMessage:1",
          messageOutline: "hi",
          response: "hello back",
          generationMs: 2000,
          durationMs: 2000,
          timeToFirstTokenMs: null,
          tokenUsage: { output: 3 },
          providerId: "openai",
          model: "gpt-test",
        },
      },
    ];
    const insights = buildTraceInsights(entries);
    const session = (insights.sessions || [])[0];
    assert(session, "session missing");
    assert(session.modelRequest, "modelRequest missing");
    assert(session.modelRequest.systemPrompt === "SYS PROMPT BODY", session.modelRequest.systemPrompt);
    assert(session.modelRequest.toolNames.join(",") === "search,time", "tools");
    assert(session.modelRequest.logEntryId === "e-prepare", "logEntryId");
    assert(session.modelRequest.providerId === "openai", "provider");
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