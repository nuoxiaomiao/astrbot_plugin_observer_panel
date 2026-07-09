// ============================================================================
// 视图 - 系统
// ============================================================================

import { state } from "../state.js?v=20260709-mobile1";
import { INTERFACE_STATE_LABELS } from "../config.js?v=20260709-mobile1";
import { formatBytes, formatPercent, formatNumber, shortUptime, usageKind } from "../utils/format.js?v=20260709-mobile1";
import { $, setText, renderKv, detailRow, emptyBlock, renderWorkspaceChrome } from "../utils/dom.js?v=20260709-mobile1";

/**
 * 创建堆栈项目元素（磁盘、网络等）
 * @returns {HTMLElement}
 */
export function createStackItem(title, meta, percent, details = []) {
  const item = document.createElement("div");
  item.className = `stack-item ${percent != null ? usageKind(percent) : ""}`;
  item.dataset.stackKey = title || "--";
  const head = document.createElement("div");
  head.className = "stack-head";
  const left = document.createElement("div");
  const titleEl = document.createElement("strong");
  const metaEl = document.createElement("small");
  left.append(titleEl, metaEl);
  const percentEl = document.createElement("span");
  head.append(left, percentEl);
  item.appendChild(head);
  const trackWrap = document.createElement("div");
  trackWrap.className = "usage-track";
  const fill = document.createElement("div");
  fill.className = "usage-fill";
  trackWrap.appendChild(fill);
  item.appendChild(trackWrap);
  const grid = document.createElement("div");
  grid.className = "detail-grid";
  item.appendChild(grid);
  fill.style.width = `${Math.max(0, Math.min(100, Number(percent || 0)))}%`;
  // 填充内容
  titleEl.textContent = title || "--";
  metaEl.textContent = meta || "--";
  percentEl.textContent = percent == null ? "--" : formatPercent(percent);
  details.forEach(([label, value]) => grid.appendChild(detailRow(label, value)));
  return item;
}

/**
 * 从磁盘数据更新已有堆栈项
 */
function updateStackItemFromDisk(item, disk) {
  const head = item.querySelector(".stack-head");
  head.querySelector("strong").textContent = disk.path || disk.resolved_path || "--";
  head.querySelector("small").textContent = `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`;
  const pctEl = head.querySelector("span");
  pctEl.textContent = formatPercent(disk.percent);
  item.className = `stack-item ${usageKind(disk.percent)}`;
  const fill = item.querySelector(".usage-fill");
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, Number(disk.percent || 0)))}%`;
  const grid = item.querySelector(".detail-grid");
  grid.innerHTML = "";
  [
    ["可用", formatBytes(disk.free)],
    ["已用", formatBytes(disk.used)],
    ["总量", formatBytes(disk.total)],
    ["路径", disk.resolved_path || disk.path],
  ].forEach(([label, value]) => grid.appendChild(detailRow(label, value)));
}

/**
 * 从网络接口数据更新已有堆栈项
 */
function updateStackItemFromNet(item, netData, details) {
  const head = item.querySelector(".stack-head");
  head.querySelector("strong").textContent = netData.name;
  head.querySelector("small").textContent = `${INTERFACE_STATE_LABELS[netData.state] || netData.state || "未知"} | ${netData.addresses?.join(", ") || "无地址"}`;
  const grid = item.querySelector(".detail-grid");
  grid.innerHTML = "";
  details.forEach(([label, value]) => grid.appendChild(detailRow(label, value)));
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

  // ★ 磁盘列表增量更新
  const diskList = $("diskList");
  const diskKeys = disks.map(d => d.path || d.resolved_path || "");
  const diskExisting = new Map();
  diskList.querySelectorAll('[data-stack-key]').forEach(el => {
    const k = el.dataset.stackKey;
    if (k) diskExisting.set(k, el);
  });
  const diskFragment = document.createDocumentFragment();
  if (!disks.length) {
    diskList.replaceChildren(emptyBlock("没有可展示的磁盘信息。"));
  } else {
    disks.forEach((disk) => {
      const key = disk.path || disk.resolved_path || "";
      let item = diskExisting.get(key);
      if (item) {
        diskExisting.delete(key);
        updateStackItemFromDisk(item, disk);
      } else {
        item = createStackItem(
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
        diskFragment.appendChild(item);
      }
    });
    diskExisting.forEach(el => el.remove());
    diskList.appendChild(diskFragment);
  }

  // ★ 网络接口列表增量更新
  const networkList = $("networkList");
  const visible = interfaces.filter((item) => item.name !== "lo" || item.addresses?.length);
  const netExisting = new Map();
  networkList.querySelectorAll('[data-stack-key]').forEach(el => {
    const k = el.dataset.stackKey;
    if (k) netExisting.set(k, el);
  });
  const netFragment = document.createDocumentFragment();
  if (!visible.length) {
    networkList.replaceChildren(emptyBlock("没有可展示的网络接口。"));
  } else {
    visible.forEach((item) => {
      const key = item.name;
      let el = netExisting.get(key);
      const netDetails = [
        ["接收", formatBytes(item.rx_bytes)],
        ["发送", formatBytes(item.tx_bytes)],
      ];
      if (item.rx_packets != null) netDetails.push(["RX包", formatNumber(item.rx_packets)]);
      if (item.tx_packets != null) netDetails.push(["TX包", formatNumber(item.tx_packets)]);
      if (item.mtu != null) netDetails.push(["MTU", item.mtu || "--"]);
      if (item.mac) netDetails.push(["MAC", item.mac]);
      if (el) {
        netExisting.delete(key);
        updateStackItemFromNet(el, item, netDetails);
      } else {
        el = createStackItem(
          item.name,
          `${INTERFACE_STATE_LABELS[item.state] || item.state || "未知"} | ${item.addresses?.join(", ") || "无地址"}`,
          null,
          netDetails,
        );
        netFragment.appendChild(el);
      }
    });
    netExisting.forEach(el => el.remove());
    networkList.appendChild(netFragment);
  }
  renderWorkspaceChrome();
}
