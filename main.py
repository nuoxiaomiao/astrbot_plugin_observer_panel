from __future__ import annotations

import asyncio
import copy
import hmac
import ipaddress
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

from aiohttp import web
from aiohttp.web_response import Response

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, StarTools, register

try:
    import resource
except ImportError:
    resource = None

try:
    import psutil  # type: ignore
except ImportError:
    psutil = None  # type: ignore

# 可选：AstrBot 核心 LogBroker（不可用时仅文件 SSE）
try:
    from astrbot.core import LogBroker as _LogBrokerType  # type: ignore

    LOGBROKER_IMPORTABLE = True
except Exception:
    _LogBrokerType = None  # type: ignore
    LOGBROKER_IMPORTABLE = False


PLUGIN_NAME = "astrbot_plugin_observer_panel"
PLUGIN_VERSION = "0.4.5"

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
DEFAULT_LOG_STREAM = {
    "enabled": True,
    "interval_ms": 500,
    "prefer_logbroker": True,
}
LOGBROKER_VIRTUAL_PATH = "runtime:logbroker"
LOGBROKER_CACHE_MAX = 500
SSE_SUBSCRIBER_QUEUE_SIZE = 32
SSE_HEARTBEAT_SECONDS = 30.0

ALLOWED_LOG_SOURCES = {"all", "astrbot"}
AUTH_COOKIE_NAME = "observer_panel_token"
# 会话 Cookie 存随机 id，不存 access_token 明文
SESSION_TTL_SECONDS = 7 * 24 * 3600
SESSION_ID_BYTES = 32
LOGIN_RATE_WINDOW_SECONDS = 300
LOGIN_RATE_MAX_ATTEMPTS = 12
# 兼容旧 Cookie：值等于密码时接受并升级为 session
LEGACY_PASSWORD_COOKIE = True

