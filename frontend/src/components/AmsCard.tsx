import { useState } from "preact/hooks";
import { AmsUnit, AmsTray } from "../lib/websocket";
import { api, CalibrationProfile } from "../lib/api";

interface AmsCardProps {
  unit: AmsUnit;
  printerModel?: string;
  numExtruders?: number;
  printerSerial?: string;
  calibrations?: CalibrationProfile[];
  trayNow?: number | null; // Currently active tray index
}

// Convert tray_now to tray index within an AMS unit
// tray_now: 0-3 = AMS A slots, 4-7 = AMS B slots, etc.
// Returns the tray_id (0-3) if this AMS unit contains the active tray, null otherwise
function getActiveTrayInUnit(amsId: number, trayNow: number | null): number | null {
  if (trayNow === null || trayNow === undefined || trayNow === 255) return null;

  if (amsId <= 3) {
    // Regular AMS: tray_now 0-3 = AMS 0, 4-7 = AMS 1, etc.
    const activeAmsId = Math.floor(trayNow / 4);
    if (activeAmsId === amsId) {
      return trayNow % 4;
    }
  } else if (amsId >= 128 && amsId <= 135) {
    // AMS-HT: tray_now 16-23 maps to AMS-HT 128-135
    // Not sure about exact mapping, will need testing
    const htIndex = amsId - 128;
    if (trayNow === 16 + htIndex) {
      return 0; // HT only has one slot
    }
  }

  return null;
}

// Get AMS display name from ID
function getAmsName(amsId: number): string {
  if (amsId <= 3) {
    return `AMS ${String.fromCharCode(65 + amsId)}`; // A, B, C, D
  } else if (amsId >= 128 && amsId <= 135) {
    return `AMS HT ${String.fromCharCode(65 + amsId - 128)}`; // HT-A, HT-B, ...
  } else if (amsId === 255) {
    return "External";
  } else if (amsId === 254) {
    return "External L";
  }
  return `AMS ${amsId}`;
}

// Check if AMS is HT type (single slot per unit)
function isHtAms(amsId: number): boolean {
  return amsId >= 128 && amsId <= 135;
}

// Convert hex color from printer (e.g., "FF0000FF") to CSS color
function trayColorToCSS(color: string | null): string {
  if (!color) return "#808080";
  const hex = color.slice(0, 6);
  return `#${hex}`;
}

// Check if a tray is empty
function isTrayEmpty(tray: AmsTray): boolean {
  return !tray.tray_type || tray.tray_type === "";
}

// Get humidity display info
function getHumidityDisplay(rawHumidity: number | null): { level: number; icon: string } {
  if (rawHumidity === null || rawHumidity === undefined || rawHumidity === 0) {
    return { level: 0, icon: "0" };
  }
  const level = Math.min(Math.max(rawHumidity, 1), 5);
  return { level, icon: String(Math.min(level, 4)) };
}

