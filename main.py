from __future__ import annotations

import asyncio
import copy
import ipaddress
import json
import os
import platform
import re
import resource
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

from aiohttp import web

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, StarTools, register

# 尝试导入 LogBroker 用于日志流功能
try:
    from astrbot.core import LogBroker
    LOGBROKER_AVAILABLE = True
except ImportError:
    LOGBROKER_AVAILABLE = False
    LogBroker = None


PLUGIN_NAME = "astrbot_plugin_observer_panel"
PLUGIN_VERSION = "0.3.0"

DEFAULT_ASTRBOT_LOG_FILES = ["astrbot.log", "astrbot.trace.log"]
DEFAULT_THRESHOLDS = {
    "cpu_warn_percent": 75.0,
    "cpu_bad_percent": 90.0,
    "memory_warn_percent": 75.0,
    "memory_bad_percent": 90.0,
    "disk_warn_percent": 80.0,
    "disk_bad_percent": 92.0,
    "error_warn_count": 1,
    "error_bad_count": 5,
    "stale_log_minutes": 10,
}
DEFAULT_UI = {
    "slow_session_seconds": 30,
    "slow_tool_seconds": 15,
    "running_timeout_minutes": 10,
    "important_event_limit": 80,
    "log_page_size": 80,
    "privacy_mode": False,
}

ALLOWED_LOG_SOURCES = {"all", "astrbot", "live", "stream"}

SECRET_KEY_RE = re.compile(
    r"(?i)(api[_-]?key|access[_-]?token|authorization|bearer|secret|password|passwd|token|key)"
)
SECRET_VALUE_RE = re.compile(
    r"(?i)\b("
    r"sk-[A-Za-z0-9_-]{12,}|"  # OpenAI API keys
    r"nvapi-[A-Za-z0-9_-]{12,}|"  # NVIDIA API keys
    r"hf_[A-Za-z0-9]{32,}|"  # Hugging Face tokens
    r"xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}|"  # Slack bot tokens
    r"xoxp-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}|"  # Slack user tokens
    r"discord_[A-Za-z0-9]{59,}|"  # Discord bot tokens
    r"[0-9]{18,19}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|"  # Discord tokens (alternative format)
    r"cfut_[A-Za-z0-9_-]{12,}|"
    r"fe_[A-Za-z0-9_-]{12,}|"
    r"ghp_[A-Za-z0-9]{36,}|"  # GitHub personal access tokens
    r"gho_[A-Za-z0-9]{36,}|"  # GitHub OAuth tokens
    r"ghs_[A-Za-z0-9]{36,}|"  # GitHub server tokens
    r"ghr_[A-Za-z0-9]{36,}|"  # GitHub refresh tokens
    r"github_pat_[A-Za-z0-9_]{82,}|"  # GitHub fine-grained tokens
    r"AKIA[A-Z0-9]{16}|"  # AWS access keys
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|"  # JWT tokens
    r"Bearer\s+[A-Za-z0-9._~-]{12,}"  # Bearer tokens
    # 注意：不再默认脱敏邮箱，避免隐藏正常联系信息
    r")"
)
LOG_LEVEL_RE = re.compile(r"(?i)\b(CRITICAL|FATAL|ERROR|ERR|ERRO|WARNING|WARN|WRN|INFO|DEBUG|DBUG|TRACE|TRAC)\b")
LOG_TIMESTAMP_RE = re.compile(r"(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)")
LOG_LEVEL_ALIASES = {
    "CRITICAL": "error",
    "FATAL": "error",
    "ERROR": "error",
    "ERR": "error",
    "ERRO": "error",
    "WARNING": "warn",
    "WARN": "warn",
    "WRN": "warn",
    "INFO": "info",
    "DEBUG": "debug",
    "DBUG": "debug",
    "TRACE": "trace",
    "TRAC": "trace",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _is_linux() -> bool:
    return platform.system() == "Linux"


def _json_response(data: Any, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda obj: json.dumps(obj, ensure_ascii=False))


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on", "开", "是"}
    if value is None:
        return default
    return bool(value)


def _as_int(value: Any, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    if min_value is not None:
        number = max(min_value, number)
    if max_value is not None:
        number = min(max_value, number)
    return number


def _as_float(value: Any, default: float, min_value: float | None = None, max_value: float | None = None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    if min_value is not None:
        number = max(min_value, number)
    if max_value is not None:
        number = min(max_value, number)
    return number


def _as_list(value: Any, default: list[Any] | None = None) -> list[Any]:
    if value is None:
        return list(default or [])
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return list(default or [])


def _safe_attr(obj: Any, name: str, default: Any = None) -> Any:
    """
    安全获取对象属性，失败时返回默认值。
    getattr(..., default) 在属性不存在时直接返回 default，不会抛出 AttributeError；
    此处保留 AttributeError 分支是为了捕获属性 getter 内部抛出的 AttributeError。
    """
    try:
        return getattr(obj, name, default)
    except AttributeError:
        return default
    except Exception as e:
        logger.warning(f"[ObserverPanel] 访问属性 {name} 时发生意外错误: {e}")
        return default


def _safe_call(obj: Any, method: str, *args: Any, default: Any = None, **kwargs: Any) -> Any:
    """
    安全调用对象方法，失败时返回默认值。
    记录非预期的异常以便调试。
    """
    fn = _safe_attr(obj, method)
    if not callable(fn):
        return default
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        logger.warning(f"[ObserverPanel] 调用方法 {method} 时发生错误: {e}")
        return default


def _to_jsonable(value: Any, *, max_depth: int = 4, max_items: int = 80) -> Any:
    if max_depth <= 0:
        return repr(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for idx, (key, val) in enumerate(value.items()):
            if idx >= max_items:
                out["..."] = f"{len(value) - max_items} more"
                break
            out[str(key)] = _to_jsonable(val, max_depth=max_depth - 1, max_items=max_items)
        return out
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        out = [_to_jsonable(item, max_depth=max_depth - 1, max_items=max_items) for item in items[:max_items]]
        if len(items) > max_items:
            out.append(f"... {len(items) - max_items} more")
        return out
    if hasattr(value, "__dict__"):
        data = {
            key: val
            for key, val in vars(value).items()
            if not key.startswith("_") and not callable(val)
        }
        if data:
            return _to_jsonable(data, max_depth=max_depth - 1, max_items=max_items)
    return repr(value)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if SECRET_KEY_RE.search(key_text):
                redacted[key_text] = "***"
            else:
                redacted[key_text] = _redact(item)
        return redacted
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, tuple):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return SECRET_VALUE_RE.sub("***", value)
    return value


def _config_type_label(value: Any) -> str:
    if isinstance(value, dict):
        return "对象"
    if isinstance(value, list):
        return "列表"
    if isinstance(value, bool):
        return "开关"
    if isinstance(value, (int, float)):
        return "数字"
    if isinstance(value, str):
        return "文本"
    if value is None:
        return "空"
    return type(value).__name__


def _config_item_count(value: Any) -> int:
    if isinstance(value, (dict, list, tuple, set)):
        return len(value)
    if isinstance(value, str):
        return 1 if value else 0
    return 1 if value is not None else 0


def _boolish(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "y", "on", "开", "是", "enable", "enabled"}:
            return True
        if text in {"0", "false", "no", "n", "off", "关", "否", "disable", "disabled"}:
            return False
    if isinstance(value, (int, float)) and value in {0, 1}:
        return bool(value)
    return None


def _enabled_summary(value: Any) -> dict[str, Any]:
    keys = ("enable", "enabled", "is_enabled", "active", "activated")
    if isinstance(value, dict):
        for key in keys:
            if key in value:
                state = _boolish(value.get(key))
                if state is not None:
                    return {"mode": "single", "enabled": state}
        children = value.values()
    elif isinstance(value, list):
        children = value
    else:
        return {}

    total = 0
    enabled = 0
    for item in children:
        if not isinstance(item, dict):
            continue
        for key in keys:
            if key not in item:
                continue
            state = _boolish(item.get(key))
            if state is None:
                continue
            total += 1
            if state:
                enabled += 1
            break
    if total:
        return {"mode": "collection", "enabled": enabled, "total": total}
    return {}


def _safe_child_keys(value: Any, *, limit: int = 8) -> list[str]:
    if not isinstance(value, dict):
        return []
    keys = []
    for key in value.keys():
        key_text = str(key)
        if SECRET_KEY_RE.search(key_text):
            continue
        keys.append(key_text)
        if len(keys) >= limit:
            break
    return keys


def _file_stat(path: Path) -> dict[str, Any]:
    try:
        stat = path.stat()
    except OSError as exc:
        return {
            "path": str(path),
            "exists": False,
            "readable": False,
            "error": str(exc),
        }
    return {
        "path": str(path),
        "exists": True,
        "readable": os.access(path, os.R_OK),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }


def _file_line_state_sync(path: Path) -> tuple[int, bool]:
    total = 0
    size = 0
    last = b""
    try:
        with path.open("rb") as file:
            while True:
                chunk = file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                total += chunk.count(b"\n")
                last = chunk[-1:]
    except OSError:
        return 0, True
    if size <= 0:
        return 0, True
    ends_with_newline = last == b"\n"
    if not ends_with_newline:
        total += 1
    return total, ends_with_newline


def _tail_file_sync(path: Path, *, max_bytes: int, max_lines: int, redact: bool) -> dict[str, Any]:
    stat = _file_stat(path)
    if not stat.get("exists") or not stat.get("readable"):
        return {**stat, "lines": [], "truncated": False, "line_count": 0, "base_line": 0, "ends_with_newline": True}

    size = int(stat.get("size") or 0)
    truncated = size > max_bytes
    try:
        with path.open("rb") as file:
            if truncated:
                file.seek(-max_bytes, os.SEEK_END)
            raw = file.read(max_bytes)
    except OSError as exc:
        return {**stat, "lines": [], "truncated": False, "error": str(exc), "line_count": 0, "base_line": 0, "ends_with_newline": True}

    if truncated and raw:
        if b"\n" in raw:
            raw = raw.split(b"\n", 1)[1]
        else:
            raw = b""

    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()[-max_lines:]
    if redact:
        lines = [str(_redact(line)) for line in lines]
    total_lines, ends_with_newline = _file_line_state_sync(path)
    return {
        **stat,
        "lines": lines,
        "truncated": truncated,
        "line_count": total_lines,
        "base_line": max(0, total_lines - len(lines)),
        "ends_with_newline": ends_with_newline,
    }


def _parse_logs_cursor(value: str | None) -> dict[str, dict[str, Any]]:
    if not value:
        return {}
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict):
        items = payload.values() if "files" in payload and isinstance(payload.get("files"), dict) else payload
        if isinstance(items, dict):
            out: dict[str, dict[str, Any]] = {}
            for key, item in items.items():
                if isinstance(item, dict):
                    path = str(item.get("path") or key)
                    out[path] = item
            return out
    if isinstance(payload, list):
        out = {}
        for item in payload:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "")
            if path:
                out[path] = item
        return out
    return {}


def _log_cursor_payload(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": data.get("path"),
        "size": data.get("size") or 0,
        "mtime": data.get("mtime") or 0,
        "line_count": data.get("line_count") or 0,
        "base_line": data.get("base_line") or 0,
        "ends_with_newline": bool(data.get("ends_with_newline", True)),
    }


def _tail_file_incremental_sync(
    path: Path,
    *,
    max_bytes: int,
    max_lines: int,
    redact: bool,
    cursor: dict[str, Any] | None,
) -> dict[str, Any]:
    if not cursor:
        data = _tail_file_sync(path, max_bytes=max_bytes, max_lines=max_lines, redact=redact)
        data["reset"] = True
        data["cursor"] = _log_cursor_payload(data)
        return data

    stat = _file_stat(path)
    if not stat.get("exists") or not stat.get("readable"):
        data = {**stat, "lines": [], "truncated": False, "line_count": 0, "base_line": 0, "ends_with_newline": True, "reset": True}
        data["cursor"] = _log_cursor_payload(data)
        return data

    size = int(stat.get("size") or 0)
    old_size = _as_int(cursor.get("size"), -1, -1)
    old_mtime = float(cursor.get("mtime") or 0)
    old_line_count = _as_int(cursor.get("line_count"), 0, 0)
    old_base_line = _as_int(cursor.get("base_line"), 0, 0)
    old_ends_with_newline = bool(cursor.get("ends_with_newline", True))
    mtime = float(stat.get("mtime") or 0)

    if size == old_size and mtime == old_mtime:
        data = {
            **stat,
            "lines": [],
            "truncated": size > max_bytes,
            "line_count": old_line_count,
            "base_line": old_base_line,
            "ends_with_newline": old_ends_with_newline,
            "reset": False,
            "unchanged": True,
        }
        data["cursor"] = _log_cursor_payload(data)
        return data

    delta_size = size - old_size
    if old_size < 0 or delta_size < 0 or delta_size > max_bytes or size == old_size or not old_ends_with_newline:
        data = _tail_file_sync(path, max_bytes=max_bytes, max_lines=max_lines, redact=redact)
        data["reset"] = True
        data["cursor"] = _log_cursor_payload(data)
        return data

    try:
        with path.open("rb") as file:
            file.seek(old_size)
            raw = file.read(delta_size)
    except OSError as exc:
        data = {**stat, "lines": [], "truncated": False, "error": str(exc), "line_count": old_line_count, "base_line": old_base_line, "ends_with_newline": old_ends_with_newline, "reset": False}
        data["cursor"] = _log_cursor_payload(data)
        return data

    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if len(lines) > max_lines:
        data = _tail_file_sync(path, max_bytes=max_bytes, max_lines=max_lines, redact=redact)
        data["reset"] = True
        data["cursor"] = _log_cursor_payload(data)
        return data
    if redact:
        lines = [str(_redact(line)) for line in lines]
    ends_with_newline = raw.endswith(b"\n") if raw else old_ends_with_newline

    data = {
        **stat,
        "lines": lines,
        "truncated": size > max_bytes,
        "line_count": old_line_count + len(lines),
        "base_line": old_base_line,
        "ends_with_newline": ends_with_newline,
        "reset": False,
    }
    data["cursor"] = _log_cursor_payload(data)
    return data


def _parse_log_level(line: str) -> str:
    match = LOG_LEVEL_RE.search(line)
    if not match:
        return "other"
    return LOG_LEVEL_ALIASES.get(match.group(1).upper(), "other")


def _parse_log_timestamp_ms(line: str) -> int | None:
    match = LOG_TIMESTAMP_RE.search(line)
    if not match:
        return None
    text = match.group(1).replace(" ", "T")
    try:
        value = datetime.fromisoformat(text)
    except ValueError:
        return None
    return int(value.timestamp() * 1000)


def _compact_log_line(line: str, *, limit: int = 260) -> str:
    text = re.sub(r"\s+", " ", str(line or "")).strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit - 1]}…"


