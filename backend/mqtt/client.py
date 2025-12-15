import json
import ssl
import logging
import asyncio
from typing import Optional, Callable, Any
from dataclasses import dataclass, field

import paho.mqtt.client as mqtt

from models import PrinterState, AmsUnit, AmsTray

logger = logging.getLogger(__name__)


@dataclass
class Calibration:
    """Calibration profile for a filament."""
    cali_idx: int
    filament_id: str
    k_value: float
    name: str
    extruder_id: Optional[int] = None
    nozzle_diameter: Optional[str] = None


@dataclass
class PrinterConnection:
    """Manages MQTT connection to a single Bambu printer."""

    serial: str
    ip_address: str
    access_code: str
    name: Optional[str] = None

    _client: Optional[mqtt.Client] = field(default=None, repr=False)
    _connected: bool = field(default=False, repr=False)
    _state: PrinterState = field(default_factory=PrinterState, repr=False)
    _on_state_update: Optional[Callable[[str, PrinterState], None]] = field(default=None, repr=False)
    _loop: Optional[asyncio.AbstractEventLoop] = field(default=None, repr=False)
    _calibrations: dict = field(default_factory=dict, repr=False)  # cali_idx -> Calibration

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def state(self) -> PrinterState:
        return self._state

    def connect(self, on_state_update: Callable[[str, PrinterState], None]):
        """Connect to printer via MQTT."""
        self._on_state_update = on_state_update
        self._loop = asyncio.get_event_loop()

        # Create MQTT client
        self._client = mqtt.Client(
            client_id=f"spoolbuddy_{self.serial}",
            protocol=mqtt.MQTTv311,
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        )

        # Set credentials
        self._client.username_pw_set("bblp", self.access_code)

        # Configure TLS (Bambu printers use self-signed certs)
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        self._client.tls_set_context(ssl_context)

        # Set callbacks
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

        # Connect
        try:
            self._client.connect(self.ip_address, 8883, keepalive=60)
            self._client.loop_start()
            logger.info(f"Connecting to printer {self.serial} at {self.ip_address}")
        except Exception as e:
            logger.error(f"Failed to connect to {self.serial}: {e}")
            raise

    def disconnect(self):
        """Disconnect from printer."""
        if self._client:
            self._client.loop_stop()
            self._client.disconnect()
            self._connected = False
            logger.info(f"Disconnected from printer {self.serial}")

    def reset_slot(self, ams_id: int, tray_id: int) -> bool:
        """Trigger RFID re-read on an AMS slot.

        Sends the ams_get_rfid command to force the printer to re-scan the RFID tag.

        Args:
            ams_id: AMS unit ID (0-3 for regular AMS, 128-135 for AMS-HT, 254/255 for external)
            tray_id: Tray ID within AMS (0-3 for regular AMS, 0 for HT/external)

        Returns:
            True if command was sent successfully
        """
        if not self._client or not self._connected:
            logger.error(f"Cannot reset slot: not connected to {self.serial}")
            return False

        # Calculate slot_id based on AMS type
        if ams_id <= 3:
            slot_id = tray_id
        elif ams_id >= 128 and ams_id <= 135:
            slot_id = 0
        else:
            slot_id = 0

        topic = f"device/{self.serial}/request"

        # Send ams_get_rfid command to trigger RFID re-read
        rfid_command = {
            "print": {
                "command": "ams_get_rfid",
                "ams_id": ams_id,
                "slot_id": slot_id,
                "sequence_id": "1",
            }
        }

        try:
            result = self._client.publish(topic, json.dumps(rfid_command))
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                logger.error(f"Failed to send ams_get_rfid command: {result.rc}")
                return False

            logger.info(f"Triggered RFID re-read on {self.serial}: AMS {ams_id}, slot {slot_id}")

            return True

        except Exception as e:
            logger.error(f"Error triggering RFID re-read on {self.serial}: {e}")
            return False

    def set_calibration(
        self,
        ams_id: int,
        tray_id: int,
        cali_idx: int = -1,
        filament_id: str = "",
        nozzle_diameter: str = "0.4",
    ) -> bool:
        """Set calibration profile (k-value) for an AMS slot.

        Args:
            ams_id: AMS unit ID
            tray_id: Tray ID within AMS
            cali_idx: Calibration index (-1 for default/no profile)
            filament_id: Filament preset ID
            nozzle_diameter: Nozzle diameter

        Returns:
            True if command was sent successfully
        """
        if not self._client or not self._connected:
            logger.error(f"Cannot set calibration: not connected to {self.serial}")
            return False

        # Calculate slot_id and original_tray_id based on AMS type
        if ams_id <= 3:
            slot_id = tray_id
            original_tray_id = ams_id * 4 + tray_id
        elif ams_id >= 128 and ams_id <= 135:
            slot_id = 0
            original_tray_id = (ams_id - 128) * 4 + tray_id
        else:
            slot_id = 0
            original_tray_id = ams_id

        command = {
            "print": {
                "command": "extrusion_cali_sel",
                "cali_idx": cali_idx,
                "filament_id": filament_id,
                "nozzle_diameter": nozzle_diameter,
                "ams_id": ams_id,
                "tray_id": original_tray_id,
                "slot_id": slot_id,
                "sequence_id": "1",
            }
        }

        topic = f"device/{self.serial}/request"
        try:
            result = self._client.publish(topic, json.dumps(command))
            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                logger.info(
                    f"Set calibration on {self.serial}: AMS {ams_id}, tray {tray_id}, "
                    f"cali_idx={cali_idx}"
                )
                return True
            else:
                logger.error(f"Failed to publish calibration setting: {result.rc}")
                return False
        except Exception as e:
            logger.error(f"Error setting calibration on {self.serial}: {e}")
            return False

    def get_calibrations(self) -> list[dict]:
        """Get list of available calibration profiles.

        Returns:
            List of calibration profiles with cali_idx, name, k_value, filament_id
        """
        return [
            {
                "cali_idx": cal.cali_idx,
                "filament_id": cal.filament_id,
                "k_value": cal.k_value,
                "name": cal.name,
                "nozzle_diameter": cal.nozzle_diameter,
            }
            for cal in self._calibrations.values()
        ]

    def set_filament(
        self,
        ams_id: int,
        tray_id: int,
        tray_info_idx: str = "",
        tray_type: str = "",
        tray_color: str = "FFFFFFFF",
        nozzle_temp_min: int = 190,
        nozzle_temp_max: int = 230,
    ) -> bool:
        """Set filament information for an AMS slot.

        Args:
            ams_id: AMS unit ID (0-3 for regular AMS, 128-135 for AMS-HT, 254/255 for external)
            tray_id: Tray ID within AMS (0-3 for regular AMS, 0 for HT/external)
            tray_info_idx: Filament preset ID (e.g., "GFL99")
            tray_type: Material type (e.g., "PLA", "PETG")
            tray_color: RGBA hex color (e.g., "FF0000FF" for red)
            nozzle_temp_min: Minimum nozzle temperature
            nozzle_temp_max: Maximum nozzle temperature

        Returns:
            True if command was sent successfully
        """
        if not self._client or not self._connected:
            logger.error(f"Cannot set filament: not connected to {self.serial}")
            return False

        # Calculate slot_id based on AMS type
        if ams_id <= 3:
            # Regular AMS: slot_id = tray_id
            slot_id = tray_id
        else:
            # AMS-HT or external: slot_id = 0
            slot_id = 0

        command = {
            "print": {
                "command": "ams_filament_setting",
                "ams_id": ams_id,
                "tray_id": tray_id,
                "slot_id": slot_id,
                "tray_info_idx": tray_info_idx,
                "tray_type": tray_type,
                "tray_color": tray_color,
                "nozzle_temp_min": nozzle_temp_min,
                "nozzle_temp_max": nozzle_temp_max,
                "sequence_id": "1",
            }
        }

        topic = f"device/{self.serial}/request"
        try:
            result = self._client.publish(topic, json.dumps(command))
            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                logger.info(
                    f"Set filament on {self.serial}: AMS {ams_id}, tray {tray_id}, "
                    f"type={tray_type}, color={tray_color}"
                )
                return True
            else:
                logger.error(f"Failed to publish filament setting: {result.rc}")
                return False
        except Exception as e:
            logger.error(f"Error setting filament on {self.serial}: {e}")
            return False

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        """MQTT connect callback."""
        if reason_code == 0:
            self._connected = True
            logger.info(f"Connected to printer {self.serial}")

            # Subscribe to report topic
            topic = f"device/{self.serial}/report"
            client.subscribe(topic)
            logger.info(f"Subscribed to {topic}")

            # Fetch calibrations for all nozzle sizes (like SpoolEase does)
            for nozzle_diameter in ["0.2", "0.4", "0.6", "0.8"]:
                self._fetch_calibrations(nozzle_diameter)

            # Request full state
            self._send_pushall()
        else:
            logger.error(f"Connection to {self.serial} failed: {reason_code}")

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        """MQTT disconnect callback."""
        self._connected = False
        logger.info(f"Disconnected from printer {self.serial}: {reason_code}")

    def _on_message(self, client, userdata, msg):
        """MQTT message callback."""
        try:
            payload = json.loads(msg.payload.decode())
            self._handle_message(payload)
        except json.JSONDecodeError as e:
            logger.debug(f"Failed to parse message: {e}")
        except Exception as e:
            logger.error(f"Error handling message from {self.serial}: {e}")

    def _send_pushall(self):
        """Request full printer state."""
        if self._client and self._connected:
            topic = f"device/{self.serial}/request"
            payload = json.dumps({"pushing": {"command": "pushall", "sequence_id": "1"}})
            self._client.publish(topic, payload)

    def _fetch_calibrations(self, nozzle_diameter: str = "0.4"):
        """Request calibration profiles for a nozzle diameter."""
        if self._client and self._connected:
            topic = f"device/{self.serial}/request"
            payload = json.dumps({
                "print": {
                    "command": "extrusion_cali_get",
                    "filament_id": "",
                    "nozzle_diameter": nozzle_diameter,
                    "sequence_id": "1"
                }
            })
            self._client.publish(topic, payload)
            logger.debug(f"Requested calibrations for nozzle {nozzle_diameter}")

    def _handle_message(self, payload: dict):
        """Process incoming MQTT message."""
        if "print" not in payload:
            return

        print_data = payload["print"]

        # Handle extrusion_cali_get response (calibration profiles)
        command = print_data.get("command")
        if command == "extrusion_cali_get":
            self._handle_calibration_response(print_data)
            return

        # Extract gcode state
        if "gcode_state" in print_data:
            self._state.gcode_state = print_data["gcode_state"]

        # Extract progress (mc_percent is actual print progress)
        if "mc_percent" in print_data:
            self._state.print_progress = print_data["mc_percent"]

        # Extract subtask name
        if "subtask_name" in print_data:
            self._state.subtask_name = print_data["subtask_name"]

        # Extract layer info from nested "3D" object or direct fields
        data_3d = print_data.get("3D", {})
        if "layer_num" in data_3d:
            self._state.layer_num = data_3d["layer_num"]
        elif "layer_num" in print_data:
            self._state.layer_num = print_data["layer_num"]

        if "total_layer_num" in data_3d:
            self._state.total_layer_num = data_3d["total_layer_num"]
        elif "total_layer_num" in print_data:
            self._state.total_layer_num = print_data["total_layer_num"]

        # Extract AMS data
        if "ams" in print_data:
            self._parse_ams_data(print_data["ams"])

        # Extract virtual tray (external spool)
        if "vt_tray" in print_data:
            self._state.vt_tray = self._parse_tray(print_data["vt_tray"], 255, 0)

        # Extract tray_now (currently active tray) from AMS data
        ams_data = print_data.get("ams", {})
        if "tray_now" in ams_data:
            tray_now_raw = ams_data["tray_now"]
            self._state.tray_now = self._safe_int(tray_now_raw)

        # Notify listener
        if self._on_state_update:
            # Schedule callback in event loop if running from MQTT thread
            if self._loop:
                self._loop.call_soon_threadsafe(
                    lambda: self._on_state_update(self.serial, self._state)
                )

    def _handle_calibration_response(self, print_data: dict):
        """Process calibration profiles from extrusion_cali_get response."""
        filaments = print_data.get("filaments", [])
        nozzle_diameter = print_data.get("nozzle_diameter")

        if not filaments:
            return

        count = 0
        for filament in filaments:
            cali_idx = filament.get("cali_idx")
            if cali_idx is None or cali_idx <= 0:
                continue

            k_value_str = filament.get("k_value", "0")
            try:
                k_value = float(k_value_str)
            except (ValueError, TypeError):
                k_value = 0.0

            calibration = Calibration(
                cali_idx=cali_idx,
                filament_id=filament.get("filament_id", ""),
                k_value=k_value,
                name=filament.get("name", ""),
                extruder_id=filament.get("extruder_id"),
                nozzle_diameter=nozzle_diameter,
            )
            self._calibrations[cali_idx] = calibration
            count += 1

        if count > 0:
            cali_indices = sorted(self._calibrations.keys())
            logger.info(f"Loaded {count} calibration profiles for nozzle {nozzle_diameter}, indices: {cali_indices}")

    def _parse_ams_data(self, ams_data: dict):
        """Parse AMS units and trays from MQTT data."""
        if "ams" not in ams_data:
            return

        # Build/update AMS extruder map from info field
        # This map persists across updates even when info field is missing
        if not hasattr(self, "_ams_extruder_map"):
            self._ams_extruder_map = {}

        for ams_unit in ams_data["ams"]:
            unit_id = self._safe_int(ams_unit.get("id"), 0)
            info = ams_unit.get("info")
            if info is not None:
                try:
                    info_val = int(info) if isinstance(info, str) else info
                    # Extract bit 8 for extruder assignment
                    # Bit 8 = 0 means LEFT extruder (id 1), bit 8 = 1 means RIGHT extruder (id 0)
                    # So we invert: extruder_id = 1 - bit8
                    bit8 = (info_val >> 8) & 0x1
                    extruder_id = 1 - bit8  # 0=right, 1=left
                    self._ams_extruder_map[unit_id] = extruder_id
                    logger.debug(f"AMS {unit_id} info={info_val} (bit8={bit8}) -> extruder {extruder_id}")
                except (ValueError, TypeError):
                    pass

        units = []
        for ams_unit in ams_data["ams"]:
            unit_id = self._safe_int(ams_unit.get("id"), 0)

            # Prefer humidity_raw (actual percentage) over humidity (index 1-5)
            humidity_raw = ams_unit.get("humidity_raw")
            humidity_idx = ams_unit.get("humidity")
            humidity = None
            if humidity_raw is not None:
                humidity = self._safe_int(humidity_raw)
            if humidity is None and humidity_idx is not None:
                humidity = self._safe_int(humidity_idx)

            # Temperature from temp field
            temp = self._safe_float(ams_unit.get("temp"))

            # Get extruder from our persisted map
            extruder = self._ams_extruder_map.get(unit_id)

            # Parse trays
            trays = []
            for tray_data in ams_unit.get("tray", []):
                tray = self._parse_tray(tray_data, unit_id, self._safe_int(tray_data.get("id"), 0))
                if tray:
                    trays.append(tray)

            units.append(AmsUnit(
                id=unit_id,
                humidity=humidity,
                temperature=temp,
                extruder=extruder,
                trays=trays,
            ))

        self._state.ams_units = units

    def _parse_tray(self, tray_data: dict, ams_id: int, tray_id: int) -> Optional[AmsTray]:
        """Parse single tray data."""
        if not tray_data:
            return None

        # Resolve k_value:
        # 1. Try direct "k" field in tray data
        # 2. If not present, look up from calibrations using cali_idx
        k_value = None

        # Direct k value from tray
        k_raw = tray_data.get("k")
        if k_raw is not None:
            try:
                k_value = float(k_raw)
            except (ValueError, TypeError):
                pass

        # If no direct k value, try to look up from calibrations
        if k_value is None:
            cali_idx = tray_data.get("cali_idx")
            if cali_idx is not None and cali_idx > 0:
                calibration = self._calibrations.get(cali_idx)
                if calibration:
                    k_value = calibration.k_value
                    logger.debug(f"Resolved k_value={k_value} from cali_idx={cali_idx}")
                # If no calibration found, k_value remains None

        tray = AmsTray(
            ams_id=ams_id,
            tray_id=tray_id,
            tray_type=tray_data.get("tray_type"),
            tray_color=tray_data.get("tray_color"),
            tray_info_idx=tray_data.get("tray_info_idx"),
            k_value=k_value,
            nozzle_temp_min=self._safe_int(tray_data.get("nozzle_temp_min")),
            nozzle_temp_max=self._safe_int(tray_data.get("nozzle_temp_max")),
            remain=self._safe_int(tray_data.get("remain")),
        )

        return tray

    @staticmethod
    def _safe_int(value: Any, default: Optional[int] = None) -> Optional[int]:
        """Safely convert value to int."""
        if value is None:
            return default
        try:
            return int(value)
        except (ValueError, TypeError):
            return default

    @staticmethod
    def _safe_float(value: Any, default: Optional[float] = None) -> Optional[float]:
        """Safely convert value to float."""
        if value is None:
            return default
        try:
            return float(value)
        except (ValueError, TypeError):
            return default


