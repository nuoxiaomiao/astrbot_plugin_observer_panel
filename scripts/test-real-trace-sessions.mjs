#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_LOG_FILES = ["astrbot.trace.log", "astrbot.log"];
const DEFAULT_LOGS_DIR = "data/logs";
const DEFAULT_TAIL_LINES = 3000;
const SPLIT_PAIR_WINDOW_MS = 2 * 60 * 1000;

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const moduleUrlCache = new Map();

globalThis.window = globalThis.window || { location: { search: "" } };
globalThis.window.location = globalThis.window.location || { search: "" };
globalThis.window.location.search = globalThis.window.location.search || "";

function usage() {
  return [
    "Usage:",
    "  node scripts/test-real-trace-sessions.mjs",
    "  node scripts/test-real-trace-sessions.mjs --logs-dir data/logs",
    "  node scripts/test-real-trace-sessions.mjs --file data/logs/astrbot.trace.log --file data/logs/astrbot.log",
    "  node scripts/test-real-trace-sessions.mjs --tail-lines 5000",
    "  node scripts/test-real-trace-sessions.mjs --contains text",
  ].join("\n");
}

function takeValue(argv, index, name) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    logsDir: DEFAULT_LOGS_DIR,
    files: [],
    explicitFiles: false,
    tailLines: DEFAULT_TAIL_LINES,
    contains: "",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--logs-dir") {
      options.logsDir = takeValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith("--logs-dir=")) {
      options.logsDir = arg.slice("--logs-dir=".length);
    } else if (arg === "--file") {
      options.files.push(takeValue(argv, i, arg));
      options.explicitFiles = true;
      i += 1;
    } else if (arg.startsWith("--file=")) {
      options.files.push(arg.slice("--file=".length));
      options.explicitFiles = true;
    } else if (arg === "--tail-lines") {
      options.tailLines = Number(takeValue(argv, i, arg));
      i += 1;
    } else if (arg.startsWith("--tail-lines=")) {
      options.tailLines = Number(arg.slice("--tail-lines=".length));
    } else if (arg === "--contains") {
      options.contains = takeValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith("--contains=")) {
      options.contains = arg.slice("--contains=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.tailLines) || options.tailLines <= 0) {
    throw new Error("--tail-lines must be a positive integer");
  }

  if (!options.files.length) {
    options.files = DEFAULT_LOG_FILES.map((file) => path.join(options.logsDir, file));
  }

  return options;
}

function logFileCandidates(filePath, allowLayoutFallback) {
  if (path.isAbsolute(filePath)) return [filePath];

  const candidates = [path.resolve(filePath)];
  const normalized = filePath.replace(/\\/g, "/");
  if (allowLayoutFallback && normalized.startsWith(`${DEFAULT_LOGS_DIR}/`)) {
    candidates.push(path.resolve(repoRoot, "..", "..", "logs", path.basename(filePath)));
  }
  return [...new Set(candidates)];
}

async function resolveReadableLogFile(filePath, allowLayoutFallback) {
  const candidates = logFileCandidates(filePath, allowLayoutFallback);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (err) {
      // Try the next candidate and keep the original path for the final error.
    }
  }
  return candidates[0];
}

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

async function assertReadable(filePath) {
  await access(filePath);
  return stat(filePath);
}

async function readTailLines(filePath, maxLines) {
  const fileStat = await assertReadable(filePath);
  const tail = [];
  let lineCount = 0;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    lineCount += 1;
    if (tail.length >= maxLines) tail.shift();
    tail.push(line);
  }

  return {
    path: filePath,
    mtime: Math.floor(fileStat.mtimeMs / 1000),
    size: fileStat.size,
    baseLine: Math.max(0, lineCount - tail.length),
    lineCount,
    lines: tail,
  };
}

function buildFileDescriptor(tailInfo) {
  return {
    source: "astrbot",
    sourceName: "AstrBot",
    path: tailInfo.path,
    mtime: tailInfo.mtime,
    size: tailInfo.size,
    base_line: tailInfo.baseLine,
    line_count: tailInfo.lineCount,
    readable: true,
  };
}

