"""ESP32 Device Connection API.

Handles device discovery, connection management, and emergency recovery.
"""

import asyncio
import logging
import socket
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/device", tags=["device"])


class DeviceInfo(BaseModel):
    """Information about a discovered or connected device."""
    ip: str
    hostname: Optional[str] = None
    mac_address: Optional[str] = None
    firmware_version: Optional[str] = None
    nfc_status: Optional[bool] = None
    scale_status: Optional[bool] = None
    uptime: Optional[int] = None  # seconds
    last_seen: Optional[str] = None


class DeviceConfig(BaseModel):
    """Device configuration."""
    ip: str
    port: int = 80
    name: Optional[str] = None


class ConnectionStatus(BaseModel):
    """Current device connection status."""
    connected: bool
    device: Optional[DeviceInfo] = None
    last_error: Optional[str] = None
    reconnect_attempts: int = 0


class DiscoveryResult(BaseModel):
    """Result of device discovery."""
    devices: List[DeviceInfo]
    scan_duration_ms: int


# Global state for device connection
_connected_device: Optional[DeviceInfo] = None
_device_config: Optional[DeviceConfig] = None
_last_error: Optional[str] = None
_reconnect_attempts: int = 0


@router.get("/status", response_model=ConnectionStatus)
async def get_connection_status():
    """Get current device connection status."""
    return ConnectionStatus(
        connected=_connected_device is not None,
        device=_connected_device,
        last_error=_last_error,
        reconnect_attempts=_reconnect_attempts,
    )


@router.get("/config", response_model=Optional[DeviceConfig])
async def get_device_config():
    """Get saved device configuration."""
    return _device_config


@router.post("/config", response_model=DeviceConfig)
async def save_device_config(config: DeviceConfig):
    """Save device configuration."""
    global _device_config
    _device_config = config
    logger.info(f"Saved device config: {config.ip}:{config.port}")
    return config


@router.post("/connect", response_model=ConnectionStatus)
async def connect_device(config: Optional[DeviceConfig] = None):
    """Connect to an ESP32 device.

    Args:
        config: Device configuration. Uses saved config if not provided.
    """
    global _connected_device, _device_config, _last_error, _reconnect_attempts

    if config:
        _device_config = config

    if not _device_config:
        raise HTTPException(status_code=400, detail="No device configuration. Provide IP address.")

    try:
        # Try to connect to device
        device_info = await _probe_device(_device_config.ip, _device_config.port)

        if device_info:
            _connected_device = device_info
            _last_error = None
            _reconnect_attempts = 0
            logger.info(f"Connected to device at {_device_config.ip}")
        else:
            _last_error = f"Device at {_device_config.ip} not responding"
            _reconnect_attempts += 1

    except Exception as e:
        _last_error = str(e)
        _reconnect_attempts += 1
        logger.error(f"Failed to connect to device: {e}")

    return ConnectionStatus(
        connected=_connected_device is not None,
        device=_connected_device,
        last_error=_last_error,
        reconnect_attempts=_reconnect_attempts,
    )


@router.post("/disconnect")
async def disconnect_device():
    """Disconnect from the current device."""
    global _connected_device, _last_error, _reconnect_attempts

    _connected_device = None
    _last_error = None
    _reconnect_attempts = 0

    return {"success": True, "message": "Disconnected"}


@router.post("/discover", response_model=DiscoveryResult)
async def discover_devices(timeout_ms: int = 3000):
    """Discover SpoolBuddy devices on the local network.

    Uses mDNS/DNS-SD to find devices advertising _spoolbuddy._tcp.
    Falls back to subnet scan if mDNS fails.

    Args:
        timeout_ms: Discovery timeout in milliseconds
    """
    start_time = datetime.now()
    devices: List[DeviceInfo] = []

    # Try mDNS discovery first
    try:
        mdns_devices = await _discover_mdns(timeout_ms / 1000)
        devices.extend(mdns_devices)
    except Exception as e:
        logger.warning(f"mDNS discovery failed: {e}")

    # If no devices found, try common ports on local subnet
    if not devices:
        try:
            subnet_devices = await _discover_subnet(timeout_ms / 1000)
            devices.extend(subnet_devices)
        except Exception as e:
            logger.warning(f"Subnet discovery failed: {e}")

    elapsed_ms = int((datetime.now() - start_time).total_seconds() * 1000)

    return DiscoveryResult(
        devices=devices,
        scan_duration_ms=elapsed_ms,
    )


@router.post("/ping")
async def ping_device(ip: str, port: int = 80):
    """Ping a specific device to check if it's reachable."""
    device_info = await _probe_device(ip, port)

    if device_info:
        return {"reachable": True, "device": device_info}
    else:
        return {"reachable": False, "device": None}


