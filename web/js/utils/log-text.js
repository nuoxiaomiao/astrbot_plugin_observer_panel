// ============================================================================
// 工具函数 - 文本/日志解析
// ============================================================================

export function compactText(text, maxLength = 420) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function compactJson(value, maxLength = 220) {
  if (value == null || value === "") return "";
  try {
    return compactText(typeof value === "string" ? value : JSON.stringify(value), maxLength);
  } catch (err) {
    return compactText(String(value), maxLength);
  }
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function extractResultId(text) {
  const value = String(text || "");
  return (value.match(/['"]id['"]:\s*['"]([^'"]+)['"]/) || [])[1] || "";
}

export function extractResultTs(text) {
  const match = String(text || "").match(/['"]ts['"]:\s*([0-9.]+)/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 与 parser.normalizeEpochMs 一致：>1e12 已是 ms，否则按秒
  if (n > 1e12) return Math.round(n);
  if (n > 1e9) return Math.round(n * 1000);
  return Math.round(n * 1000);
}

export function extractQuotedField(text, name) {
  const pattern = new RegExp(`['"]${name}['"]:\\s*['"]([^'"]*)['"]`);
  const match = String(text || "").match(pattern);
  return match ? match[1] : "";
}

export function summarizeJsonLog(data) {
  if (!data || typeof data !== "object") return "";
  const fields = data.fields && typeof data.fields === "object" ? data.fields : {};
  const parts = [];
  if (data.action) parts.push(data.action);
  if (data.sender_name) parts.push(`发送者 ${data.sender_name}`);
  if (data.message_outline) parts.push(`消息 ${data.message_outline}`);
  if (fields.resp) parts.push(`回复 ${fields.resp}`);
  if (fields.tool_name?.name) parts.push(`工具 ${fields.tool_name.name}`);
  if (fields.tool_result) parts.push(`工具结果 ${fields.tool_result}`);
  if (!parts.length && data.name) parts.push(data.name);
  return compactText(parts.join(" | ") || JSON.stringify(data), 520);
}

function extractReprQuoted(text, fieldName) {
  const source = String(text || "");
  const pattern = new RegExp(`${fieldName}=(['"])([\\s\\S]*?)\\1`);
  const match = source.match(pattern);
  if (!match) return "";
  return String(match[2] || "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function shortId(value, max = 18) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function previewText(value, max = 48) {
  return compactText(String(value || "").replace(/\s+/g, " "), max);
}

/**
 * 按真实 AstrBot plain 形态生成短摘要。
 * @param {string} message
 * @param {string} raw
 * @param {{ moduleName?: string, scope?: string }} [meta]
 */
export function summarizePlainLog(message, raw, meta = {}) {
  const sourceText = String(message || raw || "");
  const full = String(raw || message || "");
  const moduleName = String(meta.moduleName || "");

  // event_bus 入站： [频道] [bot(platform)] 发送者/id: 内容
  if (/core\.event_bus/i.test(moduleName) || /core\.event_bus/i.test(full)) {
    const match = sourceText.match(/(?:\[[^\]]+\]\s*)+([^/\n:]+)\/([^:\n]+):\s*(.*)$/);
    if (match) {
      const channel = (sourceText.match(/^\[([^\]]+)\]/) || [])[1] || "";
      const channelLabel = /私聊|private|friend|direct/i.test(channel)
        ? "私聊"
        : (channel ? "频道" : "消息");
      const sender = match[1].trim();
      const content = previewText(match[3], 80) || "（空）";
      return compactText(`${channelLabel} · ${sender}: ${content}`, 520);
    }
  }

  // completion: ChatCompletion(...)
  if (/completion:\s*ChatCompletion/i.test(sourceText) || /\bChatCompletion\(/i.test(sourceText)) {
    const id = shortId(
      extractReprQuoted(sourceText, "id")
        || (sourceText.match(/\bid=['"]([^'"]+)['"]/i) || [])[1]
        || "",
    );
    const finish = extractReprQuoted(sourceText, "finish_reason")
      || (sourceText.match(/finish_reason=['"]([^'"]+)['"]/i) || [])[1]
      || "";
    const content = previewText(
      extractReprQuoted(sourceText, "content")
        || (sourceText.match(/content=['"]([\s\S]*?)['"](?:,|\))/) || [])[1]
        || "",
      56,
    );
    const parts = ["模型完成"];
    if (id) parts.push(`id=${id}`);
    if (finish) parts.push(`finish=${finish}`);
    if (content) parts.push(content);
    return compactText(parts.join(" · "), 520);
  }

  // LLMResponse(...)
  if (/\bLLMResponse\(/i.test(sourceText)) {
    const role = extractReprQuoted(sourceText, "role")
      || (sourceText.match(/role=['"]([^'"]+)['"]/i) || [])[1]
      || "";
    const text = previewText(
      extractReprQuoted(sourceText, "text")
        || extractReprQuoted(sourceText, "content")
        || "",
      56,
    );
    const parts = ["模型回复"];
    if (role) parts.push(role);
    if (text) parts.push(text);
    return compactText(parts.join(" · "), 520);
  }

  // RawMessage <Event ...
  if (sourceText.includes("RawMessage <Event")) {
    const sender = extractQuotedField(sourceText, "nickname")
      || extractQuotedField(sourceText, "card")
      || extractQuotedField(sourceText, "user_id");
    const rawMessage = extractQuotedField(sourceText, "raw_message");
    const group = extractQuotedField(sourceText, "group_name")
      || extractQuotedField(sourceText, "group_id");
    const messageType = extractQuotedField(sourceText, "message_type")
      || extractQuotedField(sourceText, "notice_type")
      || extractQuotedField(sourceText, "sub_type");
    const isPoke = /poke|戳/i.test(sourceText) || /poke/i.test(messageType);
    const isNotice = /notice|notify/i.test(messageType) || /'post_type':\s*'notice'/.test(sourceText);
    const kind = isPoke ? "戳一戳" : (isNotice ? "通知" : "平台消息");
    const parts = [kind];
    if (sender || rawMessage) parts.push(`${sender || "未知发送者"}: ${rawMessage || "事件数据"}`);
    if (group) parts.push(group);
    if (messageType && !isPoke) parts.push(messageType);
    return compactText(parts.join(" | "), 520);
  }

  // sources.request_retry / HTTP 429
  if (/request_retry/i.test(moduleName) || /request_retry/i.test(full) || /retrying\s*\(\d+\/\d+\)/i.test(sourceText)) {
    const attempt = (sourceText.match(/retrying\s*\((\d+\/\d+)\)/i) || [])[1] || "";
    const http = (sourceText.match(/\b(?:Error code|HTTP)\s*:?\s*(\d{3})\b/i) || [])[1] || "";
    const provider = (sourceText.match(/\[([^\]]+)\]\s*Request failed/i) || [])[1] || "";
    const parts = ["模型重试"];
    if (provider) parts.push(provider);
    if (http) parts.push(`HTTP ${http}`);
    if (attempt) parts.push(attempt);
    else if (/\b429\b/.test(sourceText)) parts.push("HTTP 429");
    return compactText(parts.join(" · "), 520);
  }

  // pipeline execution completed
  if (/pipeline execution completed/i.test(sourceText) || /pipeline\s*执行完毕/i.test(sourceText)) {
    return "Pipeline 完成";
  }

  // Debounce 判定
  if (/astrbot_plugin_debounce/i.test(moduleName) || /\[Debounce\]/i.test(sourceText) || /完整概率\s*:/i.test(sourceText)) {
    const score = (sourceText.match(/完整概率\s*:\s*([\d.]+)/i) || [])[1] || "";
    const decision = (sourceText.match(/判定\s*:\s*([^\n|]+)/i) || [])[1] || "";
    if (score || decision) {
      return compactText(`防抖 · ${[score && `p=${score}`, decision && decision.trim()].filter(Boolean).join(" · ")}`, 520);
    }
    const debounceAction = (sourceText.match(/\[Debounce\]\s*([^\n:]+)/i) || [])[1] || "";
    if (debounceAction) return compactText(`防抖 · ${debounceAction.trim()}`, 520);
  }

  // 糯小喵 merge / drop
  if (/\[糯小喵\]/i.test(sourceText) || /astrbot_plugin_nuoxiaomiao/i.test(moduleName)) {
    if (/dropped dialogue/i.test(sourceText)) {
      const sender = (sourceText.match(/sender=([^\s]+)/i) || [])[1] || "";
      return compactText(sender ? `糯小喵 · 丢弃对话 · ${sender}` : "糯小喵 · 丢弃对话", 520);
    }
    if (/merge release/i.test(sourceText)) {
      const parts = (sourceText.match(/parts=(\d+)/i) || [])[1] || "";
      return compactText(parts ? `糯小喵 · 合并释放 · parts=${parts}` : "糯小喵 · 合并释放", 520);
    }
    if (/merge started/i.test(sourceText)) return "糯小喵 · 开始合并";
    if (/merge append/i.test(sourceText)) return "糯小喵 · 追加合并";
    if (/merged event submitted/i.test(sourceText)) return "糯小喵 · 提交合并事件";
  }

  // Heartflow
  if (/astrbot_plugin_heartflow/i.test(moduleName) || /心流触发|心流判断|冷却中，距上次回复/i.test(sourceText)) {
    if (/冷却中/.test(sourceText)) {
      const sec = (sourceText.match(/还有\s*([\d.]+)\s*s/i) || [])[1] || "";
      return compactText(sec ? `心流 · 冷却 ${sec}s` : "心流 · 冷却中", 520);
    }
    if (/心流触发主动回复/.test(sourceText)) {
      const score = (sourceText.match(/评分:([\d.]+)/) || [])[1] || "";
      return compactText(score ? `心流 · 触发主动回复 · ${score}` : "心流 · 触发主动回复", 520);
    }
    if (/机器人回复已写入缓冲区/.test(sourceText)) return "心流 · 写入缓冲区";
    if (/心流判断不通过/.test(sourceText)) return "心流 · 不通过";
  }

  // meme_manager
  if (/\[meme_manager\]/i.test(sourceText) || /meme_manager/i.test(moduleName)) {
    const stage = (sourceText.match(/\[meme_manager\]\s*([^\n:]+)/i) || [])[1] || "";
    if (stage) return compactText(`表情 · ${stage.trim()}`, 520);
  }

  // AstrNa 压缩 / 身份
  if (/AstrNa\s*已压缩/i.test(sourceText)) return "AstrNa · 压缩群聊上下文";
  if (/AstrNa\s*已优化身份元数据/i.test(sourceText)) return "AstrNa · 优化身份元数据";
  if (/AstrNa\s*已启用优化/i.test(sourceText)) return compactText(sourceText.replace(/^.*?AstrNa/, "AstrNa"), 520);

  // 出站管线
  if (/\[Splitter\]/i.test(sourceText)) {
    const segs = (sourceText.match(/分为\s*(\d+)\s*段/) || [])[1] || "";
    return compactText(segs ? `出站分段 · ${segs} 段` : "出站分段", 520);
  }
  if (/智能引用/.test(sourceText)) return compactText(`出站 · ${previewText(sourceText, 80)}`, 520);

  // 关系本
  if (/\[关系本\]/i.test(sourceText) || /astrbot_plugin_yeli_relationship/i.test(moduleName)) {
    const body = sourceText.replace(/^.*?\[关系本\]\s*/i, "").trim();
    return compactText(body ? `关系本 · ${previewText(body, 80)}` : "关系本", 520);
  }

  // SpectreCore 读空气 / 回复
  if (/收到大模型回复喵/i.test(sourceText)) return "SpectreCore · 收到模型回复";
  if (/检测到读空气标记/i.test(sourceText)) return "SpectreCore · 读空气拦截";

  // 群分析
  if (/\[群分析插件\]/i.test(sourceText)) {
    const body = sourceText.replace(/^.*?\[群分析插件\]\s*/i, "").trim();
    return compactText(body ? `群分析 · ${previewText(body, 80)}` : "群分析", 520);
  }

  // hook(Event) -> plugin - method
  const hookMatch = sourceText.match(/hook\(([^)]+)\)\s*->\s*([A-Za-z0-9_.-]+)(?:\s*-\s*([A-Za-z0-9_.:-]+))?/i);
  if (hookMatch) {
    const eventName = hookMatch[1].trim();
    const plugin = hookMatch[2].trim();
    const method = (hookMatch[3] || "").trim();
    return compactText(
      method ? `Hook ${eventName} · ${plugin} · ${method}` : `Hook ${eventName} · ${plugin}`,
      520,
    );
  }

  // plugin -> X - Y
  const pluginMatch = sourceText.match(/\bplugin\s*->\s*([A-Za-z0-9_.-]+)(?:\s*-\s*([A-Za-z0-9_.:-]+))?/i);
  if (pluginMatch) {
    const plugin = pluginMatch[1].trim();
    const method = (pluginMatch[2] || "").trim();
    return compactText(method ? `插件调度 ${plugin} · ${method}` : `插件调度 ${plugin}`, 520);
  }

  // 去掉无意义超长 repr 前缀的默认 compact
  let text = sourceText;
  if (text.length > 80 && /^(?:completion|response|result|payload)\s*:/i.test(text) && text.includes("(")) {
    text = text.replace(/^[A-Za-z_][\w.]*:\s*/, "");
  }
  return compactText(text, 520);
}

export function bracketParts(text) {
  return [...String(text || "").matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].trim());
}