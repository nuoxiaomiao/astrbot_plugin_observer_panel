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
  return match ? Number(match[1]) * 1000 : null;
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