@router.post("/reboot")
async def reboot_device():
    """Send reboot command to connected device."""
    from main import is_display_connected, queue_display_command

    if not is_display_connected():
        raise HTTPException(status_code=400, detail="No device connected")

    queue_display_command("reboot")
    return {"success": True, "message": "Reboot command queued"}


@router.post("/update")
async def update_device():
    """Send OTA update command to connected device."""
    from main import is_display_connected, queue_display_command

    if not is_display_connected():
        raise HTTPException(status_code=400, detail="No device connected")

    queue_display_command("update")
    return {"success": True, "message": "Update command queued"}


@router.post("/factory-reset")
async def factory_reset_device():
    """Send factory reset command to connected device.

    WARNING: This will erase all device settings.
    """
    if not _connected_device:
        raise HTTPException(status_code=400, detail="No device connected")

    # TODO: Send factory reset command via WebSocket
    return {"success": True, "message": "Factory reset command sent"}


class RecoveryInfo(BaseModel):
    """USB recovery information."""
    steps: List[str]
    serial_commands: dict
    firmware_url: Optional[str] = None


@router.get("/recovery-info", response_model=RecoveryInfo)
async def get_recovery_info():
    """Get USB recovery instructions and commands."""
    return RecoveryInfo(
        steps=[
            "1. Connect ESP32 to computer via USB-C cable",
            "2. Install USB-to-serial driver if needed (CP2102 or CH340)",
            "3. Open serial terminal (115200 baud, 8N1)",
            "4. Hold BOOT button, press RESET, release BOOT to enter bootloader",
            "5. Use espflash or esptool to flash firmware",
        ],
        serial_commands={
            "monitor": "espflash monitor",
            "flash": "espflash flash --monitor firmware.bin",
            "erase": "espflash erase-flash",
            "chip_info": "espflash board-info",
        },
        firmware_url="/api/firmware/ota",
    )


# Helper functions

async def _probe_device(ip: str, port: int) -> Optional[DeviceInfo]:
    """Probe a device to check if it's a SpoolBuddy device."""
    try:
        # Try HTTP endpoint
        import httpx
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"http://{ip}:{port}/api/info")
            if response.status_code == 200:
                data = response.json()
                return DeviceInfo(
                    ip=ip,
                    hostname=data.get("hostname"),
                    firmware_version=data.get("version"),
                    nfc_status=data.get("nfc_ok"),
                    scale_status=data.get("scale_ok"),
                    uptime=data.get("uptime"),
                    last_seen=datetime.now().isoformat(),
                )
    except Exception:
        pass

    # Try simple TCP connect as fallback
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1.0)
        result = sock.connect_ex((ip, port))
        sock.close()
        if result == 0:
            return DeviceInfo(
                ip=ip,
                last_seen=datetime.now().isoformat(),
            )
    except Exception:
        pass

    return None


async def _discover_mdns(timeout: float) -> List[DeviceInfo]:
    """Discover devices using mDNS."""
    devices = []

    try:
        from zeroconf import ServiceBrowser, Zeroconf, ServiceListener

        class SpoolBuddyListener(ServiceListener):
            def add_service(self, zc, type_, name):
                info = zc.get_service_info(type_, name)
                if info:
                    ip = socket.inet_ntoa(info.addresses[0]) if info.addresses else None
                    if ip:
                        devices.append(DeviceInfo(
                            ip=ip,
                            hostname=info.server,
                            last_seen=datetime.now().isoformat(),
                        ))

            def remove_service(self, zc, type_, name):
                pass

            def update_service(self, zc, type_, name):
                pass

        zc = Zeroconf()
        listener = SpoolBuddyListener()
        browser = ServiceBrowser(zc, "_spoolbuddy._tcp.local.", listener)

        await asyncio.sleep(timeout)

        zc.close()

    except ImportError:
        logger.debug("zeroconf not installed, skipping mDNS discovery")
    except Exception as e:
        logger.warning(f"mDNS discovery error: {e}")

    return devices


async def _discover_subnet(timeout: float) -> List[DeviceInfo]:
    """Discover devices by scanning local subnet."""
    devices = []

    # Get local IP to determine subnet
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        return devices

    # Scan common IP range (last octet 1-254)
    subnet = ".".join(local_ip.split(".")[:-1])

    async def check_ip(ip: str):
        device = await _probe_device(ip, 80)
        if device:
            devices.append(device)

    # Scan in parallel with limited concurrency
    tasks = []
    for i in range(1, 255):
        ip = f"{subnet}.{i}"
        if ip != local_ip:
            tasks.append(check_ip(ip))

    # Run with timeout
    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=timeout
        )
    except asyncio.TimeoutError:
        pass

    return devices
