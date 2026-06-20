// ============================================================================
// 视图 - 系统
// ============================================================================

import { state } from "../state.js?v=20260620-sessionlive1";
import { INTERFACE_STATE_LABELS } from "../config.js?v=20260620-sessionlive1";
import { formatBytes, formatPercent, formatNumber, shortUptime, usageKind } from "../utils/format.js?v=20260620-sessionlive1";
import { $, setText, renderKv, detailRow, emptyBlock, renderWorkspaceChrome } from "../utils/dom.js?v=20260620-sessionlive1";

/**
 * 渲染堆栈项目（用于磁盘、网络等）
 * @param {HTMLElement} parent - 父元素
 * @param {string} title - 标题
 * @param {string} meta - 元信息
 * @param {number|null} percent - 百分比
 * @param {Array} details - 详细信息数组
 */
export function renderStackItem(parent, title, meta, percent, details = []) {
  const item = document.createElement("div");
  item.className = `stack-item ${percent != null ? usageKind(percent) : ""}`;
  const head = document.createElement("div");
  head.className = "stack-head";
  const left = document.createElement("div");
  const titleEl = document.createElement("strong");
  titleEl.textContent = title || "--";
  const metaEl = document.createElement("small");
  metaEl.textContent = meta || "--";
  left.append(titleEl, metaEl);
  const percentEl = document.createElement("span");
  percentEl.textContent = percent == null ? "--" : formatPercent(percent);
  head.append(left, percentEl);

  item.appendChild(head);
  if (percent != null) {
    const track = document.createElement("div");
    track.className = "usage-track";
    const fill = document.createElement("div");
    fill.className = "usage-fill";
    fill.style.width = `${Math.max(0, Math.min(100, Number(percent || 0)))}%`;
    track.appendChild(fill);
    item.appendChild(track);
  }

  if (details.length) {
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    details.forEach(([label, value]) => grid.appendChild(detailRow(label, value)));
    item.appendChild(grid);
  }
  parent.appendChild(item);
}

export function renderSystem() {
  const data = state.system;
  if (!data) return;
  const host = data.host || {};
  const cpu = data.cpu || {};
  const memory = data.memory || {};
  const process = data.process || {};
  const python = data.python || {};
  const disks = data.disks || [];
  const interfaces = data.network?.interfaces || [];

  setText("systemStamp", host.hostname || "--");
  setText("processStamp", `PID ${process.pid || "--"}`);
  setText("diskStamp", `${disks.length} 个挂载点`);
  setText("networkStamp", `${interfaces.length} 个接口`);

  renderKv("systemInfo", {
    主机名: host.hostname,
    系统: host.platform,
    架构: host.machine,
    运行时间: shortUptime(host.uptime_seconds),
    CPU: cpu.model || "--",
    逻辑核心: cpu.logical_count || 0,
    CPU使用率: cpu.percent == null ? "--" : formatPercent(cpu.percent),
    平均负载: cpu.load_average?.join(" / ") || "--",
    内存: `${formatBytes(memory.used)} / ${formatBytes(memory.total)} (${formatPercent(memory.percent)})`,
    Swap: `${formatBytes(memory.swap_used)} / ${formatBytes(memory.swap_total)} (${formatPercent(memory.swap_percent)})`,
  });

  renderKv("processInfo", {
    PID: process.pid,
    PPID: process.ppid,
    线程数: process.threads,
    ...(process.open_fds != null ? { 打开文件: process.open_fds } : {}),
    常驻内存: formatBytes(process.rss),
    虚拟内存: formatBytes(process.vms),
    峰值内存: formatBytes(process.max_rss),
    ...(process.cwd ? { 工作目录: process.cwd } : {}),
    Python: `${python.implementation || "Python"} ${python.version || ""}`.trim(),
    ...(process.cmdline ? { 命令: process.cmdline } : {}),
  });

  const diskList = $("diskList");
  diskList.innerHTML = "";
  if (!disks.length) {
    diskList.appendChild(emptyBlock("没有可展示的磁盘信息。"));
  } else {
    disks.forEach((disk) => {
      renderStackItem(
        diskList,
        disk.path || disk.resolved_path,
        `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`,
        disk.percent,
        [
          ["可用", formatBytes(disk.free)],
          ["已用", formatBytes(disk.used)],
          ["总量", formatBytes(disk.total)],
          ["路径", disk.resolved_path || disk.path],
        ],
      );
    });
  }

  const networkList = $("networkList");
  networkList.innerHTML = "";
  const visible = interfaces.filter((item) => item.name !== "lo" || item.addresses?.length);
  if (!visible.length) {
    networkList.appendChild(emptyBlock("没有可展示的网络接口。"));
  } else {
    visible.forEach((item) => {
      // 精简模式：仅保留接口名、状态、IP、总流量（rx_bytes/tx_bytes）
      const netDetails = [
        ["接收", formatBytes(item.rx_bytes)],
        ["发送", formatBytes(item.tx_bytes)],
      ];
      // compact 模式下后端不返回 packets/mtu/mac；非 compact 模式才展示这些细节
      if (item.rx_packets != null) netDetails.push(["RX包", formatNumber(item.rx_packets)]);
      if (item.tx_packets != null) netDetails.push(["TX包", formatNumber(item.tx_packets)]);
      if (item.mtu != null) netDetails.push(["MTU", item.mtu || "--"]);
      if (item.mac) netDetails.push(["MAC", item.mac]);
      renderStackItem(
        networkList,
        item.name,
        `${INTERFACE_STATE_LABELS[item.state] || item.state || "未知"} | ${item.addresses?.join(", ") || "无地址"}`,
        null,
        netDetails,
      );
    });
  }
  renderWorkspaceChrome();
}
