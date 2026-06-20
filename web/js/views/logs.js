// ============================================================================
// 视图 - 日志分析
// ============================================================================

import { state } from "../state.js?v=20260620-renderfix1";
import { DEFAULT_IMPORTANT_EVENT_LIMIT, IMPORTANT_EVENT_TYPES } from "../config.js?v=20260620-renderfix1";
import { setText, renderWorkspaceChrome } from "../utils/dom.js?v=20260620-renderfix1";
import { collectLogFiles } from "../log/cache.js?v=20260620-renderfix1";
import { getLogAnalysis, filterLogEntries } from "../log/analytics.js?v=20260620-renderfix1";
import {
  renderEventList,
  filterEvents,
  renderDetailPanel,
} from "../components/event-list.js?v=20260620-renderfix1";
import { renderLogStream } from "../components/log-list.js?v=20260620-renderfix1";
import { renderOverviewTrace } from "./overview.js?v=20260620-renderfix1";
import { renderAstrBotVisuals } from "./astrbot.js?v=20260620-renderfix1";

export function renderLogs() {
  const files = collectLogFiles();
  const analysis = getLogAnalysis(files);
  const entries = analysis.entries;
  const insights = analysis.insights;
  state.traceInsights = insights;

  if (state.activeTab === "overview") {
    renderOverviewTrace(insights);
    renderWorkspaceChrome();
    return;
  }

  if (state.activeTab === "astrbot") {
    renderAstrBotVisuals(insights, entries);
    renderWorkspaceChrome();
    return;
  }

  if (state.activeTab === "logs") {
    const filtered = filterLogEntries(entries);
    const importantEvents = insights.events.filter((event) => IMPORTANT_EVENT_TYPES.has(event.type));
    const events = filterEvents(importantEvents);
    if (state.selectedEventId && !events.some((event) => event.id === state.selectedEventId)) {
      state.selectedEventId = "";
    }
    // 仅在首次进入日志页且用户未主动选择时默认选中第一个，后续允许保持未选中
    if (!state.selectedEventId && events.length && !state.logsTabVisited) {
      state.selectedEventId = events[0].id;
      state.logsTabVisited = true;
    }
    const importantLimit = state.ui.importantEventLimit || DEFAULT_IMPORTANT_EVENT_LIMIT;
    setText("importantEventStamp", `${Math.min(events.length, importantLimit)} / ${events.length} 条`);
    renderEventList("importantEventList", events, importantLimit);
    renderLogStream(filtered);
    renderWorkspaceChrome();
    renderDetailPanel();
  }
}