def _analyze_log_files(files: list[dict[str, Any]], *, stale_seconds: int) -> dict[str, Any]:
    counts = {"error": 0, "warn": 0, "info": 0, "debug": 0, "trace": 0, "other": 0}
    highlights: list[dict[str, Any]] = []
    latest_timestamp = 0
    latest_file_mtime = 0.0
    readable_count = 0
    missing_count = 0
    unreadable_count = 0
    truncated_count = 0
    stale_files: list[dict[str, Any]] = []
    now = time.time()

    for file in files:
        path = str(file.get("path") or "")
        exists = bool(file.get("exists"))
        readable = bool(file.get("readable"))
        mtime = float(file.get("mtime") or 0)
        latest_file_mtime = max(latest_file_mtime, mtime)
        if not exists:
            missing_count += 1
        elif not readable:
            unreadable_count += 1
        else:
            readable_count += 1
            if stale_seconds > 0 and mtime and now - mtime > stale_seconds:
                stale_files.append(
                    {
                        "path": path,
                        "mtime": mtime,
                        "age_seconds": round(now - mtime, 3),
                    }
                )
        if file.get("truncated"):
            truncated_count += 1

        for line in file.get("lines") or []:
            text = str(line or "")
            level = _parse_log_level(text)
            counts[level] = counts.get(level, 0) + 1
            timestamp = _parse_log_timestamp_ms(text) or 0
            latest_timestamp = max(latest_timestamp, timestamp)
            if level in {"error", "warn"}:
                highlights.append(
                    {
                        "level": level,
                        "path": path,
                        "timestamp": timestamp or None,
                        "message": _compact_log_line(text),
                    }
                )

    highlights.sort(key=lambda item: item.get("timestamp") or 0, reverse=True)
    return {
        "counts": counts,
        "total_lines": sum(counts.values()),
        "readable_files": readable_count,
        "missing_files": missing_count,
        "unreadable_files": unreadable_count,
        "truncated_files": truncated_count,
        "latest_timestamp": latest_timestamp or None,
        "latest_file_mtime": latest_file_mtime or None,
        "stale_files": stale_files,
        "highlights": highlights[:12],
    }