function compactText(text, maxLength = 120) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "--";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function formatTime(ms) {
  if (!ms) return "--";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function sessionStartMs(session) {
  return Number(session?.startTs || session?.lastTs || 0) || 0;
}

function sessionEvents(session, eventById) {
  return (session.events || [])
    .map((id) => eventById.get(id))
    .filter(Boolean)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
}

function eventTypeChain(session, eventById) {
  const chain = sessionEvents(session, eventById).map((event) => event.type);
  return chain.length ? chain.join(" -> ") : "--";
}

function sessionSearchText(session, eventById) {
  const eventsText = sessionEvents(session, eventById)
    .map((event) => `${event.type} ${event.title} ${event.detail} ${event.meta} ${event.raw}`)
    .join(" ");
  return [
    session.spanId,
    ...(session.aliasSpanIds || []),
    session.senderName,
    session.umo,
    session.messageOutline,
    session.personaId,
    session.status,
    session.response,
    eventsText,
  ].join(" ").toLowerCase();
}

function hasOnlyPreSessionEvents(session, eventById) {
  const allowed = new Set(["message_in", "persona"]);
  const types = sessionEvents(session, eventById).map((event) => event.type);
  return types.length > 0 && types.every((type) => allowed.has(type));
}

function isStuckPreSession(session, eventById) {
  return session?.status === "running"
    && !session.enteredAgentFlow
    && hasOnlyPreSessionEvents(session, eventById);
}

function splitPairKey(session, messageDedupeKey) {
  const message = compactText(session?.messageOutline || "", 160);
  if (!message || message === "--") return "";
  return messageDedupeKey(session?.senderName || "", message);
}

function isSplitShapedPair(a, b) {
  const aPre = a.status === "running" && !a.enteredAgentFlow;
  const bPre = b.status === "running" && !b.enteredAgentFlow;
  const aAgent = Boolean(a.enteredAgentFlow || a.completed);
  const bAgent = Boolean(b.enteredAgentFlow || b.completed);
  return (aPre && bAgent) || (bPre && aAgent);
}

function findPossibleSplitPairs(sessions, messageDedupeKey) {
  const pairs = [];
  const sorted = [...sessions].sort((a, b) => sessionStartMs(a) - sessionStartMs(b));

  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    const aKey = splitPairKey(a, messageDedupeKey);
    if (!aKey) continue;

    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j];
      const delta = Math.abs(sessionStartMs(b) - sessionStartMs(a));
      if (delta > SPLIT_PAIR_WINDOW_MS) break;
      if (a.spanId === b.spanId) continue;
      if (aKey !== splitPairKey(b, messageDedupeKey)) continue;
      if (!isSplitShapedPair(a, b)) continue;

      const aUmo = String(a.umo || "").trim();
      const bUmo = String(b.umo || "").trim();
      if (aUmo && bUmo && aUmo !== bUmo) continue;

      pairs.push({ first: a, second: b, deltaMs: delta });
    }
  }

  return pairs;
}

function riskLabels(session, eventById) {
  const labels = [];
  if ((session.aliasSpanIds || []).length) labels.push("MERGED_SPLIT_SESSION");
  if (isStuckPreSession(session, eventById)) labels.push("STUCK_PRE_SESSION");
  return labels;
}

function printSession(session, eventById) {
  const labels = riskLabels(session, eventById);
  const aliases = (session.aliasSpanIds || []).join(", ") || "--";
  const prefix = labels.length ? `[${labels.join(", ")}] ` : "";
  console.log(`${prefix}spanId: ${session.spanId}`);
  console.log(`  aliases: ${aliases}`);
  console.log(`  time: ${formatTime(session.startTs)} -> ${formatTime(session.lastTs)}`);
  console.log(`  sender: ${compactText(session.senderName, 80)}`);
  console.log(`  message: ${compactText(session.messageOutline, 180)}`);
  console.log(`  rule: ${session.personaId || "--"}`);
  console.log(`  status: ${session.status || "--"}; enteredAgentFlow: ${Boolean(session.enteredAgentFlow)}; tools: ${(session.tools || []).length}`);
  console.log(`  reply: ${compactText(session.response, 180)}`);
  console.log(`  events: ${eventTypeChain(session, eventById)}`);
}

