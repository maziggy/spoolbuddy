from pydantic import BaseModel
from typing import Optional
from datetime import datetime


# ============ Spool Models ============

class SpoolBase(BaseModel):
    tag_id: Optional[str] = None
    material: str
    subtype: Optional[str] = None
    color_name: Optional[str] = None
    rgba: Optional[str] = None
    brand: Optional[str] = None
    label_weight: Optional[int] = 1000
    core_weight: Optional[int] = 250
    weight_new: Optional[int] = None
    weight_current: Optional[int] = None
    slicer_filament: Optional[str] = None
    note: Optional[str] = None
    data_origin: Optional[str] = None
    tag_type: Optional[str] = None


class SpoolCreate(SpoolBase):
    pass


class SpoolUpdate(SpoolBase):
    material: Optional[str] = None


class Spool(SpoolBase):
    id: str
    added_time: Optional[int] = None
    encode_time: Optional[int] = None
    added_full: Optional[int] = 0
    consumed_since_add: Optional[float] = 0
    consumed_since_weight: Optional[float] = 0
    created_at: Optional[int] = None
    updated_at: Optional[int] = None

    class Config:
        from_attributes = True


# ============ Printer Models ============

class PrinterBase(BaseModel):
    serial: str
    name: Optional[str] = None
    model: Optional[str] = None
    ip_address: Optional[str] = None
    access_code: Optional[str] = None
    auto_connect: bool = False


class PrinterCreate(PrinterBase):
    pass


class PrinterUpdate(BaseModel):
    name: Optional[str] = None
    model: Optional[str] = None
    ip_address: Optional[str] = None
    access_code: Optional[str] = None
    auto_connect: Optional[bool] = None


class Printer(PrinterBase):
    last_seen: Optional[int] = None
    config: Optional[str] = None

    class Config:
        from_attributes = True


class PrinterWithStatus(BaseModel):
    """Printer with connection status."""
    serial: str
    name: Optional[str] = None
    model: Optional[str] = None
    ip_address: Optional[str] = None
    access_code: Optional[str] = None
    last_seen: Optional[int] = None
    config: Optional[str] = None
    auto_connect: bool = False
    connected: bool = False


# ============ AMS Models ============

class AmsTray(BaseModel):
    """Single AMS tray/slot."""
    ams_id: int
    tray_id: int
    tray_type: Optional[str] = None
    tray_color: Optional[str] = None
    tray_info_idx: Optional[str] = None
    k_value: Optional[float] = None
    nozzle_temp_min: Optional[int] = None
    nozzle_temp_max: Optional[int] = None
    remain: Optional[int] = None  # Remaining filament percentage (0-100)


class AmsUnit(BaseModel):
    """AMS unit with humidity and trays."""
    id: int
    humidity: Optional[int] = None  # Percentage (0-100) from humidity_raw, or index (1-5) fallback
    temperature: Optional[float] = None  # Temperature in Celsius
    extruder: Optional[int] = None  # 0 = right nozzle, 1 = left nozzle
    trays: list[AmsTray] = []


class PrinterState(BaseModel):
    """Real-time printer state from MQTT."""
    gcode_state: Optional[str] = None
    print_progress: Optional[int] = None
    layer_num: Optional[int] = None
    total_layer_num: Optional[int] = None
    subtask_name: Optional[str] = None
    ams_units: list[AmsUnit] = []
    vt_tray: Optional[AmsTray] = None
    tray_now: Optional[int] = None  # Currently active tray (0-15 for AMS, 254/255 for external)


# ============ AMS Filament Setting ============

class AmsFilamentSettingRequest(BaseModel):
    """Request to set filament in an AMS slot."""
    tray_info_idx: str = ""  # Filament preset ID (e.g., "GFL99")
    tray_type: str = ""  # Material type (e.g., "PLA")
    tray_color: str = "FFFFFFFF"  # RGBA hex (e.g., "FF0000FF")
    nozzle_temp_min: int = 190
    nozzle_temp_max: int = 230


class AssignSpoolRequest(BaseModel):
    """Request to assign a spool to an AMS slot."""
    spool_id: str
    ams_id: int  # 0-3 for AMS, 128-135 for AMS-HT, 254/255 for external
    tray_id: int  # 0-3 for AMS trays, 0 for HT/external


class SetCalibrationRequest(BaseModel):
    """Request to set calibration profile for an AMS slot."""
    cali_idx: int = -1  # -1 for default (0.02), or calibration profile index
    filament_id: str = ""  # Filament preset ID (optional)
    nozzle_diameter: str = "0.4"  # Nozzle diameter


# ============ WebSocket Messages ============

class WSMessage(BaseModel):
    """WebSocket message wrapper."""
    type: str
    data: dict = {}


# ============ Bambu Cloud Models ============

class CloudLoginRequest(BaseModel):
    """Request to login to Bambu Cloud."""
    email: str
    password: str


class CloudVerifyRequest(BaseModel):
    """Request to verify login with code."""
    email: str
    code: str


class CloudTokenRequest(BaseModel):
    """Request to set token directly."""
    access_token: str


class CloudLoginResponse(BaseModel):
    """Response from login attempt."""
    success: bool
    needs_verification: bool = False
    message: str


class CloudAuthStatus(BaseModel):
    """Cloud authentication status."""
    is_authenticated: bool
    email: Optional[str] = None


class SlicerPreset(BaseModel):
    """A slicer preset (filament, printer, or process)."""
    setting_id: str
    name: str
    type: str  # filament, printer, process
    version: Optional[str] = None
    user_id: Optional[str] = None
    is_custom: bool = False  # True if user's private preset


class SlicerSettingsResponse(BaseModel):
    """Response containing all slicer presets."""
    filament: list[SlicerPreset] = []
    printer: list[SlicerPreset] = []
    process: list[SlicerPreset] = []