class PrinterManager:
    """Manages multiple printer connections."""

    def __init__(self):
        self._connections: dict[str, PrinterConnection] = {}
        self._on_state_update: Optional[Callable[[str, PrinterState], None]] = None

    def set_state_callback(self, callback: Callable[[str, PrinterState], None]):
        """Set callback for printer state updates."""
        self._on_state_update = callback

    async def connect(self, serial: str, ip_address: str, access_code: str, name: Optional[str] = None):
        """Connect to a printer."""
        if serial in self._connections:
            logger.warning(f"Printer {serial} already connected")
            return

        conn = PrinterConnection(
            serial=serial,
            ip_address=ip_address,
            access_code=access_code,
            name=name,
        )

        try:
            conn.connect(self._handle_state_update)
            self._connections[serial] = conn
        except Exception as e:
            logger.error(f"Failed to connect to {serial}: {e}")
            raise

    async def disconnect(self, serial: str):
        """Disconnect from a printer."""
        if serial not in self._connections:
            return

        conn = self._connections.pop(serial)
        conn.disconnect()

    async def disconnect_all(self):
        """Disconnect all printers."""
        for serial in list(self._connections.keys()):
            await self.disconnect(serial)

    def is_connected(self, serial: str) -> bool:
        """Check if printer is connected."""
        conn = self._connections.get(serial)
        return conn.connected if conn else False

    def get_state(self, serial: str) -> Optional[PrinterState]:
        """Get printer state."""
        conn = self._connections.get(serial)
        return conn.state if conn else None

    def get_connection_statuses(self) -> dict[str, bool]:
        """Get connection status for all managed printers."""
        return {serial: conn.connected for serial, conn in self._connections.items()}

    def set_filament(
        self,
        serial: str,
        ams_id: int,
        tray_id: int,
        tray_info_idx: str = "",
        tray_type: str = "",
        tray_color: str = "FFFFFFFF",
        nozzle_temp_min: int = 190,
        nozzle_temp_max: int = 230,
    ) -> bool:
        """Set filament for an AMS slot on a printer."""
        conn = self._connections.get(serial)
        if not conn:
            logger.error(f"Printer {serial} not connected")
            return False

        return conn.set_filament(
            ams_id=ams_id,
            tray_id=tray_id,
            tray_info_idx=tray_info_idx,
            tray_type=tray_type,
            tray_color=tray_color,
            nozzle_temp_min=nozzle_temp_min,
            nozzle_temp_max=nozzle_temp_max,
        )

    def reset_slot(self, serial: str, ams_id: int, tray_id: int) -> bool:
        """Reset/clear an AMS slot on a printer."""
        conn = self._connections.get(serial)
        if not conn:
            logger.error(f"Printer {serial} not connected")
            return False

        return conn.reset_slot(ams_id=ams_id, tray_id=tray_id)

    def set_calibration(
        self,
        serial: str,
        ams_id: int,
        tray_id: int,
        cali_idx: int = -1,
        filament_id: str = "",
        nozzle_diameter: str = "0.4",
    ) -> bool:
        """Set calibration profile for an AMS slot on a printer."""
        conn = self._connections.get(serial)
        if not conn:
            logger.error(f"Printer {serial} not connected")
            return False

        return conn.set_calibration(
            ams_id=ams_id,
            tray_id=tray_id,
            cali_idx=cali_idx,
            filament_id=filament_id,
            nozzle_diameter=nozzle_diameter,
        )

    def get_calibrations(self, serial: str) -> list[dict]:
        """Get calibration profiles for a printer."""
        conn = self._connections.get(serial)
        if not conn:
            return []

        return conn.get_calibrations()

    def _handle_state_update(self, serial: str, state: PrinterState):
        """Handle state update from printer."""
        if self._on_state_update:
            self._on_state_update(serial, state)