function printPairs(pairs) {
  pairs.forEach((pair) => {
    console.log("[POSSIBLE_SPLIT_PAIR]");
    console.log(`  first: ${pair.first.spanId} (${pair.first.status || "--"}, ${formatTime(pair.first.startTs)})`);
    console.log(`  second: ${pair.second.spanId} (${pair.second.status || "--"}, ${formatTime(pair.second.startTs)})`);
    console.log(`  delta: ${(pair.deltaMs / 1000).toFixed(1)}s`);
    console.log(`  sender: ${compactText(pair.first.senderName || pair.second.senderName, 80)}`);
    console.log(`  message: ${compactText(pair.first.messageOutline || pair.second.messageOutline, 180)}`);
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const filePaths = [];
  for (const file of options.files) {
    filePaths.push(await resolveReadableLogFile(file, !options.explicitFiles));
  }
  const unreadable = [];
  const files = [];
  for (const filePath of filePaths) {
    try {
      files.push(await readTailLines(filePath, options.tailLines));
    } catch (err) {
      unreadable.push({ filePath, error: err });
    }
  }

  if (unreadable.length) {
    console.error("Log files are not readable:");
    unreadable.forEach((item) => {
      console.error(`  - ${item.filePath}: ${item.error.message}`);
    });
    process.exitCode = 2;
    return;
  }

  const [{ parseLogLine }, { buildTraceInsights, messageDedupeKey }] = await Promise.all([
    importBrowserModule("web/js/log/parser.js"),
    importBrowserModule("web/js/log/analytics.js"),
  ]);

  const entries = [];
  files.forEach((tailInfo) => {
    const file = buildFileDescriptor(tailInfo);
    tailInfo.lines.forEach((line, lineIndex) => {
      if (!String(line || "").trim()) return;
      entries.push(parseLogLine(line, file, lineIndex, entries.length));
    });
  });

  const traceEntryCount = entries.filter((entry) => entry.trace).length;
  if (!traceEntryCount) {
    console.error("No trace entries found in the selected log tail.");
    process.exitCode = 2;
    return;
  }

  const insights = buildTraceInsights(entries);
  const eventById = new Map((insights.events || []).map((event) => [event.id, event]));
  const allSessions = insights.allTraceSessions || [];
  const visibleSessionIds = new Set((insights.sessions || []).map((session) => session.spanId));
  const contains = String(options.contains || "").trim().toLowerCase();
  const selectedSessions = contains
    ? allSessions.filter((session) => sessionSearchText(session, eventById).includes(contains))
    : allSessions;
  const visibleSelectedSessions = selectedSessions.filter((session) => visibleSessionIds.has(session.spanId));

  const stuckPreSessions = selectedSessions.filter((session) => isStuckPreSession(session, eventById));
  const mergedSessions = selectedSessions.filter((session) => (session.aliasSpanIds || []).length);
  const possiblePairs = findPossibleSplitPairs(selectedSessions, messageDedupeKey);

  console.log("Real trace session merge check");
  console.log(`Tail lines per file: ${options.tailLines}`);
  console.log("Files:");
  files.forEach((file) => {
    console.log(`  - ${file.path}: read ${file.lines.length}/${file.lineCount} lines`);
  });
  console.log(`Entries: ${entries.length}; trace entries: ${traceEntryCount}`);
  console.log(`Sessions: ${selectedSessions.length} selected (${visibleSelectedSessions.length} frontend-visible) / ${allSessions.length} total`);
  if (contains) console.log(`Filter: contains "${options.contains}"`);
  console.log("");

  if (!selectedSessions.length) {
    console.log("No sessions matched the selected criteria.");
  } else {
    console.log("Session summary:");
    selectedSessions.forEach((session, index) => {
      if (index) console.log("");
      printSession(session, eventById);
    });
  }

  console.log("");
  console.log("Diagnostics:");
  console.log(`  MERGED_SPLIT_SESSION: ${mergedSessions.length}`);
  console.log(`  STUCK_PRE_SESSION: ${stuckPreSessions.length}`);
  console.log(`  POSSIBLE_SPLIT_PAIR: ${possiblePairs.length}`);
  if (possiblePairs.length) {
    console.log("");
    printPairs(possiblePairs);
  }

  process.exitCode = stuckPreSessions.length || possiblePairs.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 2;
});