// Spool icon SVG - colored spool shape like OrcaSlicer
function SpoolIcon({ color, isEmpty, size = 32 }: { color: string; isEmpty: boolean; size?: number }) {
  if (isEmpty) {
    return (
      <div
        class="rounded-full border-2 border-dashed border-gray-500 flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        <div class="w-2 h-2 rounded-full bg-gray-500" />
      </div>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {/* Outer ring */}
      <circle cx="16" cy="16" r="14" fill={color} />
      {/* Inner shadow/depth */}
      <circle cx="16" cy="16" r="11" fill={color} style={{ filter: "brightness(0.85)" }} />
      {/* Highlight */}
      <ellipse cx="12" cy="12" rx="4" ry="3" fill="white" opacity="0.3" />
      {/* Center hole */}
      <circle cx="16" cy="16" r="5" fill="#2a2a2a" />
      <circle cx="16" cy="16" r="3" fill="#1a1a1a" />
    </svg>
  );
}

// Fill level indicator bar
function FillLevelBar({ remain }: { remain: number | null }) {
  // Don't show if no data or invalid value
  if (remain === null || remain === undefined || remain < 0) return null;

  const fillColor = remain > 50 ? "#22c55e" : remain > 20 ? "#f59e0b" : "#ef4444";

  return (
    <div class="w-full h-1 bg-gray-700 rounded-full overflow-hidden mt-1">
      <div
        class="h-full rounded-full transition-all"
        style={{ width: `${remain}%`, backgroundColor: fillColor }}
      />
    </div>
  );
}

// Format humidity value - could be percentage (0-100) or index (1-5)
function formatHumidity(value: number | null): string {
  if (value === null || value === undefined) return "-";

  // If value > 5, it's likely a percentage from humidity_raw
  if (value > 5) {
    return `${value}%`;
  }

  // Otherwise it's an index (1-5), show approximate range
  const percentRanges: Record<number, string> = {
    1: "<20%",
    2: "20-40%",
    3: "40-60%",
    4: "60-80%",
    5: ">80%",
  };
  return percentRanges[value] || "-";
}

// Format temperature value
function formatTemperature(value: number | null): string {
  if (value === null || value === undefined) return "";
  return `${value.toFixed(1)}°C`;
}

// Slot action menu component
interface SlotMenuProps {
  printerSerial: string;
  amsId: number;
  trayId: number;
  calibrations: CalibrationProfile[];
  currentKValue: number | null;
}

function SlotMenu({ printerSerial, amsId, trayId, calibrations, currentKValue }: SlotMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleReset = async (e: Event) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await api.resetSlot(printerSerial, amsId, trayId);
    } catch (err) {
      console.error("Failed to reset slot:", err);
    } finally {
      setLoading(false);
      setIsOpen(false);
    }
  };

  const handleSetCalibration = async (caliIdx: number, filamentId: string = "") => {
    setLoading(true);
    try {
      await api.setCalibration(printerSerial, amsId, trayId, {
        cali_idx: caliIdx,
        filament_id: filamentId,
      });
    } catch (err) {
      console.error("Failed to set calibration:", err);
    } finally {
      setLoading(false);
      setIsOpen(false);
    }
  };

  return (
    <div class="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        class="p-1 rounded hover:bg-gray-600 text-gray-400 hover:text-gray-200 transition-colors"
        title="Slot options"
        disabled={loading}
      >
        {loading ? (
          <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
          </svg>
        )}
      </button>

      {isOpen && (
        <>
          {/* Backdrop to close menu */}
          <div
            class="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />
          {/* Menu - fixed position in center of screen for visibility */}
          <div class="fixed left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 z-50 bg-white rounded-lg shadow-xl border border-gray-200 py-2 min-w-[200px] max-h-[80vh] overflow-y-auto">
            <div class="px-4 py-2 border-b border-gray-200 font-medium text-gray-900">
              Slot {trayId + 1} Options
            </div>

            <button
              onClick={handleReset}
              class="w-full px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-3"
            >
              <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Re-read RFID Tag
            </button>

            <div class="border-t border-gray-200 my-2" />

            <div class="px-4 py-2 text-xs text-gray-500 font-medium uppercase">K-Profile Selection</div>

            <button
              onClick={() => handleSetCalibration(-1)}
              class={`w-full px-4 py-3 text-left text-sm hover:bg-gray-100 flex items-center justify-between ${
                currentKValue === null || currentKValue === 0.02 ? "text-blue-600 bg-blue-50" : "text-gray-700"
              }`}
            >
              <span>Default (K = 0.020)</span>
              {(currentKValue === null || currentKValue === 0.02) && (
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
              )}
            </button>

            {calibrations.length > 0 && (
              <>
                {calibrations.map((cal) => (
                  <button
                    key={cal.cali_idx}
                    onClick={() => handleSetCalibration(cal.cali_idx, cal.filament_id)}
                    class={`w-full px-4 py-3 text-left text-sm hover:bg-gray-100 flex items-center justify-between ${
                      currentKValue !== null && Math.abs(currentKValue - cal.k_value) < 0.001 ? "text-blue-600 bg-blue-50" : "text-gray-700"
                    }`}
                    title={cal.name || cal.filament_id}
                  >
                    <span class="truncate mr-2">{cal.name || cal.filament_id || `Profile ${cal.cali_idx}`}</span>
                    <span class="text-gray-500 flex-shrink-0 font-mono text-xs">K={cal.k_value.toFixed(3)}</span>
                  </button>
                ))}
              </>
            )}

            <div class="border-t border-gray-200 mt-2 pt-2">
              <button
                onClick={() => setIsOpen(false)}
                class="w-full px-4 py-2 text-sm text-gray-500 hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Regular AMS card (4 slots)
function RegularAmsCard({ unit, printerModel, printerSerial, calibrations = [], trayNow }: AmsCardProps) {
  const amsName = getAmsName(unit.id);
  const humidity = getHumidityDisplay(unit.humidity);
  const humidityStr = formatHumidity(unit.humidity);
  const temperatureStr = formatTemperature(unit.temperature);

  // Get nozzle label for multi-nozzle printers
  // extruder 0 = Right nozzle, extruder 1 = Left nozzle (per SpoolEase/Bambu convention)
  const nozzleLabel = unit.extruder !== undefined && unit.extruder !== null
    ? (unit.extruder === 0 ? "R" : "L")
    : null;
  const isMultiNozzle = printerModel && ["H2C", "H2D"].includes(printerModel.toUpperCase());

  // Build slots array (4 slots for regular AMS)
  const slots: (AmsTray | undefined)[] = [undefined, undefined, undefined, undefined];
  const sortedTrays = [...unit.trays].sort((a, b) => a.tray_id - b.tray_id);
  sortedTrays.forEach(tray => {
    if (tray.tray_id >= 0 && tray.tray_id < 4) {
      slots[tray.tray_id] = tray;
    }
  });

  const hasControls = !!printerSerial;
  const activeTrayIdx = getActiveTrayInUnit(unit.id, trayNow ?? null);

  return (
    <div class="relative bg-[#1e1e1e] rounded-lg overflow-hidden" style={{ width: 280 }}>
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2 bg-[#2a2a2a]">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-gray-200">{amsName}</span>
          {isMultiNozzle && nozzleLabel && (
            <span class={`px-1.5 py-0.5 text-xs rounded ${
              nozzleLabel === "L" ? "bg-blue-600 text-white" : "bg-purple-600 text-white"
            }`}>
              {nozzleLabel}
            </span>
          )}
        </div>
        <div class="flex items-center gap-2 text-xs text-gray-400">
          {temperatureStr && (
            <span title="Temperature">{temperatureStr}</span>
          )}
          <div class="flex items-center gap-1" title={`Humidity: ${humidityStr}`}>
            <img
              src={`/images/ams/ams_humidity_${humidity.icon}.svg`}
              alt="Humidity"
              class="w-4 h-4 opacity-80"
            />
            <span>{humidityStr}</span>
          </div>
        </div>
      </div>

      {/* Spool icons row */}
      <div class="flex justify-around px-2 py-3 bg-[#252525]">
        {slots.map((tray, idx) => {
          const isEmpty = !tray || isTrayEmpty(tray);
          const color = tray ? trayColorToCSS(tray.tray_color) : "#808080";
          const isActive = activeTrayIdx === idx;
          return (
            <div key={idx} class="flex flex-col items-center">
              <div class={`rounded-full p-0.5 ${isActive ? "ring-2 ring-green-400 ring-offset-1 ring-offset-[#252525]" : ""}`}>
                <SpoolIcon color={color} isEmpty={isEmpty} size={36} />
              </div>
              {isActive && (
                <div class="w-1.5 h-1.5 rounded-full bg-green-400 mt-1" title="Active" />
              )}
            </div>
          );
        })}
      </div>

      {/* AMS unit image */}
      <div class="relative">
        <img
          src="/images/ams/ams.png"
          alt="AMS"
          class="w-full"
          style={{ filter: "brightness(0.9)" }}
        />
      </div>

      {/* Material labels with K value and fill level */}
      <div class="flex justify-around px-2 py-2 bg-[#1a1a1a]">
        {slots.map((tray, idx) => {
          const isEmpty = !tray || isTrayEmpty(tray);
          const material = tray?.tray_type || "";
          const color = tray ? trayColorToCSS(tray.tray_color) : "#808080";
          const kValue = tray?.k_value;
          const remain = tray?.remain;
          return (
            <div key={idx} class="flex flex-col items-center" style={{ width: 56 }}>
              {/* Slot menu button */}
              {hasControls && (
                <div class="self-end mb-0.5">
                  <SlotMenu
                    printerSerial={printerSerial!}
                    amsId={unit.id}
                    trayId={idx}
                    calibrations={calibrations}
                    currentKValue={kValue ?? null}
                  />
                </div>
              )}
              <span
                class="text-xs font-medium truncate text-center"
                style={{ color: isEmpty ? "#666" : color, maxWidth: 56 }}
                title={material}
              >
                {isEmpty ? "-" : material}
              </span>
              {!isEmpty && kValue !== null && kValue !== undefined && (
                <span class="text-[10px] text-gray-500" title="K value (pressure advance)">
                  K:{kValue.toFixed(3)}
                </span>
              )}
              {!isEmpty && remain !== null && remain !== undefined && remain >= 0 && (
                <>
                  <FillLevelBar remain={remain} />
                  <span class="text-[10px] text-gray-500">{remain}%</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// HT AMS card (single slot)
function HtAmsCard({ unit, printerModel, printerSerial, calibrations = [], trayNow }: AmsCardProps) {
  const amsName = getAmsName(unit.id);
  const humidity = getHumidityDisplay(unit.humidity);
  const humidityStr = formatHumidity(unit.humidity);
  const temperatureStr = formatTemperature(unit.temperature);
  const tray = unit.trays[0];
  const isEmpty = !tray || isTrayEmpty(tray);
  const color = tray ? trayColorToCSS(tray.tray_color) : "#808080";
  const material = tray?.tray_type || "";
  const kValue = tray?.k_value;
  const remain = tray?.remain;

  // Get nozzle label for multi-nozzle printers
  // extruder 0 = Right nozzle, extruder 1 = Left nozzle (per SpoolEase/Bambu convention)
  const nozzleLabel = unit.extruder !== undefined && unit.extruder !== null
    ? (unit.extruder === 0 ? "R" : "L")
    : null;
  const isMultiNozzle = printerModel && ["H2C", "H2D"].includes(printerModel.toUpperCase());
  const hasControls = !!printerSerial;
  const isActive = getActiveTrayInUnit(unit.id, trayNow ?? null) === 0;

  return (
    <div class="relative bg-[#1e1e1e] rounded-lg overflow-hidden" style={{ width: 140 }}>
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2 bg-[#2a2a2a]">
        <div class="flex items-center gap-1">
          <span class="text-xs font-medium text-gray-200">{amsName}</span>
          {isMultiNozzle && nozzleLabel && (
            <span class={`px-1 py-0.5 text-xs rounded ${
              nozzleLabel === "L" ? "bg-blue-600 text-white" : "bg-purple-600 text-white"
            }`}>
              {nozzleLabel}
            </span>
          )}
        </div>
        <div class="flex items-center gap-1 text-[10px] text-gray-400">
          {temperatureStr && (
            <span title="Temperature">{temperatureStr}</span>
          )}
          <div class="flex items-center gap-0.5" title={`Humidity: ${humidityStr}`}>
            <img
              src={`/images/ams/ams_humidity_${humidity.icon}.svg`}
              alt="Humidity"
              class="w-3 h-3 opacity-80"
            />
            <span>{humidityStr}</span>
          </div>
        </div>
      </div>

      {/* Spool icon */}
      <div class="flex flex-col items-center justify-center py-2 bg-[#252525]">
        <div class={`rounded-full p-0.5 ${isActive ? "ring-2 ring-green-400 ring-offset-1 ring-offset-[#252525]" : ""}`}>
          <SpoolIcon color={color} isEmpty={isEmpty} size={40} />
        </div>
        {isActive && (
          <div class="w-1.5 h-1.5 rounded-full bg-green-400 mt-1" title="Active" />
        )}
      </div>

      {/* AMS HT image */}
      <div class="relative flex justify-center">
        <img
          src="/images/ams/amsht.png"
          alt="AMS HT"
          class="h-32 object-contain"
          style={{ filter: "brightness(0.9)" }}
        />
      </div>

      {/* Material label with K value and fill level */}
      <div class="flex flex-col items-center px-2 py-2 bg-[#1a1a1a]">
        {/* Slot menu button */}
        {hasControls && (
          <div class="self-end mb-0.5">
            <SlotMenu
              printerSerial={printerSerial!}
              amsId={unit.id}
              trayId={0}
              calibrations={calibrations}
              currentKValue={kValue ?? null}
            />
          </div>
        )}
        <span
          class="text-xs font-medium truncate"
          style={{ color: isEmpty ? "#666" : color }}
          title={material}
        >
          {isEmpty ? "-" : material}
        </span>
        {!isEmpty && kValue !== null && kValue !== undefined && (
          <span class="text-[10px] text-gray-500" title="K value (pressure advance)">
            K:{kValue.toFixed(3)}
          </span>
        )}
        {!isEmpty && remain !== null && remain !== undefined && remain >= 0 && (
          <div class="w-full mt-1">
            <FillLevelBar remain={remain} />
            <span class="text-[10px] text-gray-500 block text-center mt-0.5">{remain}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AmsCard({ unit, printerModel, numExtruders = 1, printerSerial, calibrations = [], trayNow }: AmsCardProps) {
  const isHt = isHtAms(unit.id);

  if (isHt) {
    return <HtAmsCard unit={unit} printerModel={printerModel} numExtruders={numExtruders} printerSerial={printerSerial} calibrations={calibrations} trayNow={trayNow} />;
  }

  return <RegularAmsCard unit={unit} printerModel={printerModel} numExtruders={numExtruders} printerSerial={printerSerial} calibrations={calibrations} trayNow={trayNow} />;
}

// External spool holder (Virtual Tray)
interface ExternalSpoolProps {
  tray: AmsTray | null;
  position?: "left" | "right";
  numExtruders?: number;
  printerSerial?: string;
  calibrations?: CalibrationProfile[];
}

export function ExternalSpool({ tray, position, numExtruders = 1, printerSerial, calibrations = [] }: ExternalSpoolProps) {
  if (!tray || isTrayEmpty(tray)) {
    return null;
  }

  const color = trayColorToCSS(tray.tray_color);
  const label = numExtruders === 1
    ? "External"
    : (position === "left" ? "External L" : "External R");
  const kValue = tray.k_value;
  const remain = tray.remain;
  const hasControls = !!printerSerial;
  // External tray uses ams_id 255 (or 254 for left on dual nozzle)
  const amsId = numExtruders === 1 ? 255 : (position === "left" ? 254 : 255);

  return (
    <div class="bg-[#1e1e1e] rounded-lg overflow-hidden" style={{ width: 100 }}>
      <div class="px-2 py-1.5 bg-[#2a2a2a] flex items-center justify-between">
        <span class="text-xs font-medium text-gray-200">{label}</span>
        {hasControls && (
          <SlotMenu
            printerSerial={printerSerial!}
            amsId={amsId}
            trayId={0}
            calibrations={calibrations}
            currentKValue={kValue ?? null}
          />
        )}
      </div>
      <div class="flex flex-col items-center py-3 gap-1 px-2">
        <SpoolIcon color={color} isEmpty={false} size={44} />
        <span class="text-xs font-medium" style={{ color }}>
          {tray.tray_type}
        </span>
        {kValue !== null && kValue !== undefined && (
          <span class="text-[10px] text-gray-500" title="K value (pressure advance)">
            K:{kValue.toFixed(3)}
          </span>
        )}
        {remain !== null && remain !== undefined && remain >= 0 && (
          <div class="w-full">
            <FillLevelBar remain={remain} />
            <span class="text-[10px] text-gray-500 block text-center mt-0.5">{remain}%</span>
          </div>
        )}
      </div>
    </div>
  );
}
