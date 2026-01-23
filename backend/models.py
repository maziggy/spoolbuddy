from pydantic import BaseModel

# ============ Spool Models ============


class SpoolBase(BaseModel):
    tag_id: str | None = None
    material: str
    subtype: str | None = None
    color_name: str | None = None
    rgba: str | None = None
    brand: str | None = None
    label_weight: int | None = 1000
    core_weight: int | None = 250
    weight_new: int | None = None
    weight_current: int | None = None
    slicer_filament: str | None = None
    slicer_filament_name: str | None = None
    location: str | None = None
    note: str | None = None
    data_origin: str | None = None
    tag_type: str | None = None
    ext_has_k: bool | None = False


class SpoolCreate(SpoolBase):
    pass


class SpoolUpdate(SpoolBase):
    material: str | None = None


class Spool(SpoolBase):
    id: str
    spool_number: int | None = None
    added_time: int | None = None
    encode_time: int | None = None
    added_full: int | None = 0
    consumed_since_add: float | None = 0
    consumed_since_weight: float | None = 0
    weight_used: float | None = 0
    archived_at: int | None = None  # Timestamp when archived, null = active
    created_at: int | None = None
    updated_at: int | None = None
    last_used_time: int | None = None  # From usage_history table

    class Config:
        from_attributes = True


# ============ Printer Models ============


class PrinterBase(BaseModel):
    serial: str
    name: str | None = None
    model: str | None = None
    ip_address: str | None = None
    access_code: str | None = None
    auto_connect: bool = False


class PrinterCreate(PrinterBase):
    pass


class PrinterUpdate(BaseModel):
    name: str | None = None
    model: str | None = None
    ip_address: str | None = None
    access_code: str | None = None
    auto_connect: bool | None = None


class Printer(PrinterBase):
    last_seen: int | None = None
    config: str | None = None
    nozzle_count: int = 1  # 1 or 2, auto-detected from MQTT

    class Config:
        from_attributes = True


# ============ AMS Models ============
# NOTE: AMS models defined before PrinterWithStatus to avoid forward references


class AmsTray(BaseModel):
    """Single AMS tray/slot."""

    ams_id: int
    tray_id: int
    tray_type: str | None = None
    tray_sub_brands: str | None = None  # Preset name (e.g., "Bambu PLA Basic")
    tray_color: str | None = None
    tray_info_idx: str | None = None
    k_value: float | None = None
    nozzle_temp_min: int | None = None
    nozzle_temp_max: int | None = None
    remain: int | None = None  # Remaining filament percentage (0-100)


class AmsUnit(BaseModel):
    """AMS unit with humidity and trays."""

    id: int
    humidity: int | None = None  # Percentage (0-100) from humidity_raw, or index (1-5) fallback
    temperature: float | None = None  # Temperature in Celsius
    extruder: int | None = None  # 0 = right nozzle, 1 = left nozzle
    trays: list[AmsTray] = []


class PrinterWithStatus(BaseModel):
    """Printer with connection status and live state."""

    serial: str
    name: str | None = None
    model: str | None = None
    ip_address: str | None = None
    access_code: str | None = None
    last_seen: int | None = None
    config: str | None = None
    auto_connect: bool = False
    nozzle_count: int = 1  # 1 or 2, auto-detected from MQTT
    connected: bool = False
    # Live state from MQTT
    gcode_state: str | None = None
    print_progress: int | None = None
    subtask_name: str | None = None  # Current print job name
    mc_remaining_time: int | None = None  # Remaining time in minutes
    cover_url: str | None = None  # URL to cover image if printing
    # Detailed status tracking
    stg_cur: int = -1  # Current stage number (-1 = idle/unknown)
    stg_cur_name: str | None = None  # Human-readable stage name (e.g., "Auto bed leveling")
    # AMS state
    ams_units: list[AmsUnit] = []
    tray_now: int | None = None  # Active tray (single nozzle)
    tray_now_left: int | None = None  # Active tray left nozzle (dual)
    tray_now_right: int | None = None  # Active tray right nozzle (dual)
    active_extruder: int | None = None  # Currently active extruder (0=right, 1=left)
    # Tray reading state (RFID scanning)
    tray_reading_bits: int | None = None  # Bitmask of trays currently being read


class PrinterState(BaseModel):
    """Real-time printer state from MQTT."""

    gcode_state: str | None = None
    print_progress: int | None = None
    layer_num: int | None = None
    total_layer_num: int | None = None
    subtask_name: str | None = None
    mc_remaining_time: int | None = None  # Remaining time in minutes
    gcode_file: str | None = None  # Current gcode file path
    ams_units: list[AmsUnit] = []
    vt_tray: AmsTray | None = None
    tray_now: int | None = None  # Currently active tray (0-15 for AMS, 254/255 for external) - legacy single-nozzle
    # Dual-nozzle support (H2C/H2D)
    tray_now_left: int | None = None  # Active tray for left nozzle (extruder 1)
    tray_now_right: int | None = None  # Active tray for right nozzle (extruder 0)
    active_extruder: int | None = None  # Currently active extruder (0=right, 1=left)
    # Detailed status tracking (from stg_cur field)
    stg_cur: int = -1  # Current stage number (-1 = idle/unknown, 255 = idle on A1/P1)
    stg_cur_name: str | None = None  # Human-readable stage name
    # Tray reading state (for tracking RFID scanning)
    tray_reading_bits: int | None = None  # Bitmask of trays currently being read
    # Nozzle count (auto-detected from MQTT device.extruder.info)
    nozzle_count: int = 1  # 1 = single nozzle, 2 = dual nozzle (H2C/H2D)


# ============ AMS Filament Setting ============


class AmsFilamentSettingRequest(BaseModel):
    """Request to set filament in an AMS slot."""

    tray_info_idx: str = ""  # Filament preset ID short format (e.g., "GFL05")
    tray_type: str = ""  # Material type (e.g., "PLA")
    tray_sub_brands: str = ""  # Preset name for slicer (e.g., "Bambu PLA Basic")
    tray_color: str = "FFFFFFFF"  # RGBA hex (e.g., "FF0000FF")
    nozzle_temp_min: int = 190
    nozzle_temp_max: int = 230
    setting_id: str = ""  # Full setting ID with version (e.g., "GFSL05_07")


class AssignSpoolRequest(BaseModel):
    """Request to assign a spool to an AMS slot."""

    spool_id: str
    # Note: ams_id and tray_id come from path parameters, not body


class SetCalibrationRequest(BaseModel):
    """Request to set calibration profile for an AMS slot."""

    cali_idx: int = -1  # -1 for default (0.02), or calibration profile index
    filament_id: str = ""  # K profile's filament_id (optional)
    nozzle_diameter: str = "0.4"  # Nozzle diameter
    setting_id: str = ""  # K profile's setting_id for slicer compatibility (optional)
    k_value: float = 0.0  # Direct K value to set (0.0 = skip direct setting)
    nozzle_temp_max: int = 230  # Max nozzle temp for extrusion_cali_set


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
    email: str | None = None


class SlicerPreset(BaseModel):
    """A slicer preset (filament, printer, or process)."""

    setting_id: str
    name: str
    type: str  # filament, printer, process
    version: str | None = None
    user_id: str | None = None
    is_custom: bool = False  # True if user's private preset


class SlicerSettingsResponse(BaseModel):
    """Response containing all slicer presets."""

    filament: list[SlicerPreset] = []
    printer: list[SlicerPreset] = []
    process: list[SlicerPreset] = []
