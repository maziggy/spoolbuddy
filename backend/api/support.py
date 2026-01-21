"""
Support API for system diagnostics and troubleshooting.

Provides endpoints for:
- Debug logging toggle
- Log retrieval and clearing
- Support bundle generation
- System information
"""

import io
import logging
import platform
import re
import time
import zipfile
from datetime import datetime
from pathlib import Path

import psutil
from config import APP_VERSION, settings
from db import get_db
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/support", tags=["support"])

# Application start time for uptime calculation
_start_time = time.time()

# Log file path
LOG_FILE = Path("spoolbuddy.log")


# ============ Models ============


class DebugLoggingState(BaseModel):
    """Debug logging state."""

    enabled: bool
    enabled_at: str | None = None
    duration_seconds: int | None = None


class DebugLoggingToggle(BaseModel):
    """Request to toggle debug logging."""

    enabled: bool


class LogEntry(BaseModel):
    """Single log entry."""

    timestamp: str
    level: str
    logger_name: str
    message: str


class LogsResponse(BaseModel):
    """Response containing log entries."""

    entries: list[LogEntry]
    total_count: int
    filtered_count: int


class SystemInfo(BaseModel):
    """System information response."""

    # Application
    version: str
    uptime: str
    uptime_seconds: int
    hostname: str

    # Database stats
    spool_count: int
    printer_count: int
    connected_printers: int

    # Storage
    database_size: str
    disk_total: str
    disk_used: str
    disk_free: str
    disk_percent: float

    # System
    platform: str
    platform_release: str
    python_version: str
    boot_time: str

    # Memory
    memory_total: str
    memory_used: str
    memory_available: str
    memory_percent: float

    # CPU
    cpu_count: int
    cpu_percent: float


# ============ Helper Functions ============


def _format_bytes(size: int) -> str:
    """Format bytes to human readable string."""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(size) < 1024.0:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} PB"


def _format_uptime(seconds: float) -> str:
    """Format seconds to human readable uptime."""
    days = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    minutes = int((seconds % 3600) // 60)

    parts = []
    if days > 0:
        parts.append(f"{days}d")
    if hours > 0:
        parts.append(f"{hours}h")
    if minutes > 0 or not parts:
        parts.append(f"{minutes}m")

    return " ".join(parts)


def _get_debug_setting() -> tuple[bool, str | None]:
    """Get debug logging state from database (synchronous for startup)."""
    import sqlite3

    db_path = settings.database_path
    if not db_path.exists():
        return False, None

    try:
        conn = sqlite3.connect(str(db_path))
        cursor = conn.execute("SELECT value FROM settings WHERE key = 'debug_logging_enabled'")
        row = cursor.fetchone()
        enabled = row[0] == "1" if row else False

        cursor = conn.execute("SELECT value FROM settings WHERE key = 'debug_logging_timestamp'")
        row = cursor.fetchone()
        timestamp = row[0] if row else None

        conn.close()
        return enabled, timestamp
    except Exception:
        return False, None


async def _set_debug_setting(enabled: bool) -> str:
    """Set debug logging state in database."""
    db = await get_db()
    timestamp = datetime.now().isoformat() if enabled else None

    await db.set_setting("debug_logging_enabled", "1" if enabled else "0")
    if timestamp:
        await db.set_setting("debug_logging_timestamp", timestamp)
    else:
        await db.delete_setting("debug_logging_timestamp")

    return timestamp


def _apply_log_level(level: int):
    """Apply log level to all handlers."""
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    for handler in root_logger.handlers:
        handler.setLevel(level)

    # Also set specific loggers
    for name in ["uvicorn", "uvicorn.access", "uvicorn.error", "fastapi"]:
        log = logging.getLogger(name)
        log.setLevel(level)


# Log parsing regex
_LOG_PATTERN = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+"  # timestamp
    r"(\w+)\s+"  # level
    r"\[([^\]]+)\]\s+"  # logger name
    r"(.*)$",  # message
    re.MULTILINE,
)


def _parse_log_line(line: str) -> LogEntry | None:
    """Parse a single log line."""
    match = _LOG_PATTERN.match(line)
    if match:
        return LogEntry(
            timestamp=match.group(1),
            level=match.group(2),
            logger_name=match.group(3),
            message=match.group(4),
        )
    return None


