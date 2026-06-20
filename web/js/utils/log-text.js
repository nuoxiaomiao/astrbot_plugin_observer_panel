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

export function summarizePlainLog(message, raw) {
  const sourceText = String(message || raw || "");
  if (sourceText.includes("RawMessage <Event")) {
    const sender = extractQuotedField(sourceText, "nickname") || extractQuotedField(sourceText, "card");
    const rawMessage = extractQuotedField(sourceText, "raw_message");
    const group = extractQuotedField(sourceText, "group_name");
    const parts = ["平台消息"];
    if (sender || rawMessage) parts.push(`${sender || "未知发送者"}: ${rawMessage || "事件数据"}`);
    if (group) parts.push(group);
    return compactText(parts.join(" | "), 520);
  }
  return compactText(sourceText, 520);
}

export function bracketParts(text) {
  return [...String(text || "").matchAll(/\[([^\]]+)\]/g)].map((match) => match[1].trim());
}
