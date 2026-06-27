// ============================================================================
// 应用状态管理
// ============================================================================

export const state = {
  summary: null,
  system: null,
  logs: null,
  config: null,
  traceInsights: null,
  logCache: {
    signature: "",
    entries: [],
    insights: null,
    fileEntries: new Map(),
  },
  refreshing: false,
  pendingRefresh: false,
  refreshError: null,  // 记录刷新错误信息
  openDetails: new Set(),
  highlightLogEntryId: "",
  selectedEventId: "",
  selectedSessionId: "",
  activeTab: "overview",
  astrbotSubTab: "sessions",
  logLevel: "all",
  eventType: "all",
  logPage: 1,
  logPageSize: 80,
  logTimeFilter: "all",
  logRegex: false,
  logTimeFrom: null,
  logTimeTo: null,
  ui: {
    runningTimeoutMs: 10 * 60 * 1000,
    slowSessionMs: 30 * 1000,
    slowToolMs: 15 * 1000,
    importantEventLimit: 80,
    rawClipLength: 5000,
  },
  privacyMode: false,
  editMode: false,
  timer: null,
  logFilterTimer: null,
  refreshMs: 5000,
  lastRefreshTime: 0,
  messageStats: { total: 0, lastCount: 0, lastTime: 0 },
  logsTabVisited: false,
};