def _read_log_entries(
    limit: int = 200,
    level: str | None = None,
    search: str | None = None,
) -> tuple[list[LogEntry], int, int]:
    """Read and parse log entries from log file."""
    if not LOG_FILE.exists():
        return [], 0, 0

    entries = []
    total_count = 0
    current_entry: LogEntry | None = None

    try:
        with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue

                parsed = _parse_log_line(line)
                if parsed:
                    # Save previous entry
                    if current_entry:
                        total_count += 1
                        # Apply filters
                        if (
                            level
                            and current_entry.level != level
                            or search
                            and search.lower()
                            not in (current_entry.message.lower() + current_entry.logger_name.lower())
                        ):
                            pass
                        else:
                            entries.append(current_entry)
                    current_entry = parsed
                elif current_entry:
                    # Continuation of previous entry (multi-line)
                    current_entry.message += "\n" + line

            # Don't forget last entry
            if current_entry:
                total_count += 1
                if (
                    level
                    and current_entry.level != level
                    or search
                    and search.lower() not in (current_entry.message.lower() + current_entry.logger_name.lower())
                ):
                    pass
                else:
                    entries.append(current_entry)

    except Exception as e:
        logger.error(f"Error reading log file: {e}")
        return [], 0, 0

    # Return newest first, limited
    entries.reverse()
    filtered_count = len(entries)
    return entries[:limit], total_count, filtered_count