SECRET_KEY_RE = re.compile(
    r"(?i)(?<![\w])(api[_-]?key|access[_-]?token|authorization|bearer|secret|password|passwd|token|key)(?![\w])"
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


def _is_windows() -> bool:
    return platform.system() == "Windows"


def _system_drive_root() -> Path:
    """系统根磁盘路径：Windows 用 SystemDrive，其它用 /。"""
    if _is_windows():
        drive = str(os.environ.get("SystemDrive") or "C:").rstrip("\\/")
        return Path(f"{drive}\\")
    return Path("/")


def _normalize_path_key(path: Path) -> str:
    text = str(path)
    try:
        text = str(path.resolve())
    except OSError:
        pass
    if _is_windows():
        return os.path.normcase(text)
    return text


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


def _privacy_mask_log_line(line: str) -> str:
    """privacy_mode 下对 API 返回的日志正文做服务端遮罩，仅保留时间头与级别线索。"""
    text = str(line or "")
    if not text.strip():
        return text
    timestamped = re.match(r"^(\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\])\s*(.*)$", text)
    prefix = ""
    body = text
    if timestamped:
        prefix = f"{timestamped.group(1)} "
        body = timestamped.group(2)
    level = _parse_log_level(text)
    level_tag = f"[{level.upper()}] " if level and level != "other" else ""
    return f"{prefix}{level_tag}[隐私模式已隐藏日志正文]"


def _apply_privacy_to_log_payload(data: dict[str, Any], *, privacy: bool) -> dict[str, Any]:
    if not privacy or not isinstance(data, dict):
        return data
    copied = dict(data)
    lines = copied.get("lines")
    if isinstance(lines, list):
        copied["lines"] = [_privacy_mask_log_line(str(line)) for line in lines]
    return copied


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        resolved_path = path.resolve()
        resolved_root = root.resolve()
        if _is_windows():
            return os.path.normcase(str(resolved_path)).startswith(
                os.path.normcase(str(resolved_root)).rstrip("\\/") + os.sep
            ) or os.path.normcase(str(resolved_path)) == os.path.normcase(str(resolved_root))
        resolved_path.relative_to(resolved_root)
        return True
    except (OSError, ValueError):
        return False


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
    readable = False
    try:
        with path.open("rb"):
            readable = True
    except OSError:
        # Windows ACL 下 os.access 不可靠；open 失败再回退 access
        readable = os.access(path, os.R_OK)
    return {
        "path": str(path),
        "exists": True,
        "readable": readable,
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
    except (OSError, AttributeError):
        return []


def _disk_usage(path: Path) -> dict[str, Any]:
    target = path
    if not target.exists():
        target = _system_drive_root()
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


def _is_loopback_iface(name: str, *, is_loopback: bool | None = None) -> bool:
    if is_loopback is True:
        return True
    text = str(name or "").strip().lower()
    if not text:
        return False
    if text in {"lo", "lo0"}:
        return True
    return text.startswith("loopback")


def _psutil_available() -> bool:
    return psutil is not None


def _collect_memory_portable() -> dict[str, Any]:
    """非 Linux：优先 psutil，否则返回空指标。"""
    empty = {
        "total": 0,
        "available": 0,
        "used": 0,
        "percent": 0.0,
        "swap_total": 0,
        "swap_used": 0,
        "swap_percent": 0.0,
    }
    if not _psutil_available():
        return empty
    try:
        vm = psutil.virtual_memory()
        swap = psutil.swap_memory()
        return {
            "total": int(vm.total),
            "available": int(vm.available),
            "used": int(vm.used),
            "percent": round(float(vm.percent), 2),
            "swap_total": int(swap.total),
            "swap_used": int(swap.used),
            "swap_percent": round(float(swap.percent), 2) if swap.total else 0.0,
        }
    except Exception:
        return empty


def _collect_boot_seconds_portable() -> float:
    if not _psutil_available():
        return 0.0
    try:
        boot = float(psutil.boot_time())
        if boot > 0:
            return max(0.0, time.time() - boot)
    except Exception:
        return 0.0
    return 0.0


def _collect_cpu_percent_portable(last_sample: float | None) -> tuple[float | None, float | None]:
    """
    返回 (percent, next_sample_marker)。
    psutil.cpu_percent(interval=None) 需连续采样；首次常为 0，可返回 None。
    """
    if not _psutil_available():
        return None, last_sample
    try:
        value = float(psutil.cpu_percent(interval=None))
        # 首次调用通常返回 0.0，不当作真实负载
        if last_sample is None and value == 0.0:
            return None, 0.0
        return round(max(0.0, min(100.0, value)), 2), value
    except Exception:
        return None, last_sample


def _collect_process_info_portable(*, compact: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "rss": 0,
        "vms": 0,
        "threads": 0,
        "max_rss": 0,
        "plugin_uptime_seconds": 0,
    }
    if _psutil_available():
        try:
            proc = psutil.Process()
            mem = proc.memory_info()
            result["rss"] = int(getattr(mem, "rss", 0) or 0)
            result["vms"] = int(getattr(mem, "vms", 0) or 0)
            result["threads"] = int(proc.num_threads())
            try:
                result["ppid"] = int(proc.ppid())
            except Exception:
                pass
            if not compact:
                try:
                    cmdline_parts = proc.cmdline() or []
                    cmdline = " ".join(str(part) for part in cmdline_parts).strip()
                    result["cmdline"] = str(_redact(cmdline))
                except Exception:
                    result["cmdline"] = ""
                try:
                    result["cwd"] = str(proc.cwd())
                except Exception:
                    result["cwd"] = ""
                try:
                    result["open_fds"] = int(proc.num_handles()) if _is_windows() else int(proc.num_fds())
                except Exception:
                    result["open_fds"] = 0
        except Exception:
            pass
    return result


def _collect_network_info_portable(*, compact: bool = False) -> dict[str, Any]:
    if not _psutil_available():
        return {"interfaces": [], "source": "unavailable"}
    try:
        addrs = psutil.net_if_addrs() or {}
        stats = psutil.net_if_stats() or {}
        counters = psutil.net_io_counters(pernic=True) or {}
    except Exception:
        return {"interfaces": [], "source": "error"}

    interfaces: list[dict[str, Any]] = []
    for name in sorted(addrs.keys(), key=lambda item: str(item).lower()):
        addr_list: list[str] = []
        for entry in addrs.get(name) or []:
            family = getattr(entry, "family", None)
            address = getattr(entry, "address", None)
            if not address:
                continue
            # 跳过 MAC 类链路地址，优先 IPv4/IPv6
            family_name = str(getattr(family, "name", family) or "")
            if family_name in {"AF_LINK", "AF_PACKET"}:
                continue
            if ":" in str(address) and "." not in str(address):
                # IPv6 可能带 %iface 后缀
                addr_list.append(str(address).split("%", 1)[0])
            else:
                addr_list.append(str(address))
        # 去重保序
        seen: set[str] = set()
        unique_addrs: list[str] = []
        for item in addr_list:
            if item in seen:
                continue
            seen.add(item)
            unique_addrs.append(item)

        st = stats.get(name)
        is_up = bool(getattr(st, "isup", False)) if st is not None else False
        is_loop = bool(getattr(st, "isloopback", False)) if st is not None and hasattr(st, "isloopback") else _is_loopback_iface(name)
        counter = counters.get(name)
        item: dict[str, Any] = {
            "name": name,
            "state": "up" if is_up else "down",
            "addresses": unique_addrs,
            "is_loopback": is_loop,
        }
        if counter is not None:
            item["rx_bytes"] = int(getattr(counter, "bytes_recv", 0) or 0)
            item["tx_bytes"] = int(getattr(counter, "bytes_sent", 0) or 0)
            if not compact:
                item["rx_packets"] = int(getattr(counter, "packets_recv", 0) or 0)
                item["tx_packets"] = int(getattr(counter, "packets_sent", 0) or 0)
        if not compact and st is not None:
            item["mtu"] = int(getattr(st, "mtu", 0) or 0)
            speed = int(getattr(st, "speed", 0) or 0)
            item["speed_mbps"] = speed if speed > 0 else 0
            item["mac"] = ""
        interfaces.append(item)
    return {"interfaces": interfaces, "source": "psutil"}


@register(
    PLUGIN_NAME,
    "nuoxiaomiao",
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
        self._last_cpu_percent_sample: float | None = None
        self._cpu_lock = threading.Lock()
        self._log_tail_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
        self._log_stats_cache: dict[str, Any] = {}
        self._started_at = time.time()
        self._system_cache: dict[str, Any] = {}

        # 文件 SSE hub（主路径）；LogBroker 可选 fan-in
        self._log_subscribers: list[asyncio.Queue] = []
        self._log_stream_task: asyncio.Task | None = None
        self._file_stream_cursors: dict[str, dict[str, Any]] = {}
        self._log_stream_enabled = False
        self._log_broker: Any | None = None
        self._log_broker_queue: Any | None = None
        self._log_broker_task: asyncio.Task | None = None
        self._log_broker_enabled = False
        self._log_broker_cache: deque = deque(maxlen=LOGBROKER_CACHE_MAX)
        self._log_broker_line_count = 0
        self._log_broker_base_line = 0
        self._log_broker_pending_lines: list[str] = []
        self._log_broker_lock = asyncio.Lock()

        # 登录会话：session_id -> expire_ts；失败计数按 IP
        self._auth_sessions: dict[str, float] = {}
        self._login_failures: dict[str, list[float]] = {}
        self._session_lock = threading.Lock()

        # 预热 psutil CPU 采样（非阻塞 interval=None）
        if not _is_linux() and _psutil_available():
            try:
                psutil.cpu_percent(interval=None)
                self._last_cpu_percent_sample = 0.0
            except Exception:
                pass

    async def initialize(self) -> None:
        if not self._cfg_bool("enabled", True):
            logger.info("[ObserverPanel] 已禁用，未启动 WebUI")
            return
        await self._start_log_stream_hub()
        await self._start_server()

    async def terminate(self) -> None:
        await self._stop_log_stream_hub()
        await self._stop_server()

    @property
    def base_url(self) -> str:
        host = self._cfg_str("host", "127.0.0.1")
        visible_host = "127.0.0.1" if host == "0.0.0.0" else host
        port = self._cfg_int("port", 7199, 1, 65535)
        return f"http://{visible_host}:{port}/"

    @property
    def public_url(self) -> str:
        return self.base_url

    async def _start_server(self) -> None:
        if self._runner is not None:
            return

        host = self._cfg_str("host", "127.0.0.1")
        port = self._cfg_int("port", 7199, 1, 65535)

        try:
            # 创建 aiohttp 应用并启用内置压缩
            # enable_compression=True 会自动使用 gzip 压缩响应（减少 60-70% 传输大小）
            app = web.Application(
                middlewares=[self._csp_middleware, self._auth_middleware]
            )

            app.router.add_get("/", self._handle_index)
            app.router.add_post("/api/login", self._handle_login)
            app.router.add_post("/api/logout", self._handle_logout)
            app.router.add_get("/api/health", self._handle_health)
            app.router.add_get("/api/summary", self._handle_summary)
            app.router.add_get("/api/system", self._handle_system)
            app.router.add_get("/api/astrbot", self._handle_astrbot)
            app.router.add_get("/api/logs", self._handle_logs)
            app.router.add_get("/api/logs/stream", self._handle_logs_stream)
            app.router.add_get("/api/config", self._handle_config)
            # 通用静态资源服务（支持模块化后的 CSS/JS 多文件）
            app.router.add_static("/", self.web_dir, name="static", show_index=False)

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
        # 静态资源(CSS/JS 等)默认走 aiohttp 启发式缓存,改动后浏览器可能仍用旧文件。
        # 统一要求重新校验,避免前端样式/脚本更新不生效。已显式设置缓存头的响应不覆盖。
        if "Cache-Control" not in response.headers:
            response.headers["Cache-Control"] = "no-cache"
        return response

    def _is_public_auth_path(self, request: web.Request) -> bool:
        """登录壳与登录/登出 API 在配置密码后仍需可访问。"""
        path = request.path or "/"
        method = (request.method or "GET").upper()
        if method == "POST" and path in {"/api/login", "/api/logout"}:
            return True
        # 非 API 的 GET：HTML/CSS/JS 等静态资源，供登录页加载
        if method in {"GET", "HEAD"} and not path.startswith("/api/"):
            return True
        return False

    def _token_matches(self, supplied: str, expected: str) -> bool:
        left = str(supplied or "")
        right = str(expected or "")
        if not right:
            return False
        try:
            return hmac.compare_digest(left, right)
        except (TypeError, ValueError):
            return False

    def _client_key(self, request: web.Request) -> str:
        return str(request.remote or "unknown")

    def _prune_auth_sessions(self) -> None:
        now = time.time()
        expired = [sid for sid, exp in self._auth_sessions.items() if exp <= now]
        for sid in expired:
            self._auth_sessions.pop(sid, None)

    def _create_auth_session(self) -> str:
        with self._session_lock:
            self._prune_auth_sessions()
            # 控制内存：超限时丢弃最早过期的一半
            if len(self._auth_sessions) > 5000:
                ordered = sorted(self._auth_sessions.items(), key=lambda item: item[1])
                for sid, _ in ordered[: len(ordered) // 2]:
                    self._auth_sessions.pop(sid, None)
            sid = secrets.token_urlsafe(SESSION_ID_BYTES)
            self._auth_sessions[sid] = time.time() + SESSION_TTL_SECONDS
            return sid

    def _revoke_auth_session(self, session_id: str) -> None:
        if not session_id:
            return
        with self._session_lock:
            self._auth_sessions.pop(session_id, None)

    def _session_valid(self, session_id: str) -> bool:
        if not session_id:
            return False
        with self._session_lock:
            exp = self._auth_sessions.get(session_id)
            if exp is None:
                return False
            if exp <= time.time():
                self._auth_sessions.pop(session_id, None)
                return False
            return True

    def _login_rate_limited(self, request: web.Request) -> bool:
        key = self._client_key(request)
        now = time.time()
        with self._session_lock:
            attempts = [t for t in self._login_failures.get(key, []) if now - t < LOGIN_RATE_WINDOW_SECONDS]
            self._login_failures[key] = attempts
            return len(attempts) >= LOGIN_RATE_MAX_ATTEMPTS

    def _record_login_failure(self, request: web.Request) -> None:
        key = self._client_key(request)
        now = time.time()
        with self._session_lock:
            attempts = [t for t in self._login_failures.get(key, []) if now - t < LOGIN_RATE_WINDOW_SECONDS]
            attempts.append(now)
            self._login_failures[key] = attempts

    def _clear_login_failures(self, request: web.Request) -> None:
        key = self._client_key(request)
        with self._session_lock:
            self._login_failures.pop(key, None)

    def _extract_bearer(self, request: web.Request) -> str:
        header = request.headers.get("Authorization", "")
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        return ""

    def _authenticate_request(self, request: web.Request, password: str) -> tuple[bool, bool]:
        """
        校验请求是否已认证。
        返回 (ok, should_issue_session)：
        - Cookie 有效 session → 通过
        - 旧 Cookie 存密码 / query token / Bearer 密码 → 通过并建议签发 session
        - 错误 query token 不会覆盖有效 Cookie（先 Cookie 再 Bearer 再 query）
        """
        cookie_val = request.cookies.get(AUTH_COOKIE_NAME, "") or ""
        if self._session_valid(cookie_val):
            return True, False
        if LEGACY_PASSWORD_COOKIE and cookie_val and self._token_matches(cookie_val, password):
            return True, True

        bearer = self._extract_bearer(request)
        if bearer:
            if self._session_valid(bearer):
                return True, False
            if self._token_matches(bearer, password):
                return True, True

        query_token = request.query.get("token", "") or ""
        if query_token and self._token_matches(query_token, password):
            return True, True

        return False, False

    @web.middleware
    async def _auth_middleware(self, request: web.Request, handler: Any) -> web.StreamResponse:
        token = self._cfg_str("access_token", "").strip()

        # 无密码配置时：本机/非全网卡放行；全网卡远程拒绝
        if not token:
            if self._host_all_interfaces() and not self._is_loopback_request(request):
                if request.path.startswith("/api/"):
                    return _json_response({"ok": False, "error": "远程访问需要配置访问密码"}, status=401)
                return web.Response(status=401, text="远程访问需要配置访问密码")
            return await handler(request)

        # 已配置密码：登录页与静态资源放行；其余 /api/* 需认证
        if self._is_public_auth_path(request):
            return await handler(request)

        ok, issue_session = self._authenticate_request(request, token)
        if not ok:
            if request.path.startswith("/api/"):
                return _json_response({"ok": False, "error": "未授权访问，请先登录"}, status=401)
            return web.Response(status=401, text="未授权访问，请先登录")

        response = await handler(request)
        # 旧密码 Cookie / query token / Bearer 密码：升级为随机 session
        if issue_session:
            session_id = self._create_auth_session()
            self._set_auth_cookie(response, session_id, request)
        return response

    async def _handle_index(self, request: web.Request) -> web.Response:
        response = await self._send_file(self.web_dir / "index.html", content_type="text/html")
        if response.status == 200:
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

    async def _send_file(self, path: Path, *, content_type: str) -> web.Response:
        try:
            text = await asyncio.to_thread(path.read_text, encoding="utf-8")
        except OSError:
            return web.Response(status=404, text="Not found")
        response = web.Response(text=text, content_type=content_type)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        response.enable_compression()
        return response

    def _cookie_secure_flag(self, request: web.Request) -> bool:
        # 仅信传输层 secure；不默认信 X-Forwarded-Proto，避免 HTTP 下误标 Secure
        return bool(request.secure)

    def _set_auth_cookie(self, response: Response, session_id: str, request: web.Request) -> None:
        secure = self._cookie_secure_flag(request)
        response.set_cookie(
            AUTH_COOKIE_NAME,
            session_id,
            httponly=True,
            samesite="Lax",
            secure=secure,
            path="/",
            max_age=SESSION_TTL_SECONDS,
        )

    def _clear_auth_cookie(self, response: Response, request: web.Request) -> None:
        secure = self._cookie_secure_flag(request)
        response.del_cookie(AUTH_COOKIE_NAME, path="/")
        # 兼容部分客户端：再写一条过期 Cookie
        response.set_cookie(
            AUTH_COOKIE_NAME,
            "",
            httponly=True,
            samesite="Lax",
            secure=secure,
            path="/",
            max_age=0,
        )

    async def _handle_login(self, request: web.Request) -> web.Response:
        token = self._cfg_str("access_token", "").strip()
        if not token:
            # 未配置密码：本机直接成功；远程全网卡仍拒绝
            if self._host_all_interfaces() and not self._is_loopback_request(request):
                return _json_response({"ok": False, "error": "远程访问需要配置访问密码"}, status=401)
            return _json_response({"ok": True, "data": {"auth_required": False}, "now": _now_ms()})

        if self._login_rate_limited(request):
            return _json_response(
                {"ok": False, "error": "登录尝试过于频繁，请稍后再试"},
                status=429,
            )

        try:
            body = await request.json()
        except (json.JSONDecodeError, TypeError):
            body = {}
        if not isinstance(body, dict):
            body = {}
        password = str(body.get("password") or body.get("token") or "").strip()
        if not self._token_matches(password, token):
            self._record_login_failure(request)
            return _json_response({"ok": False, "error": "密码错误"}, status=401)

        self._clear_login_failures(request)
        session_id = self._create_auth_session()
        response = _json_response({"ok": True, "data": {"auth_required": True}, "now": _now_ms()})
        self._set_auth_cookie(response, session_id, request)
        return response

    async def _handle_logout(self, request: web.Request) -> web.Response:
        cookie_val = request.cookies.get(AUTH_COOKIE_NAME, "") or ""
        self._revoke_auth_session(cookie_val)
        response = _json_response({"ok": True, "data": {"logged_out": True}, "now": _now_ms()})
        self._clear_auth_cookie(response, request)
        return response

    async def _handle_health(self, request: web.Request) -> web.Response:
        stream_on = self._log_stream_enabled
        return _json_response(
            {
                "ok": True,
                "plugin": PLUGIN_NAME,
                "version": PLUGIN_VERSION,
                "uptime_seconds": round(time.time() - self._started_at, 3),
                "log_mode": "stream" if stream_on else "file",
                "log_stream_available": True,
                "log_stream_enabled": stream_on,
                "log_broker_available": LOGBROKER_IMPORTABLE,
                "log_broker_enabled": self._log_broker_enabled,
                "cached_logs": len(self._log_broker_cache) if self._log_broker_enabled else 0,
                "now": _now_ms(),
            }
        )

    async def _handle_config(self, request: web.Request) -> web.Response:
        cfg = self._public_config()
        return _json_response({"ok": True, "data": cfg, "now": _now_ms()})

    async def _handle_summary(self, request: web.Request) -> web.Response:
        astrbot = await asyncio.to_thread(self._collect_astrbot)
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
        return _json_response({"ok": True, "data": await asyncio.to_thread(self._collect_astrbot), "now": _now_ms()})

    async def _handle_logs(self, request: web.Request) -> web.Response:
        source = request.query.get("source", "all")
        if source not in ALLOWED_LOG_SOURCES:
            return _json_response({"ok": False, "error": "无效的日志来源"}, status=400)

        cursor_str = request.query.get("cursor", "")
        if len(cursor_str) > 50000:
            return _json_response({"ok": False, "error": "游标参数过大"}, status=400)
        cursor = _parse_logs_cursor(cursor_str)
        data: dict[str, Any] = {}
        if source in {"all", "astrbot"}:
            # 始终返回文件形状 { astrbot: [...] }，禁止切换为 live 结构
            data["astrbot"] = await self._collect_astrbot_logs(cursor=cursor)
            data["source"] = "file"
            data["log_stream_enabled"] = self._log_stream_enabled
        return _json_response({"ok": True, "data": data, "now": _now_ms()})

    async def _handle_logs_stream(self, request: web.Request) -> web.StreamResponse:
        """SSE：推送与 /api/logs 同形状的 astrbot[] 增量。"""
        if not self._log_stream_cfg_bool("enabled", DEFAULT_LOG_STREAM["enabled"]):
            return _json_response({"ok": False, "error": "日志流已在配置中关闭"}, status=503)
        if not self._log_stream_enabled:
            return _json_response({"ok": False, "error": "日志流 hub 未运行"}, status=503)

        include_snapshot = str(request.query.get("snapshot", "0")).strip().lower() in {
            "1",
            "true",
            "yes",
        }
        response = web.StreamResponse()
        response.headers["Content-Type"] = "text/event-stream; charset=utf-8"
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Connection"] = "keep-alive"
        response.headers["X-Accel-Buffering"] = "no"
        await response.prepare(request)

        # 先订阅再 snapshot，避免 snapshot 与 subscribe 之间丢增量；
        # snapshot 用 replaceAll，后续 queue 增量可能与 tail 重叠，由前端 merge 消化。
        queue = self._subscribe_log_stream()
        try:
            hello = {
                "type": "hello",
                "data": {
                    "log_mode": "stream",
                    "log_stream_enabled": True,
                    "log_broker_enabled": self._log_broker_enabled,
                },
                "now": _now_ms(),
            }
            await response.write(self._sse_encode(hello))

            if include_snapshot:
                files = await self._collect_astrbot_logs(cursor=None)
                if self._log_broker_enabled:
                    broker_file = await self._log_broker_file_payload(reset=True, lines=None)
                    if broker_file is not None:
                        files = list(files) + [broker_file]
                snapshot = {
                    "type": "snapshot",
                    "data": {"astrbot": files, "source": "stream"},
                    "now": _now_ms(),
                }
                await response.write(self._sse_encode(snapshot))

            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    await response.write(b": heartbeat\n\n")
                    continue
                if event is None:
                    break
                await response.write(self._sse_encode(event))
        except (asyncio.CancelledError, ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass
        except Exception as exc:
            msg = str(exc).lower()
            if not any(k in msg for k in ("closing", "closed", "reset", "broken", "connection")):
                logger.warning("[ObserverPanel] SSE 流异常: %s", exc)
        finally:
            self._unsubscribe_log_stream(queue)
            try:
                await response.write_eof()
            except Exception:
                pass
        return response

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
            self._astrbot_cfg_int("tail_lines", 1200, 1, 5000),
            self._threshold_int("summary_log_lines", 180, 20, 1000),
        )
        max_bytes = min(
            self._astrbot_cfg_int("tail_bytes", 1572864, 4096, 8 * 1024 * 1024),
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

        if self._host_all_interfaces() and not self._cfg_str("access_token", "").strip():
            add("warn", "远程访问需要访问密码", "当前监听所有网卡且 access_token 为空，远程请求会被拒绝。请配置面板登录密码。", "security")
        elif not self._cfg_str("access_token", "").strip():
            add("info", "未配置访问密码", "当前仅依赖绑定地址保护面板，同机其他进程/用户仍可能访问。建议配置 access_token 作为登录密码。", "security")

        if not _is_linux() and not _psutil_available():
            add(
                "info",
                "系统指标能力有限",
                "当前非 Linux 环境且未安装 psutil，CPU/内存/网卡等主机指标可能为空。建议安装 psutil 后重启。",
                "system",
            )

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
        cpu_percent: float | None = None
        cpu_model = _read_cpu_model() or platform.processor()

        if _is_linux():
            cpu_now = _read_cpu_times()
            # _collect_system 通过 asyncio.to_thread 在线程池执行，/api/summary 与
            # /api/system 可能并发调用，需用锁保护 _last_cpu_times 的读改写，避免
            # 并发采样导致 delta≈0（CPU 显示 0%）或超界被 clamp 到 100%。
            with self._cpu_lock:
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
            memory = {
                "total": total_mem,
                "available": available_mem,
                "used": used_mem,
                "percent": round((used_mem / total_mem) * 100, 2) if total_mem else 0,
                "swap_total": swap_total,
                "swap_used": swap_used,
                "swap_percent": round((swap_used / swap_total) * 100, 2) if swap_total else 0,
            }

            boot_seconds = 0.0
            try:
                boot_seconds = float(Path("/proc/uptime").read_text(encoding="utf-8").split()[0])
            except (OSError, ValueError, IndexError):
                pass
            root_disk = _disk_usage(Path("/"))
        else:
            with self._cpu_lock:
                cpu_percent, self._last_cpu_percent_sample = _collect_cpu_percent_portable(
                    self._last_cpu_percent_sample
                )
            memory = _collect_memory_portable()
            boot_seconds = _collect_boot_seconds_portable()
            root_disk = _disk_usage(_system_drive_root())

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
                "model": cpu_model,
                "logical_count": os.cpu_count() or 0,
                "load_average": _load_average(),
                "percent": cpu_percent,
            },
            "memory": memory,
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
            "metrics_backend": "linux-proc" if _is_linux() else ("psutil" if _psutil_available() else "limited"),
        }
        if compact:
            system["network"] = {
                "interfaces": [
                    item for item in network.get("interfaces", [])
                    if not _is_loopback_iface(str(item.get("name") or ""), is_loopback=item.get("is_loopback"))
                    and (item.get("addresses") or item.get("state") == "up")
                ][:6]
            }
        return system

    def _collect_process_info(self, *, compact: bool = False) -> dict[str, Any]:
        if _is_linux():
            status = _read_proc_key_values(Path("/proc/self/status"))
            result = {
                "pid": os.getpid(),
                "ppid": os.getppid(),
                "rss": _kib_value(status.get("VmRSS")),
                "vms": _kib_value(status.get("VmSize")),
                "threads": _as_int(status.get("Threads"), 0),
                "max_rss": (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024) if resource else 0,
                "plugin_uptime_seconds": round(time.time() - self._started_at, 3),
            }
            if compact:
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
            result["cmdline"] = str(_redact(cmdline))
            result["cwd"] = cwd
            result["open_fds"] = fd_count
            return result

        result = _collect_process_info_portable(compact=compact)
        result["plugin_uptime_seconds"] = round(time.time() - self._started_at, 3)
        if resource:
            try:
                # Windows 上 ru_maxrss 单位是字节；Linux 是 KB。仅 Linux 路径用 *1024。
                # 非 Linux 若 resource 存在（罕见），保持原值。
                usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                result["max_rss"] = int(usage) if _is_windows() else int(usage) * 1024
            except Exception:
                result["max_rss"] = 0
        return result

    def _collect_network_info(self, *, compact: bool = False) -> dict[str, Any]:
        if not _is_linux():
            return _collect_network_info_portable(compact=compact)
        counters = _network_counters()
        addresses = _interface_addresses()
        interfaces: list[dict[str, Any]] = []
        for path in sorted(Path("/sys/class/net").glob("*")):
            name = path.name
            item = {
                "name": name,
                "state": _read_text_sync(path / "operstate") or "unknown",
                "addresses": addresses.get(name, []),
                "is_loopback": _is_loopback_iface(name),
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
        return {"interfaces": interfaces, "source": "linux-sysfs"}

    async def _collect_astrbot_logs(self, *, cursor: dict[str, dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        max_lines = self._astrbot_cfg_int("tail_lines", 1200, 1, 5000)
        max_bytes = self._astrbot_cfg_int("tail_bytes", 1572864, 4096, 8 * 1024 * 1024)
        redact = self._security_cfg_bool("redact_secrets", True)
        privacy = self._ui_cfg_bool("privacy_mode", DEFAULT_UI["privacy_mode"])
        paths = self._astrbot_log_paths()
        if cursor:
            tasks = [
                asyncio.to_thread(
                    _tail_file_incremental_sync,
                    path,
                    max_bytes=max_bytes,
                    max_lines=max_lines,
                    redact=redact,
                    cursor=cursor.get(str(path)) or cursor.get(_normalize_path_key(path)),
                )
                for path in paths
            ]
        else:
            tasks = [
                self._tail_log_file_cached(path, max_bytes=max_bytes, max_lines=max_lines, redact=redact)
                for path in paths
            ]
        results = await asyncio.gather(*tasks) if tasks else []
        if privacy:
            return [_apply_privacy_to_log_payload(item, privacy=True) for item in results]
        return list(results)

    def _resolve_logs_dir(self, configured: str) -> Path:
        """
        解析 logs_dir：
        绝对路径直接用；相对路径按候选存在性选择，兼容 Windows 不同启动 CWD。
        """
        raw = Path(str(configured or "data/logs")).expanduser()
        if raw.is_absolute():
            return raw

        candidates = [
            Path.cwd() / raw,
            self.data_dir.parent / raw,
            self.data_dir / "logs",
            raw,
        ]
        for candidate in candidates:
            try:
                if candidate.exists() and candidate.is_dir():
                    return candidate
            except OSError:
                continue
        # 都不存在时优先 data_dir 父级（AstrBot 常见 data/logs）
        return self.data_dir.parent / raw

    def _astrbot_log_paths(self) -> list[Path]:
        logs_dir = self._resolve_logs_dir(self._astrbot_cfg_str("logs_dir", "data/logs"))
        try:
            logs_root = logs_dir.resolve()
        except OSError:
            logs_root = logs_dir
        files = _as_list(self._astrbot_cfg("log_files", DEFAULT_ASTRBOT_LOG_FILES), DEFAULT_ASTRBOT_LOG_FILES)
        paths: list[Path] = []
        for item in files:
            raw = str(item or "").strip()
            if not raw:
                continue
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = logs_dir / path
            # 沙箱：仅允许 logs_dir 内文件，拒绝 .. 与目录外绝对路径
            if not _path_is_within(path, logs_root):
                logger.warning("[ObserverPanel] 拒绝越界日志路径: %s (root=%s)", path, logs_root)
                continue
            try:
                paths.append(path.resolve())
            except OSError:
                paths.append(path)
        return paths

    def _public_config(self) -> dict[str, Any]:
        return _redact(
            {
                "enabled": self._cfg_bool("enabled", True),
                "host": self._cfg_str("host", "127.0.0.1"),
                "port": self._cfg_int("port", 7199, 1, 65535),
                "has_access_token": bool(self._cfg_str("access_token", "")),
                "refresh_interval_seconds": self._cfg_int("refresh_interval_seconds", 5, 2, 120),
                "log_stream_enabled": self._log_stream_enabled,
                "log_stream_available": True,
                "log_mode": "stream" if self._log_stream_enabled else "file",
                "log_broker_available": LOGBROKER_IMPORTABLE,
                "log_broker_enabled": self._log_broker_enabled,
                "log_stream": {
                    "enabled": self._log_stream_cfg_bool("enabled", DEFAULT_LOG_STREAM["enabled"]),
                    "interval_ms": self._log_stream_cfg_int(
                        "interval_ms", DEFAULT_LOG_STREAM["interval_ms"], 200, 5000
                    ),
                    "prefer_logbroker": self._log_stream_cfg_bool(
                        "prefer_logbroker", DEFAULT_LOG_STREAM["prefer_logbroker"]
                    ),
                },
                "astrbot": {
                    "logs_dir": self._astrbot_cfg_str("logs_dir", "data/logs"),
                    "log_files": _as_list(self._astrbot_cfg("log_files", DEFAULT_ASTRBOT_LOG_FILES), DEFAULT_ASTRBOT_LOG_FILES),
                    "tail_lines": self._astrbot_cfg_int("tail_lines", 1200, 1, 5000),
                    "tail_bytes": self._astrbot_cfg_int("tail_bytes", 1572864, 4096, 8 * 1024 * 1024),
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

    def _log_stream_cfg(self, key: str, default: Any = None) -> Any:
        return self._section_cfg("log_stream", key, default)

    def _log_stream_cfg_bool(self, key: str, default: bool = False) -> bool:
        return _as_bool(self._log_stream_cfg(key, default), default)

    def _log_stream_cfg_int(self, key: str, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
        return _as_int(self._log_stream_cfg(key, default), default, min_value, max_value)

    # ==================== File-SSE hub + 可选 LogBroker ====================

    @staticmethod
    def _sse_encode(payload: dict[str, Any]) -> bytes:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")

    def _subscribe_log_stream(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=SSE_SUBSCRIBER_QUEUE_SIZE)
        self._log_subscribers.append(queue)
        return queue

    def _unsubscribe_log_stream(self, queue: asyncio.Queue) -> None:
        if queue in self._log_subscribers:
            self._log_subscribers.remove(queue)

    def _publish_log_stream_event(self, event: dict[str, Any]) -> None:
        dead: list[asyncio.Queue] = []
        for subscriber in list(self._log_subscribers):
            try:
                subscriber.put_nowait(event)
            except asyncio.QueueFull:
                # 丢弃最旧再试一次，避免慢客户端拖死 hub
                try:
                    subscriber.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    subscriber.put_nowait(event)
                except asyncio.QueueFull:
                    logger.debug("[ObserverPanel] SSE 订阅队列仍满，丢弃事件")
            except Exception:
                dead.append(subscriber)
        for queue in dead:
            self._unsubscribe_log_stream(queue)

    async def _start_log_stream_hub(self) -> None:
        if not self._log_stream_cfg_bool("enabled", DEFAULT_LOG_STREAM["enabled"]):
            self._log_stream_enabled = False
            logger.info("[ObserverPanel] 日志流已在配置中关闭，使用文件轮询")
            return
        if self._log_stream_task is not None and not self._log_stream_task.done():
            self._log_stream_enabled = True
            return

        self._file_stream_cursors.clear()
        if self._log_stream_cfg_bool("prefer_logbroker", DEFAULT_LOG_STREAM["prefer_logbroker"]):
            await self._try_init_log_broker()

        self._log_stream_task = asyncio.create_task(self._log_stream_hub_loop())
        self._log_stream_enabled = True
        logger.info(
            "[ObserverPanel] 日志流 hub 已启动 (file-sse%s)",
            ", logbroker" if self._log_broker_enabled else "",
        )

    async def _stop_log_stream_hub(self) -> None:
        self._log_stream_enabled = False
        for subscriber in list(self._log_subscribers):
            try:
                subscriber.put_nowait(None)
            except Exception:
                pass
        self._log_subscribers.clear()

        if self._log_stream_task is not None:
            self._log_stream_task.cancel()
            try:
                await self._log_stream_task
            except asyncio.CancelledError:
                pass
            self._log_stream_task = None

        await self._cleanup_log_broker()
        self._file_stream_cursors.clear()

    async def _log_stream_hub_loop(self) -> None:
        interval_ms = self._log_stream_cfg_int(
            "interval_ms", DEFAULT_LOG_STREAM["interval_ms"], 200, 5000
        )
        interval = interval_ms / 1000.0
        try:
            while True:
                try:
                    await self._log_stream_tick()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("[ObserverPanel] 日志流 tick 失败: %s", exc, exc_info=True)
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            logger.debug("[ObserverPanel] 日志流 hub 已停止")

    async def _log_stream_tick(self) -> None:
        if not self._log_subscribers:
            # 无订阅者时仍推进 cursor，避免重连时洪水；但不打包推送
            await self._collect_stream_delta(update_cursors=True, force_publish=False)
            return
        files = await self._collect_stream_delta(update_cursors=True, force_publish=True)
        if not files:
            return
        self._publish_log_stream_event(
            {
                "type": "logs",
                "data": {"astrbot": files, "source": "stream"},
                "now": _now_ms(),
            }
        )

    async def _collect_stream_delta(
        self,
        *,
        update_cursors: bool,
        force_publish: bool,
    ) -> list[dict[str, Any]]:
        max_lines = self._astrbot_cfg_int("tail_lines", 1200, 1, 5000)
        max_bytes = self._astrbot_cfg_int("tail_bytes", 1572864, 4096, 8 * 1024 * 1024)
        redact = self._security_cfg_bool("redact_secrets", True)
        privacy = self._ui_cfg_bool("privacy_mode", DEFAULT_UI["privacy_mode"])
        paths = self._astrbot_log_paths()
        changed: list[dict[str, Any]] = []

        for path in paths:
            key = str(path)
            cursor = self._file_stream_cursors.get(key)
            data = await asyncio.to_thread(
                _tail_file_incremental_sync,
                path,
                max_bytes=max_bytes,
                max_lines=max_lines,
                redact=redact,
                cursor=cursor,
            )
            if update_cursors:
                cursor_payload = data.get("cursor") or _log_cursor_payload(data)
                self._file_stream_cursors[key] = dict(cursor_payload)
            if data.get("unchanged") and not data.get("reset"):
                continue
            if privacy:
                data = _apply_privacy_to_log_payload(data, privacy=True)
            if force_publish:
                changed.append(data)

        if self._log_broker_enabled and force_publish:
            broker_delta = await self._drain_log_broker_delta(privacy=privacy)
            if broker_delta is not None:
                changed.append(broker_delta)

        return changed

    def _format_log_broker_entry(self, entry: Any) -> str:
        if entry is None:
            return ""
        if isinstance(entry, str):
            return entry
        if isinstance(entry, dict):
            for key in ("message", "msg", "text", "line", "raw"):
                value = entry.get(key)
                if value is not None and str(value).strip():
                    level = str(entry.get("level") or entry.get("lvl") or "").strip()
                    ts = entry.get("time") or entry.get("timestamp") or entry.get("ts")
                    parts: list[str] = []
                    if ts is not None:
                        try:
                            ts_f = float(ts)
                            if ts_f > 1e12:
                                ts_f = ts_f / 1000.0
                            parts.append(time.strftime("[%Y-%m-%d %H:%M:%S]", time.localtime(ts_f)))
                        except (TypeError, ValueError, OSError):
                            parts.append(f"[{ts}]")
                    if level:
                        parts.append(f"[{level.upper()}]")
                    parts.append(str(value))
                    return " ".join(parts)
            try:
                return json.dumps(entry, ensure_ascii=False)
            except (TypeError, ValueError):
                return str(entry)
        return str(entry)

    async def _log_broker_file_payload(
        self,
        *,
        reset: bool,
        lines: list[str] | None,
    ) -> dict[str, Any] | None:
        redact = self._security_cfg_bool("redact_secrets", True)
        privacy = self._ui_cfg_bool("privacy_mode", DEFAULT_UI["privacy_mode"])
        async with self._log_broker_lock:
            if lines is None:
                # snapshot：导出缓存尾部
                raw_lines = [self._format_log_broker_entry(item) for item in list(self._log_broker_cache)]
                raw_lines = [line for line in raw_lines if line]
                if not raw_lines and not self._log_broker_enabled:
                    return None
                base_line = max(0, self._log_broker_line_count - len(raw_lines))
                line_count = self._log_broker_line_count
            else:
                raw_lines = list(lines)
                if not raw_lines and not reset:
                    return None
                base_line = self._log_broker_base_line
                line_count = self._log_broker_line_count

        if redact:
            raw_lines = [str(_redact(line)) for line in raw_lines]
        data = {
            "path": LOGBROKER_VIRTUAL_PATH,
            "exists": True,
            "readable": True,
            "size": line_count,
            "mtime": time.time(),
            "lines": raw_lines,
            "truncated": False,
            "line_count": line_count,
            "base_line": base_line,
            "ends_with_newline": True,
            "reset": reset,
            "virtual": True,
            "source": "logbroker",
        }
        data["cursor"] = _log_cursor_payload(data)
        if privacy:
            data = _apply_privacy_to_log_payload(data, privacy=True)
        return data

    async def _drain_log_broker_delta(self, *, privacy: bool) -> dict[str, Any] | None:
        async with self._log_broker_lock:
            if not self._log_broker_pending_lines:
                return None
            lines = list(self._log_broker_pending_lines)
            self._log_broker_pending_lines.clear()
            base_line = self._log_broker_base_line
            line_count = self._log_broker_line_count
            # 增量后 base 仍指向窗口起点（前端 merge 会按 tail 截断）
            self._log_broker_base_line = base_line

        redact = self._security_cfg_bool("redact_secrets", True)
        if redact:
            lines = [str(_redact(line)) for line in lines]
        data = {
            "path": LOGBROKER_VIRTUAL_PATH,
            "exists": True,
            "readable": True,
            "size": line_count,
            "mtime": time.time(),
            "lines": lines,
            "truncated": False,
            "line_count": line_count,
            "base_line": base_line,
            "ends_with_newline": True,
            "reset": False,
            "virtual": True,
            "source": "logbroker",
        }
        data["cursor"] = _log_cursor_payload(data)
        if privacy:
            data = _apply_privacy_to_log_payload(data, privacy=True)
        return data

    async def _try_init_log_broker(self) -> None:
        if not LOGBROKER_IMPORTABLE:
            return
        strategies = [
            self._try_log_broker_from_context,
            self._try_log_broker_from_managers,
            self._try_log_broker_from_logger,
            self._try_log_broker_from_modules,
        ]
        for strategy in strategies:
            try:
                broker = strategy()
                if broker is not None and hasattr(broker, "register"):
                    await self._activate_log_broker(broker)
                    return
            except Exception as exc:
                logger.debug("[ObserverPanel] LogBroker 策略 %s 失败: %s", strategy.__name__, exc)
        logger.debug("[ObserverPanel] 未找到 LogBroker，仅使用文件 SSE")

    def _try_log_broker_from_context(self) -> Any | None:
        for attr_name in ("_core_lifecycle", "core_lifecycle", "_core", "core", "_internal"):
            core = getattr(self.context, attr_name, None)
            if core is not None and hasattr(core, "log_broker"):
                return getattr(core, "log_broker", None)
        return None

    def _try_log_broker_from_managers(self) -> Any | None:
        manager_attrs = (
            "provider_manager",
            "platform_manager",
            "conversation_manager",
            "astrbot_config_mgr",
            "kb_manager",
            "cron_manager",
            "subagent_orchestrator",
        )
        for manager_attr in manager_attrs:
            manager = getattr(self.context, manager_attr, None)
            if manager is None:
                continue
            for core_attr in ("_core_lifecycle", "core_lifecycle", "_core", "core"):
                core = getattr(manager, core_attr, None)
                if core is not None and hasattr(core, "log_broker"):
                    return getattr(core, "log_broker", None)
        return None

    def _try_log_broker_from_logger(self) -> Any | None:
        try:
            from astrbot.api import logger as astrbot_logger
        except Exception:
            return None
        handlers = getattr(astrbot_logger, "handlers", None) or []
        for handler in handlers:
            if hasattr(handler, "log_broker"):
                return getattr(handler, "log_broker", None)
        return None

    def _try_log_broker_from_modules(self) -> Any | None:
        for module_name in ("astrbot.core", "astrbot.core.log", "astrbot.core.lifecycle"):
            module = sys.modules.get(module_name)
            if module is None:
                continue
            for attr_name in ("log_broker", "LogBroker", "_log_broker"):
                obj = getattr(module, attr_name, None)
                if obj is not None and hasattr(obj, "register"):
                    return obj
        return None

    async def _activate_log_broker(self, log_broker: Any) -> None:
        self._log_broker = log_broker
        self._log_broker_queue = log_broker.register()
        self._log_broker_enabled = True
        if hasattr(log_broker, "log_cache"):
            try:
                cached = list(log_broker.log_cache)
            except Exception:
                cached = []
            async with self._log_broker_lock:
                self._log_broker_cache.clear()
                for item in cached:
                    self._log_broker_cache.append(item)
                    self._log_broker_line_count += 1
                self._log_broker_base_line = max(0, self._log_broker_line_count - len(self._log_broker_cache))
            logger.info("[ObserverPanel] LogBroker 历史缓存 %s 条", len(cached))
        self._log_broker_task = asyncio.create_task(self._process_log_broker_stream())
        logger.info("[ObserverPanel] LogBroker fan-in 已启用")

    async def _process_log_broker_stream(self) -> None:
        if self._log_broker_queue is None:
            return
        try:
            while True:
                entry = await self._log_broker_queue.get()
                line = self._format_log_broker_entry(entry)
                if not line:
                    continue
                async with self._log_broker_lock:
                    self._log_broker_cache.append(entry if not isinstance(entry, str) else {"message": entry})
                    self._log_broker_pending_lines.append(line)
                    self._log_broker_line_count += 1
                    # 控制 base：缓存窗口滑动
                    if len(self._log_broker_cache) >= LOGBROKER_CACHE_MAX:
                        self._log_broker_base_line = max(
                            0, self._log_broker_line_count - LOGBROKER_CACHE_MAX
                        )
        except asyncio.CancelledError:
            logger.debug("[ObserverPanel] LogBroker 消费任务已取消")
        except Exception as exc:
            logger.warning("[ObserverPanel] LogBroker 消费错误: %s", exc, exc_info=True)
            self._log_broker_enabled = False

    async def _cleanup_log_broker(self) -> None:
        if self._log_broker_task is not None:
            self._log_broker_task.cancel()
            try:
                await self._log_broker_task
            except asyncio.CancelledError:
                pass
            self._log_broker_task = None

        if self._log_broker is not None and self._log_broker_queue is not None:
            try:
                self._log_broker.unregister(self._log_broker_queue)
            except Exception as exc:
                logger.debug("[ObserverPanel] 注销 LogBroker 失败: %s", exc)
        self._log_broker = None
        self._log_broker_queue = None
        self._log_broker_enabled = False
        async with self._log_broker_lock:
            self._log_broker_cache.clear()
            self._log_broker_pending_lines.clear()
            self._log_broker_line_count = 0
            self._log_broker_base_line = 0