def _read_text_sync(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def _read_proc_key_values(path: Path) -> dict[str, str]:
    if not _is_linux():
        return {}
    data: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return data
    for line in lines:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip()
    return data


def _kib_value(value: str | None) -> int:
    if not value:
        return 0
    try:
        return int(str(value).split()[0]) * 1024
    except (TypeError, ValueError, IndexError):
        return 0


def _read_cpu_times() -> tuple[int, int] | None:
    if not _is_linux():
        return None
    try:
        first = Path("/proc/stat").read_text(encoding="utf-8", errors="replace").splitlines()[0]
    except (OSError, IndexError):
        return None
    parts = first.split()
    if not parts or parts[0] != "cpu":
        return None
    try:
        values = [int(item) for item in parts[1:]]
    except ValueError:
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return sum(values), idle


def _read_cpu_model() -> str:
    if not _is_linux():
        return ""
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
            if line.lower().startswith("hardware"):
                return line.split(":", 1)[1].strip()
    except OSError:
        return ""
    return ""


def _load_average() -> list[float]:
    try:
        return [round(item, 3) for item in os.getloadavg()]
    except OSError:
        return []


def _disk_usage(path: Path) -> dict[str, Any]:
    target = path
    if not target.exists():
        target = Path("/")
    try:
        usage = shutil.disk_usage(target)
    except OSError as exc:
        return {"path": str(path), "exists": path.exists(), "error": str(exc)}
    used = usage.total - usage.free
    percent = round((used / usage.total) * 100, 2) if usage.total else 0
    return {
        "path": str(path),
        "resolved_path": str(target),
        "exists": path.exists(),
        "total": usage.total,
        "used": used,
        "free": usage.free,
        "percent": percent,
    }


def _network_counters() -> dict[str, dict[str, int]]:
    counters: dict[str, dict[str, int]] = {}
    if not _is_linux():
        return counters
    try:
        lines = Path("/proc/net/dev").read_text(encoding="utf-8", errors="replace").splitlines()[2:]
    except OSError:
        return counters
    for line in lines:
        if ":" not in line:
            continue
        name, values = line.split(":", 1)
        parts = values.split()
        if len(parts) < 16:
            continue
        try:
            counters[name.strip()] = {
                "rx_bytes": int(parts[0]),
                "rx_packets": int(parts[1]),
                "tx_bytes": int(parts[8]),
                "tx_packets": int(parts[9]),
            }
        except ValueError:
            continue
    return counters


def _interface_addresses() -> dict[str, list[str]]:
    if not _is_linux():
        return {}
    try:
        result = subprocess.run(
            ["ip", "-j", "addr"],
            check=False,
            capture_output=True,
            text=True,
            timeout=0.8,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}

    addresses: dict[str, list[str]] = {}
    for item in payload if isinstance(payload, list) else []:
        name = str(item.get("ifname") or "")
        values: list[str] = []
        for addr in item.get("addr_info") or []:
            local = addr.get("local")
            family = addr.get("family")
            if local and family in {"inet", "inet6"}:
                values.append(str(local))
        if name:
            addresses[name] = values
    return addresses


@register(
    PLUGIN_NAME,
    "Codex",
    "独立端口 WebUI，用于查看系统资源、AstrBot 状态和日志。",
    PLUGIN_VERSION,
)
class ObserverPanelPlugin(Star):
    def __init__(self, context: Context, config: AstrBotConfig | dict | None = None):
        super().__init__(context)
        self.context = context
        self.config = config or {}
        self.data_dir = Path(StarTools.get_data_dir())
        self.web_dir = Path(__file__).resolve().parent / "web"

        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._last_cpu_times: tuple[int, int] | None = _read_cpu_times()
        self._log_tail_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
        self._log_stats_cache: dict[str, Any] = {}
        self._started_at = time.time()
        self._system_cache: dict[str, Any] = {}
        self._static_cache: dict[str, tuple[str, float, str]] = {}

        # LogBroker 日志流集成
        self._log_broker: Any | None = None
        self._log_queue: Any | None = None
        self._log_stream_cache: deque = deque(maxlen=500)
        self._log_subscribers: list[asyncio.Queue] = []
        self._log_stream_task: asyncio.Task | None = None
        self._use_log_stream = False

    async def initialize(self) -> None:
        if not self._cfg_bool("enabled", True):
            logger.info("[ObserverPanel] 已禁用，未启动 WebUI")
            return
        await self._try_init_log_broker()
        await self._start_server()

    async def terminate(self) -> None:
        await self._cleanup_log_broker()
        await self._stop_server()

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("观察面板", alias={"observer", "监控面板", "日志面板"})
    async def observer_panel(self, event: AstrMessageEvent):
        """查看 AstrBot 观察面板地址。"""
        if self._site is None:
            yield event.plain_result("观察面板未启动，请检查插件配置或 AstrBot 日志。")
            return
        yield event.plain_result(f"观察面板：{self.public_url}")

    @property
    def base_url(self) -> str:
        host = self._cfg_str("host", "127.0.0.1")
        visible_host = "127.0.0.1" if host == "0.0.0.0" else host
        port = self._cfg_int("port", 6199, 1, 65535)
        return f"http://{visible_host}:{port}/"

    @property
    def public_url(self) -> str:
        return self.base_url

    async def _start_server(self) -> None:
        if self._runner is not None:
            return

        host = self._cfg_str("host", "127.0.0.1")
        port = self._cfg_int("port", 6199, 1, 65535)

        try:
            # 创建 aiohttp 应用并启用内置压缩
            # enable_compression=True 会自动使用 gzip 压缩响应（减少 60-70% 传输大小）
            app = web.Application(
                middlewares=[self._csp_middleware, self._auth_middleware]
            )

            app.router.add_get("/", self._handle_index)
            app.router.add_get("/app.js", self._handle_static)
            app.router.add_get("/styles.css", self._handle_static)
            app.router.add_get("/api/health", self._handle_health)
            app.router.add_get("/api/summary", self._handle_summary)
            app.router.add_get("/api/system", self._handle_system)
            app.router.add_get("/api/astrbot", self._handle_astrbot)
            app.router.add_get("/api/logs", self._handle_logs)
            app.router.add_get("/api/config", self._handle_config)
            # LogBroker 日志流 API
            app.router.add_get("/api/logs/stream", self._handle_logs_stream)
            app.router.add_get("/api/logs/live", self._handle_logs_live)

            runner = web.AppRunner(app, access_log=None)
            await runner.setup()
            self._app = app
            self._runner = runner
            site = web.TCPSite(runner, host, port)
            self._site = site
            await site.start()
        except Exception as e:
            logger.error(f"[ObserverPanel] 启动服务器失败: {e}", exc_info=True)
            await self._stop_server()
            raise

        logger.info(f"[ObserverPanel] WebUI 已启动：{self.base_url}")

    async def _stop_server(self) -> None:
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        self._app = None
        logger.info("[ObserverPanel] WebUI 已停止")

    def _host_all_interfaces(self) -> bool:
        return self._cfg_str("host", "127.0.0.1").strip() in {"0.0.0.0", "::", ""}

    def _is_loopback_request(self, request: web.Request) -> bool:
        remote = request.remote
        if not remote:
            return False
        try:
            address = ipaddress.ip_address(remote)
        except ValueError:
            return False
        return address.is_loopback

    @web.middleware
    async def _csp_middleware(self, request: web.Request, handler: Any) -> web.StreamResponse:
        response = await handler(request)
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @web.middleware
    async def _auth_middleware(self, request: web.Request, handler: Any) -> web.StreamResponse:
        token = self._cfg_str("access_token", "").strip()

        # 无 token 配置时，仅对远程非 API 请求拒绝
        if not token:
            if self._host_all_interfaces() and not self._is_loopback_request(request) and request.path.startswith("/api/"):
                return _json_response({"ok": False, "error": "远程访问需要配置访问令牌"}, status=401)
            return await handler(request)

        # 静态资源（JS/CSS）不需要认证，因为它们会被 CSP 限制
        # 只有通过认证的 index.html 才能加载这些资源
        if request.path in ["/app.js", "/styles.css"]:
            return await handler(request)

        # 有 token 配置时，从请求中获取
        # 安全性：只接受来自查询参数或 Authorization 头的 token
        supplied = request.query.get("token", "")
        if not supplied:
            header = request.headers.get("Authorization", "")
            if header.lower().startswith("bearer "):
                supplied = header[7:].strip()

        if supplied != token:
            if request.path.startswith("/api/"):
                return _json_response({"ok": False, "error": "未授权访问"}, status=401)
            return web.Response(status=401, text="未授权访问")
        return await handler(request)

    async def _handle_index(self, request: web.Request) -> web.Response:
        response = await self._send_file(self.web_dir / "index.html", content_type="text/html")
        if response.status == 200:
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

    async def _handle_static(self, request: web.Request) -> web.Response:
        name = request.path.strip("/")
        if name == "app.js":
            content_type = "application/javascript"
        elif name == "styles.css":
            content_type = "text/css"
        else:
            return web.Response(status=404, text="Not found")
        path = self.web_dir / name
        cache_key = str(path)
        now = time.time()

        try:
            stat = path.stat()
        except OSError:
            return web.Response(status=404, text="Not found")

        mtime = stat.st_mtime
        mtime_str = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(mtime))
        etag = f'W/"{stat.st_size}-{int(mtime)}"'

        # 如果内存缓存的 mtime 与磁盘一致，直接返回缓存；否则重新读取。
        cached = self._static_cache.get(cache_key)
        if cached:
            data, cached_mtime, cached_etag = cached
            if cached_mtime == mtime and cached_etag == etag:
                if_none_match = request.headers.get("If-None-Match", "")
                if etag and if_none_match == etag:
                    return web.Response(status=304)
                response = web.Response(text=data, content_type=content_type)
                response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
                response.headers["ETag"] = etag
                response.headers["Last-Modified"] = mtime_str
                response.enable_compression()
                return response

        try:
            data = await asyncio.to_thread(path.read_text, encoding="utf-8")
        except OSError:
            return web.Response(status=404, text="Not found")

        self._static_cache[cache_key] = (data, mtime, etag)
        response = web.Response(text=data, content_type=content_type)
        response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
        response.headers["ETag"] = etag
        response.headers["Last-Modified"] = mtime_str
        response.enable_compression()
        return response

    async def _send_file(self, path: Path, *, content_type: str) -> web.Response:
        try:
            text = await asyncio.to_thread(path.read_text, encoding="utf-8")
        except OSError:
            return web.Response(status=404, text="Not found")
        response = web.Response(text=text, content_type=content_type)
        response.enable_compression()
        return response

    async def _handle_health(self, request: web.Request) -> web.Response:
        return _json_response(
            {
                "ok": True,
                "plugin": PLUGIN_NAME,
                "version": PLUGIN_VERSION,
                "uptime_seconds": round(time.time() - self._started_at, 3),
                "log_mode": "logbroker" if self._use_log_stream else "file",
                "log_stream_available": LOGBROKER_AVAILABLE,
                "log_stream_enabled": self._use_log_stream,
                "cached_logs": len(self._log_stream_cache) if self._use_log_stream else 0,
                "now": _now_ms(),
            }
        )

    async def _handle_config(self, request: web.Request) -> web.Response:
        cfg = self._public_config()
        return _json_response({"ok": True, "data": cfg, "now": _now_ms()})

    async def _handle_summary(self, request: web.Request) -> web.Response:
        astrbot = self._collect_astrbot()
        system = await asyncio.to_thread(self._collect_system, compact=True)
        logs = await self._collect_log_stats()
        diagnostics = self._build_diagnostics(astrbot, system, logs)
        data = {
            "plugin": {
                "name": PLUGIN_NAME,
                "version": PLUGIN_VERSION,
                "url": self.base_url,
                "uptime_seconds": round(time.time() - self._started_at, 3),
            },
            "astrbot": {
                "stars_total": astrbot["stars"]["total"],
                "stars_active": astrbot["stars"]["active"],
                "platforms_total": astrbot["platforms"]["total"],
                "providers_total": astrbot["providers"]["total"],
                "dashboard": astrbot["dashboard"],
            },
            "system": system,
            "logs": logs,
            "diagnostics": diagnostics,
            "now": _now_ms(),
        }
        return _json_response({"ok": True, "data": data})

    async def _handle_system(self, request: web.Request) -> web.Response:
        compact = request.query.get("compact", "0") in {"1", "true", "yes"}
        now = time.time()
        ttl = max(2.0, min(10.0, self._cfg_int("refresh_interval_seconds", 5, 2, 120) * 0.5))
        cache_key = f"system:{compact}"
        cached = self._system_cache.get(cache_key)
        if cached and now - float(cached.get("ts") or 0) < ttl:
            return _json_response({"ok": True, "data": cached["data"], "now": _now_ms()})
        data = await asyncio.to_thread(self._collect_system, compact=compact)
        self._system_cache[cache_key] = {"data": data, "ts": now}
        return _json_response({"ok": True, "data": data, "now": _now_ms()})

    async def _handle_astrbot(self, request: web.Request) -> web.Response:
        return _json_response({"ok": True, "data": self._collect_astrbot(), "now": _now_ms()})

    async def _handle_logs(self, request: web.Request) -> web.Response:
        source = request.query.get("source", "all")
        if source not in ALLOWED_LOG_SOURCES:
            return _json_response({"ok": False, "error": "无效的日志来源"}, status=400)

        # 前端初始化时需要先拿到文件日志作为历史上下文；force_file=1 强制走文件模式。
        force_file = _as_bool(request.query.get("force_file"), False)

        # 如果启用了 LogBroker ，优先使用日志流（前端默认 source=astrbot 也应走流式）
        if not force_file and self._use_log_stream and source in {"all", "astrbot", "live", "stream"}:
            limit = _as_int(request.query.get("limit"), 300, 1, 1000)
            logs = await self._get_stream_logs(limit)

            return _json_response({
                "ok": True,
                "data": {
                    "live": logs,
                    "use_log_stream": True,
                    "source": "logbroker"
                },
                "now": _now_ms()
            })

        # Fallback 到原有的文件读取逻辑
        cursor_str = request.query.get("cursor", "")
        if len(cursor_str) > 50000:
            return _json_response({"ok": False, "error": "游标参数过大"}, status=400)
        cursor = _parse_logs_cursor(cursor_str)
        data: dict[str, Any] = {}
        if source in {"all", "astrbot"}:
            data["astrbot"] = await self._collect_astrbot_logs(cursor=cursor)
            data["use_log_stream"] = False
            data["source"] = "file"
        return _json_response({"ok": True, "data": data, "now": _now_ms()})

    def _collect_astrbot(self) -> dict[str, Any]:
        cfg = _to_jsonable(_safe_call(self.context, "get_config", default={}))
        cfg = _redact(cfg)
        dashboard = {}
        if isinstance(cfg, dict):
            dashboard = _redact(cfg.get("dashboard") or {})

        stars = self._collect_stars()
        providers = self._collect_providers(cfg if isinstance(cfg, dict) else {})
        platforms = self._collect_platforms(cfg if isinstance(cfg, dict) else {})

        return {
            "config_overview": self._collect_config_overview(cfg if isinstance(cfg, dict) else {}),
            "dashboard": dashboard,
            "stars": stars,
            "providers": providers,
            "platforms": platforms,
            "data_dir_name": self.data_dir.name,
        }

    def _collect_config_overview(self, cfg: dict[str, Any]) -> dict[str, Any]:
        sections: list[dict[str, Any]] = []
        sensitive_sections = 0
        for key, value in sorted(cfg.items(), key=lambda item: str(item[0])):
            key_text = str(key)
            if SECRET_KEY_RE.search(key_text):
                sensitive_sections += 1
                continue
            section = {
                "name": key_text,
                "type": _config_type_label(value),
                "items": _config_item_count(value),
                "child_keys": _safe_child_keys(value),
            }
            enabled = _enabled_summary(value)
            if enabled:
                section["enabled"] = enabled
            sections.append(section)

        provider_items = cfg.get("provider") or cfg.get("providers") or []
        provider_sources = cfg.get("provider_sources") or []
        platform_items = (
            cfg.get("platform")
            or cfg.get("platforms")
            or cfg.get("platform_sources")
            or cfg.get("platform_config")
            or []
        )
        dashboard = cfg.get("dashboard") if isinstance(cfg.get("dashboard"), dict) else {}

        return {
            "section_count": len(cfg),
            "visible_section_count": len(sections),
            "sensitive_section_count": sensitive_sections,
            "hidden_section_count": max(0, len(sections) - 24),
            "sections": sections[:24],
            "dashboard": {
                "configured": bool(dashboard),
                "host": dashboard.get("host") or dashboard.get("dashboard_host"),
                "port": dashboard.get("port") or dashboard.get("dashboard_port"),
                "auth": bool(dashboard.get("password") or dashboard.get("token") or dashboard.get("username")),
            },
            "counts": {
                "providers": len(provider_items) if isinstance(provider_items, list) else _config_item_count(provider_items),
                "provider_sources": len(provider_sources) if isinstance(provider_sources, list) else _config_item_count(provider_sources),
                "platforms": len(platform_items) if isinstance(platform_items, list) else _config_item_count(platform_items),
            },
        }

    def _collect_stars(self) -> dict[str, Any]:
        stars_meta = _safe_call(self.context, "get_all_stars", default=[]) or []
        items: list[dict[str, Any]] = []
        for star in stars_meta:
            item = {
                "name": _safe_attr(star, "name", ""),
                "display_name": _safe_attr(star, "display_name", "") or _safe_attr(star, "name", ""),
                "desc": _safe_attr(star, "desc", ""),
                "author": _safe_attr(star, "author", ""),
                "version": _safe_attr(star, "version", ""),
                "repo": _safe_attr(star, "repo", ""),
                "activated": bool(_safe_attr(star, "activated", False)),
                "reserved": bool(_safe_attr(star, "reserved", False)),
                "module_path": _safe_attr(star, "module_path", ""),
                "root_dir_name": _safe_attr(star, "root_dir_name", ""),
                "handlers": _to_jsonable(_safe_attr(star, "star_handler_full_names", [])),
            }
            items.append(_redact(item))
        items.sort(key=lambda x: (not x.get("activated"), str(x.get("name"))))
        return {
            "total": len(items),
            "active": sum(1 for item in items if item.get("activated")),
            "items": items,
        }

    def _collect_providers(self, cfg: dict[str, Any]) -> dict[str, Any]:
        providers = []
        raw_providers = cfg.get("provider") or cfg.get("providers") or []
        if isinstance(raw_providers, list):
            for item in raw_providers:
                if isinstance(item, dict):
                    providers.append(
                        _redact(
                            {
                                "id": item.get("id"),
                                "type": item.get("type") or item.get("provider_type"),
                                "provider": item.get("provider"),
                                "model": item.get("model"),
                                "enable": item.get("enable"),
                                "modalities": item.get("modalities"),
                                "source": item.get("provider_source_id"),
                            }
                        )
                    )

        sources = []
        raw_sources = cfg.get("provider_sources") or []
        if isinstance(raw_sources, list):
            for item in raw_sources:
                if isinstance(item, dict):
                    sources.append(
                        _redact(
                            {
                                "id": item.get("id"),
                                "provider": item.get("provider"),
                                "type": item.get("type") or item.get("provider_type"),
                                "endpoint_configured": bool(item.get("api_base")),
                                "enable": item.get("enable"),
                                "timeout": item.get("timeout"),
                            }
                        )
                    )

        runtime = []
        all_runtime = _safe_call(self.context, "get_all_providers", default=[]) or []
        for provider in all_runtime:
            runtime.append(
                _redact(
                    {
                        "id": _safe_attr(provider, "id", "") or _safe_attr(provider, "provider_id", ""),
                        "name": _safe_attr(provider, "name", "") or provider.__class__.__name__,
                        "type": provider.__class__.__name__,
                    }
                )
            )

        return {
            "total": len(providers) or len(runtime),
            "items": providers,
            "sources": sources,
            "runtime": runtime,
        }

    def _collect_platforms(self, cfg: dict[str, Any]) -> dict[str, Any]:
        config_items: list[dict[str, Any]] = []
        raw_platforms = (
            cfg.get("platform")
            or cfg.get("platforms")
            or cfg.get("platform_sources")
            or cfg.get("platform_config")
            or []
        )
        if isinstance(raw_platforms, list):
            for item in raw_platforms:
                if isinstance(item, dict):
                    config_items.append(
                        _redact(
                            {
                                "id": item.get("id"),
                                "type": item.get("type") or item.get("platform"),
                                "enable": item.get("enable"),
                                "adapter": item.get("adapter"),
                            }
                        )
                    )
        elif isinstance(raw_platforms, dict):
            for key, item in raw_platforms.items():
                if isinstance(item, dict):
                    config_items.append(
                        _redact(
                            {
                                "id": item.get("id") or key,
                                "type": item.get("type") or item.get("platform"),
                                "enable": item.get("enable"),
                                "adapter": item.get("adapter"),
                            }
                        )
                    )

        runtime_items = self._collect_runtime_platforms()
        return {
            "total": len(runtime_items) or len(config_items),
            "runtime": runtime_items,
            "config": config_items,
        }

    def _collect_runtime_platforms(self) -> list[dict[str, Any]]:
        candidates: list[Any] = []
        for manager_name in ("platform_manager", "_platform_manager"):
            manager = _safe_attr(self.context, manager_name)
            if manager is None:
                continue
            for attr_name in ("platforms", "platform_insts", "_platforms", "_platform_insts", "instances"):
                value = _safe_attr(manager, attr_name)
                if isinstance(value, dict):
                    candidates.extend(value.values())
                elif isinstance(value, list):
                    candidates.extend(value)
            for method in ("get_all_platforms", "get_platforms"):
                value = _safe_call(manager, method, default=None)
                if isinstance(value, dict):
                    candidates.extend(value.values())
                elif isinstance(value, list):
                    candidates.extend(value)

        seen: set[int] = set()
        items: list[dict[str, Any]] = []
        for platform in candidates:
            marker = id(platform)
            if marker in seen:
                continue
            seen.add(marker)
            items.append(
                _redact(
                    {
                        "id": _safe_attr(platform, "id", "") or _safe_attr(platform, "platform_id", ""),
                        "name": _safe_attr(platform, "name", "") or _safe_attr(platform, "platform_name", ""),
                        "type": platform.__class__.__name__,
                        "enabled": _safe_attr(platform, "enabled", None),
                    }
                )
            )
        return items

    def _log_tail_signature(self, stat: dict[str, Any]) -> tuple[Any, ...]:
        return (
            bool(stat.get("exists")),
            bool(stat.get("readable")),
            stat.get("size"),
            stat.get("mtime"),
            stat.get("error"),
        )

    def _copy_log_tail(self, data: dict[str, Any]) -> dict[str, Any]:
        copied = dict(data)
        lines = copied.get("lines")
        if isinstance(lines, list):
            copied["lines"] = list(lines)
        return copied

    def _prune_log_tail_cache(self) -> None:
        if len(self._log_tail_cache) <= 32:
            return
        stale_keys = sorted(
            self._log_tail_cache,
            key=lambda key: float(self._log_tail_cache[key].get("used_at") or 0),
        )[:-24]
        for key in stale_keys:
            self._log_tail_cache.pop(key, None)

    async def _tail_log_file_cached(
        self,
        path: Path,
        *,
        max_bytes: int,
        max_lines: int,
        redact: bool,
    ) -> dict[str, Any]:
        key = (str(path), int(max_bytes), int(max_lines), bool(redact))
        stat = await asyncio.to_thread(_file_stat, path)
        signature = self._log_tail_signature(stat)
        cached = self._log_tail_cache.get(key)
        if cached and cached.get("signature") == signature:
            cached["used_at"] = time.time()
            return self._copy_log_tail(cached.get("data") or {})

        if not stat.get("exists") or not stat.get("readable"):
            data = {**stat, "lines": [], "truncated": False, "line_count": 0, "base_line": 0, "ends_with_newline": True}
        else:
            data = await asyncio.to_thread(
                _tail_file_sync,
                path,
                max_bytes=max_bytes,
                max_lines=max_lines,
                redact=redact,
            )

        data.setdefault("reset", True)
        data["cursor"] = _log_cursor_payload(data)
        self._log_tail_cache[key] = {
            "signature": self._log_tail_signature(data),
            "data": self._copy_log_tail(data),
            "used_at": time.time(),
        }
        self._prune_log_tail_cache()
        return self._copy_log_tail(data)

    async def _collect_log_stats(self) -> dict[str, Any]:
        astrbot = [item for item in self._astrbot_log_paths()]
        max_lines = min(
            self._astrbot_cfg_int("tail_lines", 300, 1, 3000),
            self._threshold_int("summary_log_lines", 180, 20, 1000),
        )
        max_bytes = min(
            self._astrbot_cfg_int("tail_bytes", 262144, 4096, 4 * 1024 * 1024),
            self._threshold_int("summary_log_bytes", 131072, 4096, 2 * 1024 * 1024),
        )
        redact = self._security_cfg_bool("redact_secrets", True)
        stale_seconds = self._threshold_int("stale_log_minutes", DEFAULT_THRESHOLDS["stale_log_minutes"], 1, 1440) * 60
        cache_key = (
            tuple(str(path) for path in astrbot),
            max_lines,
            max_bytes,
            redact,
            stale_seconds,
        )
        now = time.time()
        cache_ttl = max(4.0, min(30.0, self._cfg_int("refresh_interval_seconds", 5, 2, 120) * 2.0))
        cached = self._log_stats_cache
        if cached.get("key") == cache_key and now - float(cached.get("ts") or 0) < cache_ttl:
            return copy.deepcopy(cached.get("data") or {})

        tasks = [
            self._tail_log_file_cached(path, max_bytes=max_bytes, max_lines=max_lines, redact=redact)
            for path in astrbot
        ]
        tailed = await asyncio.gather(*tasks) if tasks else []
        file_stats = [{key: value for key, value in item.items() if key != "lines"} for item in tailed]
        data = {
            "astrbot": file_stats,
            "analysis": _analyze_log_files(tailed, stale_seconds=stale_seconds),
        }
        self._log_stats_cache = {
            "key": cache_key,
            "ts": now,
            "data": copy.deepcopy(data),
        }
        return data

    def _build_diagnostics(self, astrbot: dict[str, Any], system: dict[str, Any], logs: dict[str, Any]) -> dict[str, Any]:
        issues: list[dict[str, Any]] = []

        def add(level: str, title: str, detail: str, target: str = "") -> None:
            issues.append({"level": level, "title": title, "detail": detail, "target": target})

        def check_usage(label: str, percent: Any, warn: float, bad: float, target: str) -> None:
            try:
                value = float(percent)
            except (TypeError, ValueError):
                return
            if value >= bad:
                add("bad", f"{label}使用率过高", f"当前 {value:.1f}%，已超过 {bad:.1f}% 阈值。", target)
            elif value >= warn:
                add("warn", f"{label}使用率偏高", f"当前 {value:.1f}%，已超过 {warn:.1f}% 阈值。", target)

        thresholds = {
            "cpu_warn_percent": self._threshold_float("cpu_warn_percent", DEFAULT_THRESHOLDS["cpu_warn_percent"], 1, 100),
            "cpu_bad_percent": self._threshold_float("cpu_bad_percent", DEFAULT_THRESHOLDS["cpu_bad_percent"], 1, 100),
            "memory_warn_percent": self._threshold_float("memory_warn_percent", DEFAULT_THRESHOLDS["memory_warn_percent"], 1, 100),
            "memory_bad_percent": self._threshold_float("memory_bad_percent", DEFAULT_THRESHOLDS["memory_bad_percent"], 1, 100),
            "disk_warn_percent": self._threshold_float("disk_warn_percent", DEFAULT_THRESHOLDS["disk_warn_percent"], 1, 100),
            "disk_bad_percent": self._threshold_float("disk_bad_percent", DEFAULT_THRESHOLDS["disk_bad_percent"], 1, 100),
            "error_warn_count": self._threshold_int("error_warn_count", DEFAULT_THRESHOLDS["error_warn_count"], 0, 100000),
            "error_bad_count": self._threshold_int("error_bad_count", DEFAULT_THRESHOLDS["error_bad_count"], 0, 100000),
            "stale_log_minutes": self._threshold_int("stale_log_minutes", DEFAULT_THRESHOLDS["stale_log_minutes"], 1, 1440),
        }

        if self._cfg_str("host", "127.0.0.1") == "0.0.0.0" and not self._cfg_str("access_token", "").strip():
            add("warn", "远程 API 需要访问令牌", "当前监听所有网卡且 access_token 为空，远程 API 请求会被拒绝。", "security")

        platforms = astrbot.get("platforms") or {}
        if int(platforms.get("total") or 0) <= 0:
            add("warn", "未检测到消息平台", "运行时和配置中都没有可展示的消息平台。", "astrbot")

        cpu = system.get("cpu") or {}
        memory = system.get("memory") or {}
        check_usage("CPU", cpu.get("percent"), thresholds["cpu_warn_percent"], thresholds["cpu_bad_percent"], "system.cpu")
        check_usage("内存", memory.get("percent"), thresholds["memory_warn_percent"], thresholds["memory_bad_percent"], "system.memory")
        for disk in system.get("disks") or []:
            label = f"磁盘 {disk.get('path') or disk.get('resolved_path') or ''}".strip()
            check_usage(label, disk.get("percent"), thresholds["disk_warn_percent"], thresholds["disk_bad_percent"], "system.disk")

        analysis = logs.get("analysis") or {}
        counts = analysis.get("counts") or {}
        errors = int(counts.get("error") or 0)
        warnings = int(counts.get("warn") or 0)
        if errors >= thresholds["error_bad_count"] > 0:
            add("bad", "最近日志错误较多", f"摘要窗口内检测到 {errors} 条错误日志。", "logs")
        elif errors >= thresholds["error_warn_count"] > 0:
            add("warn", "最近日志存在错误", f"摘要窗口内检测到 {errors} 条错误日志。", "logs")
        if warnings:
            add("info", "最近日志存在警告", f"摘要窗口内检测到 {warnings} 条警告日志。", "logs")
        if int(analysis.get("missing_files") or 0):
            add("warn", "日志文件缺失", f"{analysis.get('missing_files')} 个配置的日志文件不存在。", "logs")
        if int(analysis.get("unreadable_files") or 0):
            add("warn", "日志文件不可读", f"{analysis.get('unreadable_files')} 个配置的日志文件不可读。", "logs")
        readable_files = int(analysis.get("readable_files") or 0)
        stale_files = analysis.get("stale_files") or []
        if readable_files and len(stale_files) >= readable_files:
            add("warn", "日志可能停止写入", f"全部可读日志超过 {thresholds['stale_log_minutes']} 分钟未更新。", "logs")
        elif stale_files:
            add("info", "部分日志较久未更新", f"{len(stale_files)} 个日志文件超过 {thresholds['stale_log_minutes']} 分钟未更新。", "logs")
        if int(analysis.get("truncated_files") or 0):
            add("info", "日志读取被截断", "部分日志文件超过读取窗口，只展示尾部内容。", "logs")

        bad_count = sum(1 for item in issues if item["level"] == "bad")
        warn_count = sum(1 for item in issues if item["level"] == "warn")
        info_count = sum(1 for item in issues if item["level"] == "info")
        status = "bad" if bad_count else "warn" if warn_count else "ok"
        score = max(0, min(100, 100 - bad_count * 25 - warn_count * 10 - info_count * 3))
        return {
            "status": status,
            "score": score,
            "issue_count": len(issues),
            "bad_count": bad_count,
            "warn_count": warn_count,
            "info_count": info_count,
            "issues": issues[:24],
            "thresholds": thresholds,
        }

    def _collect_system(self, *, compact: bool = False) -> dict[str, Any]:
        cpu_now = _read_cpu_times()
        cpu_percent: float | None = None
        if cpu_now and self._last_cpu_times:
            total_delta = cpu_now[0] - self._last_cpu_times[0]
            idle_delta = cpu_now[1] - self._last_cpu_times[1]
            if total_delta > 0:
                cpu_percent = round(max(0.0, min(100.0, (1 - idle_delta / total_delta) * 100)), 2)
        if cpu_now:
            self._last_cpu_times = cpu_now

        mem = _read_proc_key_values(Path("/proc/meminfo"))
        total_mem = _kib_value(mem.get("MemTotal"))
        available_mem = _kib_value(mem.get("MemAvailable")) or _kib_value(mem.get("MemFree"))
        used_mem = max(0, total_mem - available_mem)
        swap_total = _kib_value(mem.get("SwapTotal"))
        swap_free = _kib_value(mem.get("SwapFree"))
        swap_used = max(0, swap_total - swap_free)

        boot_seconds = 0.0
        try:
            boot_seconds = float(Path("/proc/uptime").read_text(encoding="utf-8").split()[0])
        except (OSError, ValueError, IndexError):
            pass

        root_disk = _disk_usage(Path("/"))
        data_disk = _disk_usage(self.data_dir)
        process = self._collect_process_info(compact=compact)
        network = self._collect_network_info(compact=compact)

        system = {
            "host": {
                "hostname": socket.gethostname(),
                "platform": platform.platform(),
                "system": platform.system(),
                "release": platform.release(),
                "machine": platform.machine(),
                "boot_time": time.time() - boot_seconds if boot_seconds else None,
                "uptime_seconds": boot_seconds,
            },
            "cpu": {
                "model": _read_cpu_model() or platform.processor(),
                "logical_count": os.cpu_count() or 0,
                "load_average": _load_average(),
                "percent": cpu_percent,
            },
            "memory": {
                "total": total_mem,
                "available": available_mem,
                "used": used_mem,
                "percent": round((used_mem / total_mem) * 100, 2) if total_mem else 0,
                "swap_total": swap_total,
                "swap_used": swap_used,
                "swap_percent": round((swap_used / swap_total) * 100, 2) if swap_total else 0,
            },
            "disks": [
                root_disk,
                data_disk,
            ],
            "network": network,
            "process": process,
            "python": {
                "version": platform.python_version(),
                "implementation": platform.python_implementation(),
                "executable": sys.executable,
            },
        }
        if compact:
            system["network"] = {
                "interfaces": [
                    item for item in network.get("interfaces", [])
                    if item.get("name") != "lo" and (item.get("addresses") or item.get("state") == "up")
                ][:6]
            }
        return system

    def _collect_process_info(self, *, compact: bool = False) -> dict[str, Any]:
        status = _read_proc_key_values(Path("/proc/self/status"))
        result = {
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "rss": _kib_value(status.get("VmRSS")),
            "vms": _kib_value(status.get("VmSize")),
            "threads": _as_int(status.get("Threads"), 0),
            "max_rss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            "plugin_uptime_seconds": round(time.time() - self._started_at, 3),
        }
        if compact:
            # 精简模式：省略长字符串字段与 fd 计数，减少传输与噪音
            return result
        if not _is_linux():
            return result
        cmdline = _read_text_sync(Path("/proc/self/cmdline")).replace("\x00", " ").strip()
        fd_count = 0
        try:
            fd_count = len(list(Path("/proc/self/fd").iterdir()))
        except OSError:
            pass
        try:
            cwd = str(Path("/proc/self/cwd").resolve())
        except OSError:
            cwd = ""
        result["cmdline"] = cmdline
        result["cwd"] = cwd
        result["open_fds"] = fd_count
        return result

    def _collect_network_info(self, *, compact: bool = False) -> dict[str, Any]:
        if not _is_linux():
            return {"interfaces": []}
        counters = _network_counters()
        addresses = _interface_addresses()
        interfaces: list[dict[str, Any]] = []
        for path in sorted(Path("/sys/class/net").glob("*")):
            name = path.name
            item = {
                "name": name,
                "state": _read_text_sync(path / "operstate") or "unknown",
                "addresses": addresses.get(name, []),
                **counters.get(name, {}),
            }
            if compact:
                # 精简模式：仅保留连通性与流量（bytes），移除排查无用的 packets/mtu/mac
                for noisy in ("rx_packets", "tx_packets"):
                    item.pop(noisy, None)
            else:
                item["mtu"] = _as_int(_read_text_sync(path / "mtu"), 0)
                item["mac"] = _read_text_sync(path / "address")
                item["speed_mbps"] = _as_int(_read_text_sync(path / "speed"), 0)
            interfaces.append(item)
        return {"interfaces": interfaces}

    async def _collect_astrbot_logs(self, *, cursor: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        max_lines = self._astrbot_cfg_int("tail_lines", 300, 1, 3000)
        max_bytes = self._astrbot_cfg_int("tail_bytes", 262144, 4096, 4 * 1024 * 1024)
        redact = self._security_cfg_bool("redact_secrets", True)
        paths = self._astrbot_log_paths()
        if cursor:
            tasks = [
                asyncio.to_thread(
                    _tail_file_incremental_sync,
                    path,
                    max_bytes=max_bytes,
                    max_lines=max_lines,
                    redact=redact,
                    cursor=cursor.get(str(path)),
                )
                for path in paths
            ]
        else:
            tasks = [
                self._tail_log_file_cached(path, max_bytes=max_bytes, max_lines=max_lines, redact=redact)
                for path in paths
            ]
        return await asyncio.gather(*tasks) if tasks else []

    def _astrbot_log_paths(self) -> list[Path]:
        logs_dir = Path(self._astrbot_cfg_str("logs_dir", "data/logs")).expanduser()
        files = _as_list(self._astrbot_cfg("log_files", DEFAULT_ASTRBOT_LOG_FILES), DEFAULT_ASTRBOT_LOG_FILES)
        paths: list[Path] = []
        for item in files:
            path = Path(str(item)).expanduser()
            if not path.is_absolute():
                path = logs_dir / path
            paths.append(path)
        return paths

    def _public_config(self) -> dict[str, Any]:
        return _redact(
            {
                "enabled": self._cfg_bool("enabled", True),
                "host": self._cfg_str("host", "127.0.0.1"),
                "port": self._cfg_int("port", 6199, 1, 65535),
                "has_access_token": bool(self._cfg_str("access_token", "")),
                "refresh_interval_seconds": self._cfg_int("refresh_interval_seconds", 5, 2, 120),
                "log_stream_enabled": self._use_log_stream,
                "log_stream_available": LOGBROKER_AVAILABLE,
                "astrbot": {
                    "logs_dir": self._astrbot_cfg_str("logs_dir", "data/logs"),
                    "log_files": _as_list(self._astrbot_cfg("log_files", DEFAULT_ASTRBOT_LOG_FILES), DEFAULT_ASTRBOT_LOG_FILES),
                    "tail_lines": self._astrbot_cfg_int("tail_lines", 300, 1, 3000),
                    "tail_bytes": self._astrbot_cfg_int("tail_bytes", 262144, 4096, 4 * 1024 * 1024),
                },
                "security": {
                    "redact_secrets": self._security_cfg_bool("redact_secrets", True),
                },
                "ui": {
                    "slow_session_seconds": self._ui_cfg_int("slow_session_seconds", DEFAULT_UI["slow_session_seconds"], 1, 3600),
                    "slow_tool_seconds": self._ui_cfg_int("slow_tool_seconds", DEFAULT_UI["slow_tool_seconds"], 1, 3600),
                    "running_timeout_minutes": self._ui_cfg_int("running_timeout_minutes", DEFAULT_UI["running_timeout_minutes"], 1, 1440),
                    "important_event_limit": self._ui_cfg_int("important_event_limit", DEFAULT_UI["important_event_limit"], 10, 500),
                    "log_page_size": self._ui_cfg_int("log_page_size", DEFAULT_UI["log_page_size"], 20, 500),
                    "privacy_mode": self._ui_cfg_bool("privacy_mode", DEFAULT_UI["privacy_mode"]),
                },
                "thresholds": {
                    "cpu_warn_percent": self._threshold_float("cpu_warn_percent", DEFAULT_THRESHOLDS["cpu_warn_percent"], 1, 100),
                    "cpu_bad_percent": self._threshold_float("cpu_bad_percent", DEFAULT_THRESHOLDS["cpu_bad_percent"], 1, 100),
                    "memory_warn_percent": self._threshold_float("memory_warn_percent", DEFAULT_THRESHOLDS["memory_warn_percent"], 1, 100),
                    "memory_bad_percent": self._threshold_float("memory_bad_percent", DEFAULT_THRESHOLDS["memory_bad_percent"], 1, 100),
                    "disk_warn_percent": self._threshold_float("disk_warn_percent", DEFAULT_THRESHOLDS["disk_warn_percent"], 1, 100),
                    "disk_bad_percent": self._threshold_float("disk_bad_percent", DEFAULT_THRESHOLDS["disk_bad_percent"], 1, 100),
                    "error_warn_count": self._threshold_int("error_warn_count", DEFAULT_THRESHOLDS["error_warn_count"], 0, 100000),
                    "error_bad_count": self._threshold_int("error_bad_count", DEFAULT_THRESHOLDS["error_bad_count"], 0, 100000),
                    "stale_log_minutes": self._threshold_int("stale_log_minutes", DEFAULT_THRESHOLDS["stale_log_minutes"], 1, 1440),
                    "summary_log_lines": self._threshold_int("summary_log_lines", 180, 20, 1000),
                    "summary_log_bytes": self._threshold_int("summary_log_bytes", 131072, 4096, 2 * 1024 * 1024),
                },
            }
        )

    def _cfg(self, key: str, default: Any = None) -> Any:
        getter = getattr(self.config, "get", None)
        if callable(getter):
            return getter(key, default)
        return default

    def _cfg_str(self, key: str, default: str = "") -> str:
        value = self._cfg(key, default)
        if value is None:
            return default
        return str(value)

    def _cfg_int(self, key: str, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
        return _as_int(self._cfg(key, default), default, min_value, max_value)

    def _cfg_bool(self, key: str, default: bool = False) -> bool:
        return _as_bool(self._cfg(key, default), default)

    def _section(self, name: str) -> dict[str, Any]:
        value = self._cfg(name, {})
        return value if isinstance(value, dict) else {}

    def _section_cfg(self, section: str, key: str, default: Any = None) -> Any:
        return self._section(section).get(key, default)

    def _astrbot_cfg(self, key: str, default: Any = None) -> Any:
        return self._section_cfg("astrbot", key, default)

    def _astrbot_cfg_str(self, key: str, default: str = "") -> str:
        value = self._astrbot_cfg(key, default)
        return default if value is None else str(value)

    def _astrbot_cfg_int(self, key: str, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
        return _as_int(self._astrbot_cfg(key, default), default, min_value, max_value)

    def _security_cfg_bool(self, key: str, default: bool = False) -> bool:
        return _as_bool(self._section_cfg("security", key, default), default)

    def _ui_cfg_int(self, key: str, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
        return _as_int(self._section_cfg("ui", key, default), default, min_value, max_value)

    def _ui_cfg_bool(self, key: str, default: bool = False) -> bool:
        return _as_bool(self._section_cfg("ui", key, default), default)

    def _threshold_int(self, key: str, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
        return _as_int(self._section_cfg("thresholds", key, default), default, min_value, max_value)

    def _threshold_float(self, key: str, default: float, min_value: float | None = None, max_value: float | None = None) -> float:
        return _as_float(self._section_cfg("thresholds", key, default), default, min_value, max_value)

    # ==================== LogBroker 日志流集成方法 ====================

    async def _try_init_log_broker(self) -> None:
        """尝试从 AstrBot 核心获取 LogBroker 实例（使用策略模式）"""
        if not self._cfg_bool("enable_log_stream", False):
            logger.info("[ObserverPanel] 配置已关闭实时日志流（enable_log_stream=false），使用文件轮询模式")
            self._use_log_stream = False
            return

        if not LOGBROKER_AVAILABLE:
            logger.info("[ObserverPanel] LogBroker 不可用，将使用文件读取模式")
            self._use_log_stream = False
            return

        strategies = [
            self._try_log_broker_from_context,
            self._try_log_broker_from_managers,
            self._try_log_broker_from_logger,
            self._try_log_broker_from_modules,
        ]

        for strategy in strategies:
            try:
                log_broker = strategy()
                if log_broker is not None:
                    await self._activate_log_broker(log_broker)
                    return
            except Exception as e:
                logger.debug(f"[ObserverPanel] 策略 {strategy.__name__} 失败: {e}")

        logger.info("[ObserverPanel] 未能获取 LogBroker 实例，将使用文件读取模式")
        logger.debug("[ObserverPanel] 提示：如果需要日志流功能，请确保 AstrBot 核心正确初始化了 LogBroker")
        self._use_log_stream = False

    def _try_log_broker_from_context(self):
        """策略1: 通过 context 内部属性获取 LogBroker"""
        logger.debug("[ObserverPanel] 尝试策略1: 通过 context 内部属性")
        for attr_name in ['_core_lifecycle', 'core_lifecycle', '_core', 'core', '_internal']:
            if hasattr(self.context, attr_name):
                core = getattr(self.context, attr_name, None)
                if core and hasattr(core, 'log_broker'):
                    logger.info(f"[ObserverPanel] 通过 context.{attr_name}.log_broker 获取到 LogBroker")
                    return core.log_broker
        return None

    def _try_log_broker_from_managers(self):
        """策略2: 通过 context 的管理器获取 LogBroker"""
        logger.debug("[ObserverPanel] 尝试策略2: 通过管理器")
        manager_attrs = [
            'provider_manager', 'platform_manager', 'conversation_manager',
            'astrbot_config_mgr', 'kb_manager', 'cron_manager', 'subagent_orchestrator'
        ]
        for manager_attr in manager_attrs:
            if hasattr(self.context, manager_attr):
                manager = getattr(self.context, manager_attr)
                if manager is None:
                    continue
                for core_attr in ['_core_lifecycle', 'core_lifecycle', '_core', 'core']:
                    if hasattr(manager, core_attr):
                        core = getattr(manager, core_attr, None)
                        if core and hasattr(core, 'log_broker'):
                            logger.info(f"[ObserverPanel] 通过 context.{manager_attr}.{core_attr}.log_broker 获取到 LogBroker")
                            return core.log_broker
        return None

    def _try_log_broker_from_logger(self):
        """策略3: 通过全局 logger 对象获取 LogBroker"""
        logger.debug("[ObserverPanel] 尝试策略3: 检查 logger handlers")
        from astrbot.api import logger as astrbot_logger
        if hasattr(astrbot_logger, 'handlers'):
            for handler in astrbot_logger.handlers:
                if hasattr(handler, 'log_broker'):
                    logger.info("[ObserverPanel] 通过 logger.handlers 获取到 LogBroker")
                    return handler.log_broker
        return None

    def _try_log_broker_from_modules(self):
        """策略4: 从核心模块扫描获取 LogBroker"""
        logger.debug("[ObserverPanel] 尝试策略4: 核心模块扫描")
        for module_name in ['astrbot.core', 'astrbot.core.log', 'astrbot.core.lifecycle']:
            module = sys.modules.get(module_name)
            if module is None:
                continue
            for attr_name in ['log_broker', 'LogBroker', '_log_broker']:
                obj = getattr(module, attr_name, None)
                if obj is not None and hasattr(obj, 'register'):
                    logger.info(f"[ObserverPanel] 通过 {module_name}.{attr_name} 获取到 LogBroker")
                    return obj
        return None

    async def _activate_log_broker(self, log_broker) -> None:
        """激活 LogBroker 并启动日志流处理"""
        self._log_broker = log_broker
        self._log_queue = log_broker.register()
        self._use_log_stream = True

        # 复制已缓存的历史日志
        if hasattr(log_broker, 'log_cache'):
            cached_logs = list(log_broker.log_cache)
            self._log_stream_cache.extend(cached_logs)
            logger.info(f"[ObserverPanel] 已加载 {len(cached_logs)} 条历史日志")

        # 启动后台任务处理日志流
        self._log_stream_task = asyncio.create_task(self._process_log_stream())

        logger.info("[ObserverPanel] ✓ LogBroker 日志流已启用，实时日志功能已激活")

    async def _process_log_stream(self) -> None:
        """后台任务：持续处理 LogBroker 的日志流"""
        if self._log_queue is None:
            return

        try:
            logger.debug("[ObserverPanel] 日志流处理任务已启动")
            while True:
                # 从队列获取日志条目
                log_entry = await self._log_queue.get()

                # 添加到本地缓存
                self._log_stream_cache.append(log_entry)

                # 分发给所有 SSE 订阅者
                dead_subscribers = []
                for subscriber in self._log_subscribers:
                    try:
                        subscriber.put_nowait(log_entry)
                    except asyncio.QueueFull:
                        # 队列满了，跳过这条日志（避免阻塞）
                        # 记录警告，让用户知道日志可能不完整
                        logger.warning("[ObserverPanel] SSE 订阅者队列已满，丢弃日志条目")
                    except Exception as e:
                        # 订阅者已失效
                        logger.debug(f"[ObserverPanel] 检测到失效的订阅者: {e}")
                        dead_subscribers.append(subscriber)

                # 清理失效的订阅者
                for sub in dead_subscribers:
                    if sub in self._log_subscribers:
                        self._log_subscribers.remove(sub)

        except asyncio.CancelledError:
            logger.debug("[ObserverPanel] 日志流处理任务已取消")
        except Exception as e:
            logger.error(f"[ObserverPanel] 日志流处理错误: {e}", exc_info=True)

    async def _cleanup_log_broker(self) -> None:
        """清理 LogBroker 相关资源"""
        # 取消后台任务
        if self._log_stream_task is not None:
            self._log_stream_task.cancel()
            try:
                await self._log_stream_task
            except asyncio.CancelledError:
                pass
            self._log_stream_task = None

        # 注销日志队列
        if self._log_broker is not None and self._log_queue is not None:
            try:
                self._log_broker.unregister(self._log_queue)
                logger.debug("[ObserverPanel] 已注销 LogBroker 订阅")
            except Exception as e:
                logger.warning(f"[ObserverPanel] 注销 LogBroker 时出错: {e}")
            self._log_queue = None
            self._log_broker = None

        # 清理缓存和订阅者
        self._log_stream_cache.clear()
        self._log_subscribers.clear()

    def _subscribe_log_stream(self) -> asyncio.Queue:
        """创建一个新的日志流订阅（用于 SSE）"""
        queue = asyncio.Queue(maxsize=600)
        self._log_subscribers.append(queue)
        return queue

    def _unsubscribe_log_stream(self, queue: asyncio.Queue) -> None:
        """取消日志流订阅"""
        if queue in self._log_subscribers:
            self._log_subscribers.remove(queue)

    async def _get_stream_logs(self, limit: int = 300, time_window_minutes: int = 0) -> list[dict[str, Any]]:
        """从日志流缓存获取最近的日志

        Args:
            limit: 最多返回的日志条数
            time_window_minutes: 时间窗口（分钟），0 表示不限制

        Returns:
            日志列表
        """
        logs = list(self._log_stream_cache)

        # 如果指定了时间窗口，过滤日志
        if time_window_minutes > 0:
            cutoff_time = time.time() - (time_window_minutes * 60)
            logs = [log for log in logs if log.get("time", 0) >= cutoff_time]

        return logs[-limit:] if len(logs) > limit else logs

    # ==================== 新增 API 处理器 ====================

    async def _handle_logs_stream(self, request: web.Request) -> web.StreamResponse:
        """SSE 实时日志流接口"""
        if not self._use_log_stream:
            return _json_response({"ok": False, "error": "日志流不可用，已切换文件模式"}, status=503)

        async def log_generator():
            """生成器：持续推送日志"""
            # 1. 首先发送历史日志
            history_limit = _as_int(request.query.get("history"), 50, 0, 200)
            if history_limit > 0:
                history = await self._get_stream_logs(history_limit)
                for log_entry in history:
                    data = json.dumps(log_entry, ensure_ascii=False)
                    yield f"data: {data}\n\n"

            # 2. 订阅实时日志流
            queue = self._subscribe_log_stream()
            try:
                while True:
                    try:
                        # 20秒超时，用于发送心跳（兼容更严格的代理/负载均衡空闲超时）
                        log_entry = await asyncio.wait_for(queue.get(), timeout=20.0)
                        data = json.dumps(log_entry, ensure_ascii=False)
                        yield f"data: {data}\n\n"
                    except asyncio.TimeoutError:
                        # 发送心跳保持连接
                        yield ": heartbeat\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                self._unsubscribe_log_stream(queue)

        # 创建 SSE 响应
        response = web.StreamResponse()
        response.headers['Content-Type'] = 'text/event-stream'
        response.headers['Cache-Control'] = 'no-cache'
        response.headers['Connection'] = 'keep-alive'
        response.headers['X-Accel-Buffering'] = 'no'  # 禁用 nginx 缓冲
        await response.prepare(request)

        try:
            async for chunk in log_generator():
                try:
                    await response.write(chunk.encode('utf-8'))
                    # 确保立即发送
                    await response.drain()
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                    # 客户端断开连接，这是正常的
                    break
                except Exception as e:
                    # 检查是否是连接关闭相关的错误
                    error_msg = str(e).lower()
                    if any(keyword in error_msg for keyword in ['closing', 'closed', 'reset', 'broken']):
                        # 这些都是客户端断开的正常情况，不记录错误
                        break
                    else:
                        # 其他错误才记录
                        logger.error(f"[ObserverPanel] SSE 写入错误: {e}")
                        break
        except asyncio.CancelledError:
            # 请求被取消，正常情况
            pass
        except Exception as e:
            error_msg = str(e).lower()
            if not any(keyword in error_msg for keyword in ['closing', 'closed', 'reset', 'broken']):
                logger.error(f"[ObserverPanel] SSE 流错误: {e}")
        finally:
            try:
                await response.write_eof()
            except Exception:
                # 连接已关闭，忽略
                pass

        return response

    async def _handle_logs_live(self, request: web.Request) -> web.Response:
        """获取实时日志（轮询方式）"""
        if not self._use_log_stream:
            # Fallback 到文件读取模式
            return await self._handle_logs(request)

        limit = _as_int(request.query.get("limit"), 100, 1, 500)
        since_ts = _as_float(request.query.get("since"), 0.0, 0.0)

        # 获取缓存的日志（轮询模式不限制时间窗口，避免 since 过滤前被截断）
        logs = await self._get_stream_logs(500, time_window_minutes=0)

        # 过滤出 since 之后的日志
        if since_ts > 0:
            logs = [log for log in logs if float(log.get("time", 0)) > since_ts]

        # 限制数量
        logs = logs[-limit:]

        latest_ts = logs[-1].get("time", 0) if logs else since_ts

        return _json_response({
            "ok": True,
            "data": {
                "logs": logs,
                "use_log_stream": True,
                "count": len(logs),
                "latest_ts": latest_ts
            },
            "now": _now_ms()
        })