def _sanitize_log_content(content: str) -> str:
    """Sanitize sensitive data from log content."""
    # IP addresses (IPv4)
    content = re.sub(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "[IP]", content)
    # Email addresses
    content = re.sub(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", "[EMAIL]", content)
    # Access codes (8 digit codes commonly used by Bambu printers)
    content = re.sub(r"\b\d{8}\b", "[CODE]", content)
    # Serial numbers (15+ character alphanumeric, common for printers)
    content = re.sub(r"\b[A-Z0-9]{15,}\b", "[SERIAL]", content)
    # Long hex strings that might be tokens (32+ chars)
    content = re.sub(r"\b[a-fA-F0-9]{32,}\b", "[TOKEN]", content)
    # Paths with usernames
    content = re.sub(r"/home/[^/\s]+/", "/home/[user]/", content)
    content = re.sub(r"/Users/[^/\s]+/", "/Users/[user]/", content)
    content = re.sub(r"/opt/[^/\s]+/", "/opt/[user]/", content)
    # Windows paths with usernames
    content = re.sub(r"C:\\Users\\[^\\]+\\", "C:\\Users\\[user]\\", content)
    return content


async def _collect_support_info() -> dict:
    """Collect non-sensitive system information for support bundle."""
    db = await get_db()

    # Get counts
    spools = await db.get_spools()
    printers = await db.get_printers()

    # Get system info
    disk = psutil.disk_usage("/")
    memory = psutil.virtual_memory()

    return {
        "collected_at": datetime.now().isoformat(),
        "application": {
            "version": APP_VERSION,
            "uptime_seconds": int(time.time() - _start_time),
        },
        "database": {
            "spool_count": len(spools),
            "printer_count": len(printers),
            # Don't include printer names/serials
            "printer_models": [p.model for p in printers if p.model],
        },
        "system": {
            "platform": platform.system(),
            "platform_release": platform.release(),
            "python_version": platform.python_version(),
            "cpu_count": psutil.cpu_count(),
        },
        "resources": {
            "memory_total_mb": memory.total // (1024 * 1024),
            "memory_percent": memory.percent,
            "disk_total_gb": disk.total // (1024 * 1024 * 1024),
            "disk_percent": disk.percent,
        },
    }


def init_debug_logging():
    """Initialize debug logging state on startup."""
    enabled, _ = _get_debug_setting()
    if enabled:
        _apply_log_level(logging.DEBUG)
        logger.info("Debug logging restored from previous session")


# ============ Endpoints ============


@router.get("/debug-logging", response_model=DebugLoggingState)
async def get_debug_logging_state():
    """Get current debug logging state."""
    enabled, timestamp = _get_debug_setting()

    duration = None
    if enabled and timestamp:
        try:
            enabled_time = datetime.fromisoformat(timestamp)
            duration = int((datetime.now() - enabled_time).total_seconds())
        except Exception:
            pass

    return DebugLoggingState(
        enabled=enabled,
        enabled_at=timestamp,
        duration_seconds=duration,
    )


@router.post("/debug-logging", response_model=DebugLoggingState)
async def set_debug_logging(request: DebugLoggingToggle):
    """Enable or disable debug logging."""
    timestamp = await _set_debug_setting(request.enabled)

    if request.enabled:
        _apply_log_level(logging.DEBUG)
        logger.info("Debug logging enabled")
    else:
        _apply_log_level(logging.INFO)
        logger.info("Debug logging disabled")

    duration = None
    if request.enabled and timestamp:
        duration = 0  # Just enabled

    return DebugLoggingState(
        enabled=request.enabled,
        enabled_at=timestamp,
        duration_seconds=duration,
    )


@router.get("/logs", response_model=LogsResponse)
async def get_logs(
    limit: int = Query(default=200, ge=1, le=1000),
    level: str | None = Query(default=None, regex="^(DEBUG|INFO|WARNING|ERROR)$"),
    search: str | None = Query(default=None, min_length=1),
):
    """Get application logs."""
    entries, total_count, filtered_count = _read_log_entries(
        limit=limit,
        level=level,
        search=search,
    )

    return LogsResponse(
        entries=entries,
        total_count=total_count,
        filtered_count=filtered_count,
    )


@router.delete("/logs")
async def clear_logs():
    """Clear the log file."""
    try:
        if LOG_FILE.exists():
            with open(LOG_FILE, "w") as f:
                f.truncate(0)
            logger.info("Log file cleared")
        return {"message": "Logs cleared"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear logs: {e}")


@router.get("/bundle")
async def download_support_bundle():
    """Generate and download a support bundle.

    Requires debug logging to be enabled.
    """
    enabled, _ = _get_debug_setting()
    if not enabled:
        raise HTTPException(
            status_code=400,
            detail="Debug logging must be enabled to generate support bundle",
        )

    # Collect support info
    support_info = await _collect_support_info()

    # Create ZIP in memory
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # Add support info JSON
        import json

        zf.writestr("support-info.json", json.dumps(support_info, indent=2))

        # Add sanitized logs (last 10MB max)
        if LOG_FILE.exists():
            try:
                file_size = LOG_FILE.stat().st_size
                max_size = 10 * 1024 * 1024  # 10MB

                with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
                    if file_size > max_size:
                        f.seek(file_size - max_size)
                        f.readline()  # Skip partial line
                    log_content = f.read()

                sanitized_logs = _sanitize_log_content(log_content)
                zf.writestr("spoolbuddy.log", sanitized_logs)
            except Exception as e:
                zf.writestr("log_error.txt", f"Failed to read logs: {e}")

    buffer.seek(0)

    # Generate filename with timestamp
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"spoolbuddy-support-{timestamp}.zip"

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/system-info", response_model=SystemInfo)
async def get_system_info():
    """Get system information."""
    db = await get_db()

    # Get counts
    spools = await db.get_spools()
    printers = await db.get_printers()

    # Count connected printers
    from api.printers import _printer_manager

    connected_count = 0
    if _printer_manager:
        for printer in printers:
            if _printer_manager.is_connected(printer.serial):
                connected_count += 1

    # Get system stats
    disk = psutil.disk_usage("/")
    memory = psutil.virtual_memory()
    boot_time = datetime.fromtimestamp(psutil.boot_time())

    # Database size
    db_size = 0
    if settings.database_path.exists():
        db_size = settings.database_path.stat().st_size

    uptime_seconds = int(time.time() - _start_time)

    return SystemInfo(
        # Application
        version=APP_VERSION,
        uptime=_format_uptime(uptime_seconds),
        uptime_seconds=uptime_seconds,
        hostname=platform.node(),
        # Database stats
        spool_count=len(spools),
        printer_count=len(printers),
        connected_printers=connected_count,
        # Storage
        database_size=_format_bytes(db_size),
        disk_total=_format_bytes(disk.total),
        disk_used=_format_bytes(disk.used),
        disk_free=_format_bytes(disk.free),
        disk_percent=disk.percent,
        # System
        platform=platform.system(),
        platform_release=platform.release(),
        python_version=platform.python_version(),
        boot_time=boot_time.strftime("%Y-%m-%d %H:%M:%S"),
        # Memory
        memory_total=_format_bytes(memory.total),
        memory_used=_format_bytes(memory.used),
        memory_available=_format_bytes(memory.available),
        memory_percent=memory.percent,
        # CPU
        cpu_count=psutil.cpu_count() or 1,
        cpu_percent=psutil.cpu_percent(interval=0.1),
    )
