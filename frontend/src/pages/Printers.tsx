import { useEffect, useState } from "preact/hooks";
import { api, Printer, DiscoveredPrinter, CalibrationProfile } from "../lib/api";
import { useWebSocket } from "../lib/websocket";
import { AmsCard, ExternalSpool } from "../components/AmsCard";

export function Printers() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDiscoverModal, setShowDiscoverModal] = useState(false);
  const [selectedDiscovered, setSelectedDiscovered] = useState<DiscoveredPrinter | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null); // serial to delete
  const [connecting, setConnecting] = useState<string | null>(null); // serial being connected
  const [calibrations, setCalibrations] = useState<Record<string, CalibrationProfile[]>>({}); // serial -> calibrations

  const { printerStatuses, printerStates, subscribe } = useWebSocket();

  // Fetch calibrations for a connected printer
  const fetchCalibrations = async (serial: string) => {
    try {
      const cals = await api.getCalibrations(serial);
      setCalibrations(prev => ({ ...prev, [serial]: cals }));
    } catch (e) {
      console.error(`Failed to fetch calibrations for ${serial}:`, e);
    }
  };

  useEffect(() => {
    loadPrinters();

    // Subscribe to WebSocket messages for real-time updates
    const unsubscribe = subscribe((message) => {
      if (
        message.type === "printer_connected" ||
        message.type === "printer_disconnected" ||
        message.type === "printer_added" ||
        message.type === "printer_updated" ||
        message.type === "printer_removed"
      ) {
        loadPrinters();
        setConnecting(null);

        // Fetch calibrations when printer connects
        if (message.type === "printer_connected" && message.serial) {
          fetchCalibrations(message.serial as string);
        }
      }
    });

    return unsubscribe;
  }, [subscribe]);

  // Fetch calibrations for already connected printers on mount
  useEffect(() => {
    printers.forEach(printer => {
      const connected = printerStatuses.get(printer.serial) ?? printer.connected ?? false;
      if (connected && !calibrations[printer.serial]) {
        fetchCalibrations(printer.serial);
      }
    });
  }, [printers, printerStatuses]);

  const loadPrinters = async () => {
    try {
      const data = await api.listPrinters();
      setPrinters(data);
    } catch (e) {
      console.error("Failed to load printers:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (serial: string) => {
    setDeleteConfirm(serial);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;

    const serial = deleteConfirm;
    setDeleteConfirm(null);

    try {
      await api.deletePrinter(serial);
      await loadPrinters();
    } catch (e) {
      console.error("Failed to delete printer:", e);
      alert(`Failed to delete printer: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleConnect = async (serial: string) => {
    console.log("Connecting to printer:", serial);
    setConnecting(serial);
    try {
      await api.connectPrinter(serial);
      console.log("Connect request sent");
      // The WebSocket will notify us when connection is established
    } catch (e) {
      console.error("Failed to connect:", e);
      setConnecting(null);
      alert(`Failed to connect: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleDisconnect = async (serial: string) => {
    console.log("Disconnecting from printer:", serial);
    try {
      await api.disconnectPrinter(serial);
      console.log("Disconnect request sent");
    } catch (e) {
      console.error("Failed to disconnect:", e);
      alert(`Failed to disconnect: ${e instanceof Error ? e.message : e}`);
    }
  };

  const handleAutoConnectToggle = async (serial: string, currentValue: boolean) => {
    try {
      await api.setAutoConnect(serial, !currentValue);
      // Reload to update state
      await loadPrinters();
    } catch (e) {
      console.error("Failed to toggle auto-connect:", e);
      alert(`Failed to toggle auto-connect: ${e instanceof Error ? e.message : e}`);
    }
  };

  // Get effective connection status (from WebSocket or API)
  const isConnected = (printer: Printer) => {
    return printerStatuses.get(printer.serial) ?? printer.connected ?? false;
  };

  return (
    <div class="space-y-6">
      {/* Header */}
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-gray-900">Printers</h1>
          <p class="text-gray-600">Manage your Bambu Lab printers</p>
        </div>
        <div class="flex space-x-3">
          <button
            onClick={() => setShowDiscoverModal(true)}
            class="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            <svg class="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            Discover
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            class="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
          >
            <svg class="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add Printer
          </button>
        </div>
      </div>

      {/* Printer list */}
      <div class="bg-white rounded-lg shadow">
        {loading ? (
          <div class="p-8 text-center text-gray-500">Loading...</div>
        ) : printers.length === 0 ? (
          <div class="p-8 text-center">
            <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            <h3 class="mt-2 text-sm font-medium text-gray-900">No printers</h3>
            <p class="mt-1 text-sm text-gray-500">
              Add a printer to get started with automatic AMS configuration.
            </p>
            <div class="mt-6">
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
              >
                <svg class="-ml-1 mr-2 h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                Add Printer
              </button>
            </div>
          </div>
        ) : (
          <ul class="divide-y divide-gray-200">
            {printers.map((printer) => {
              const state = printerStates.get(printer.serial);
              const connected = isConnected(printer);
              const isMultiNozzle = printer.model && ["H2C", "H2D"].includes(printer.model.toUpperCase());

              return (
                <li key={printer.serial} class="p-6 hover:bg-gray-50">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center">
                      <div class="flex-shrink-0">
                        <svg class="h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                        </svg>
                      </div>
                      <div class="ml-4">
                        <p class="text-sm font-medium text-gray-900">
                          {printer.name || printer.serial}
                        </p>
                        <p class="text-sm text-gray-500">
                          {printer.model || "Unknown Model"} &bull; {printer.ip_address || "No IP"}
                        </p>
                        <p class="text-xs text-gray-400 font-mono">{printer.serial}</p>
                      </div>
                    </div>
                    <div class="flex items-center space-x-4">
                      {/* Auto-connect toggle */}
                      <button
                        onClick={() => handleAutoConnectToggle(printer.serial, printer.auto_connect ?? false)}
                        class="flex items-center space-x-2 text-sm"
                        title={printer.auto_connect ? "Disable auto-connect" : "Enable auto-connect"}
                      >
                        <span class={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          printer.auto_connect ? "bg-primary-600" : "bg-gray-200"
                        }`}>
                          <span class={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            printer.auto_connect ? "translate-x-4" : "translate-x-0"
                          }`} />
                        </span>
                        <span class="text-xs text-gray-500">Auto</span>
                      </button>
                      {connecting === printer.serial ? (
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                          <svg class="animate-spin -ml-0.5 mr-1.5 h-3 w-3" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Connecting...
                        </span>
                      ) : (
                        <span
                          class={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            connected
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {connected ? "Connected" : "Offline"}
                        </span>
                      )}
                      {!connected && connecting !== printer.serial && (
                        <button
                          onClick={() => handleConnect(printer.serial)}
                          class="text-primary-600 hover:text-primary-700 text-sm font-medium"
                        >
                          Connect
                        </button>
                      )}
                      {connected && (
                        <button
                          onClick={() => handleDisconnect(printer.serial)}
                          class="text-gray-600 hover:text-gray-700 text-sm font-medium"
                        >
                          Disconnect
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(printer.serial)}
                        class="text-red-600 hover:text-red-700"
                      >
                        <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* AMS Section - shown when connected */}
                  {connected && state && state.ams_units && state.ams_units.length > 0 && (
                    <div class="mt-4 pt-4 border-t border-gray-100">
                      <div class="flex flex-wrap gap-3">
                        {state.ams_units.map((unit) => (
                          <AmsCard
                            key={unit.id}
                            unit={unit}
                            printerModel={printer.model || undefined}
                            numExtruders={isMultiNozzle ? 2 : 1}
                            printerSerial={printer.serial}
                            calibrations={calibrations[printer.serial] || []}
                            trayNow={state.tray_now}
                          />
                        ))}
                        {state.vt_tray && (
                          <ExternalSpool
                            tray={state.vt_tray}
                            numExtruders={isMultiNozzle ? 2 : 1}
                            printerSerial={printer.serial}
                            calibrations={calibrations[printer.serial] || []}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Print status - shown when printing */}
                  {connected && state && state.gcode_state && state.gcode_state !== "IDLE" && (
                    <div class="mt-3 pt-3 border-t border-gray-100">
                      <div class="flex items-center gap-4">
                        <div class="flex-1">
                          <div class="flex items-center justify-between text-sm">
                            <span class="text-gray-600">{state.subtask_name || "Printing"}</span>
                            <span class="font-medium text-gray-900">{state.print_progress ?? 0}%</span>
                          </div>
                          <div class="mt-1 w-full bg-gray-200 rounded-full h-2">
                            <div
                              class="bg-primary-600 h-2 rounded-full transition-all duration-300"
                              style={{ width: `${state.print_progress ?? 0}%` }}
                            />
                          </div>
                          {state.layer_num !== null && state.total_layer_num !== null && (
                            <p class="text-xs text-gray-500 mt-1">
                              Layer {state.layer_num} / {state.total_layer_num}
                            </p>
                          )}
                        </div>
                        <span class={`text-xs px-2 py-1 rounded-full ${
                          state.gcode_state === "RUNNING" ? "bg-blue-100 text-blue-700" :
                          state.gcode_state === "PAUSE" ? "bg-yellow-100 text-yellow-700" :
                          state.gcode_state === "FINISH" ? "bg-green-100 text-green-700" :
                          state.gcode_state === "FAILED" ? "bg-red-100 text-red-700" :
                          "bg-gray-100 text-gray-600"
                        }`}>
                          {state.gcode_state}
                        </span>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Info card */}
      <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div class="flex">
          <div class="flex-shrink-0">
            <svg class="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div class="ml-3">
            <h3 class="text-sm font-medium text-blue-800">Printer Connection</h3>
            <p class="mt-1 text-sm text-blue-700">
              SpoolBuddy connects to your Bambu Lab printers via MQTT over your local network.
              You'll need the printer's serial number, IP address, and access code (found in the printer's network settings).
            </p>
          </div>
        </div>
      </div>

      {/* Add printer modal */}
      {showAddModal && (
        <AddPrinterModal
          onClose={() => {
            setShowAddModal(false);
            setSelectedDiscovered(null);
          }}
          onCreated={() => {
            setShowAddModal(false);
            setSelectedDiscovered(null);
            loadPrinters();
          }}
          prefill={selectedDiscovered}
        />
      )}

      {/* Discover printers modal */}
      {showDiscoverModal && (
        <DiscoverModal
          onClose={() => setShowDiscoverModal(false)}
          onSelect={(printer) => {
            setSelectedDiscovered(printer);
            setShowDiscoverModal(false);
            setShowAddModal(true);
          }}
          existingSerials={printers.map(p => p.serial)}
        />
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (() => {
        const printerToDelete = printers.find(p => p.serial === deleteConfirm);
        return (
        <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div class="bg-white rounded-lg shadow-xl max-w-sm w-full mx-4">
            <div class="px-6 py-4 border-b border-gray-200">
              <h2 class="text-lg font-semibold text-gray-900">Delete Printer</h2>
            </div>
            <div class="px-6 py-4">
              <p class="text-sm text-gray-600">
                Are you sure you want to delete this printer? This action cannot be undone.
              </p>
              <div class="mt-3 p-3 bg-gray-50 rounded-md">
                <p class="text-sm font-medium text-gray-900">
                  {printerToDelete?.name || deleteConfirm}
                </p>
                {printerToDelete?.name && (
                  <p class="text-xs font-mono text-gray-500 mt-1">{deleteConfirm}</p>
                )}
              </div>
            </div>
            <div class="px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                class="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                class="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-red-600 hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

interface AddPrinterModalProps {
  onClose: () => void;
  onCreated: () => void;
  prefill?: DiscoveredPrinter | null;
}

// Try to detect model from printer name
function detectModelFromName(name: string): string | null {
  const lower = name.toLowerCase();

  // Check specific models first (longer matches before shorter)
  if (lower.includes("x1 carbon") || lower.includes("x1-carbon") || lower.includes("x1c")) return "X1-Carbon";
  if (lower.includes("x1e") || lower.includes("x1 e")) return "X1E";
  if (lower.includes("x1")) return "X1";
  if (lower.includes("a1 mini") || lower.includes("a1-mini") || lower.includes("a1mini")) return "A1-Mini";
  if (lower.includes("a1")) return "A1";
  if (lower.includes("p1s") || lower.includes("p1 s")) return "P1S";
  if (lower.includes("p1p") || lower.includes("p1 p")) return "P1P";
  if (lower.includes("p2s") || lower.includes("p2 s")) return "P2S";
  if (lower.includes("h2c") || lower.includes("h2 c")) return "H2C";
  if (lower.includes("h2d") || lower.includes("h2 d")) return "H2D";
  if (lower.includes("h2s") || lower.includes("h2 s")) return "H2S";

  return null;
}

function AddPrinterModal({ onClose, onCreated, prefill }: AddPrinterModalProps) {
  console.log("AddPrinterModal prefill:", prefill);

  // Try to get model from prefill, or detect from name
  const getInitialModel = () => {
    if (prefill?.model && prefill.model !== "Unknown") {
      return prefill.model;
    }
    // Fallback: detect from name
    if (prefill?.name) {
      const detected = detectModelFromName(prefill.name);
      if (detected) return detected;
    }
    return "";
  };

  const [serial, setSerial] = useState(prefill?.serial || "");
  const [name, setName] = useState(prefill?.name || "");
  const [model, setModel] = useState(getInitialModel());
  const [modelAutoDetected, setModelAutoDetected] = useState(!!getInitialModel());
  const [ipAddress, setIpAddress] = useState(prefill?.ip_address || "");
  const [accessCode, setAccessCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Auto-detect model when name changes
  const handleNameChange = (newName: string) => {
    setName(newName);
    const detected = detectModelFromName(newName);
    if (detected && !modelAutoDetected) {
      setModel(detected);
      setModelAutoDetected(true);
    }
  };

  // Reset auto-detection flag when user manually changes model
  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    setModelAutoDetected(false);
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");

    if (!serial.trim()) {
      setError("Serial number is required");
      return;
    }
    if (!model) {
      setError("Please select a model");
      return;
    }
    if (!ipAddress.trim()) {
      setError("IP address is required");
      return;
    }
    if (!accessCode.trim()) {
      setError("Access code is required");
      return;
    }

    setSaving(true);

    try {
      await api.createPrinter({
        serial: serial.trim(),
        name: name.trim() || null,
        model: model || null,
        ip_address: ipAddress.trim(),
        access_code: accessCode.trim(),
      });
      onCreated();
    } catch (e) {
      console.error("Failed to create printer:", e);
      setError(e instanceof Error ? e.message : "Failed to add printer");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-semibold text-gray-900">Add Printer</h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="px-6 py-4 space-y-4">
            {error && (
              <div class="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <div>
              <label class="block text-sm font-medium text-gray-700">
                Serial Number *
              </label>
              <input
                type="text"
                value={serial}
                onInput={(e) => setSerial((e.target as HTMLInputElement).value)}
                placeholder="e.g., 00M09A123456789"
                class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 font-mono"
              />
              <p class="mt-1 text-xs text-gray-500">
                Found in printer settings or on the label
              </p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700">
                Name
              </label>
              <input
                type="text"
                value={name}
                onInput={(e) => handleNameChange((e.target as HTMLInputElement).value)}
                placeholder="e.g., My X1 Carbon"
                class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700">
                Model {modelAutoDetected && <span class="text-xs text-green-600">(auto-detected)</span>}
              </label>
              <select
                value={model}
                onChange={(e) => handleModelChange((e.target as HTMLSelectElement).value)}
                class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="" disabled>Select model...</option>
                <option value="A1">A1</option>
                <option value="A1-Mini">A1 Mini</option>
                <option value="H2C">H2C</option>
                <option value="H2D">H2D</option>
                <option value="H2S">H2S</option>
                <option value="P1P">P1P</option>
                <option value="P1S">P1S</option>
                <option value="P2S">P2S</option>
                <option value="X1">X1</option>
                <option value="X1-Carbon">X1 Carbon</option>
                <option value="X1E">X1E</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700">
                IP Address *
              </label>
              <input
                type="text"
                value={ipAddress}
                onInput={(e) => setIpAddress((e.target as HTMLInputElement).value)}
                placeholder="e.g., 192.168.1.100"
                class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 font-mono"
              />
              <p class="mt-1 text-xs text-gray-500">
                Found in printer's network settings
              </p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700">
                Access Code *
              </label>
              <input
                type="password"
                value={accessCode}
                onInput={(e) => setAccessCode((e.target as HTMLInputElement).value)}
                placeholder="8-digit code"
                class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-primary-500 focus:border-primary-500 font-mono"
              />
              <p class="mt-1 text-xs text-gray-500">
                Found in printer's network settings (LAN Only Mode)
              </p>
            </div>
          </div>
          <div class="px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              class="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              class="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? "Adding..." : "Add Printer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DiscoverModalProps {
  onClose: () => void;
  onSelect: (printer: DiscoveredPrinter) => void;
  existingSerials: string[];
}

function DiscoverModal({ onClose, onSelect, existingSerials }: DiscoverModalProps) {
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([]);
  const [error, setError] = useState("");

  // Filter out already-added printers
  const newPrinters = discovered.filter(p => !existingSerials.includes(p.serial));

  const startDiscovery = async () => {
    setError("");
    setDiscovered([]);
    setDiscovering(true);

    try {
      await api.startDiscovery();
      // Poll for discovered printers
      const pollInterval = setInterval(async () => {
        try {
          const printers = await api.getDiscoveredPrinters();
          console.log("Discovered printers:", printers);
          setDiscovered(printers);
        } catch (e) {
          console.error("Failed to get discovered printers:", e);
        }
      }, 1000);

      // Stop after 10 seconds
      setTimeout(async () => {
        clearInterval(pollInterval);
        await api.stopDiscovery();
        setDiscovering(false);
        // Final fetch
        const printers = await api.getDiscoveredPrinters();
        setDiscovered(printers);
      }, 10000);
    } catch (e) {
      console.error("Failed to start discovery:", e);
      setError(e instanceof Error ? e.message : "Failed to start discovery");
      setDiscovering(false);
    }
  };

  useEffect(() => {
    startDiscovery();
    return () => {
      api.stopDiscovery();
    };
  }, []);

  return (
    <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-semibold text-gray-900">Discover Printers</h2>
        </div>
        <div class="px-6 py-4">
          {error && (
            <div class="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">
              {error}
            </div>
          )}

          {discovering && (
            <div class="flex items-center justify-center py-8">
              <svg class="animate-spin h-8 w-8 text-primary-600 mr-3" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span class="text-gray-600">Scanning network for Bambu Lab printers...</span>
            </div>
          )}

          {!discovering && newPrinters.length === 0 && (
            <div class="text-center py-8">
              <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p class="mt-2 text-sm text-gray-500">No new printers found on your network.</p>
              <p class="text-xs text-gray-400 mt-1">Make sure your printers are powered on and connected to the same network.</p>
              <button
                onClick={startDiscovery}
                class="mt-4 px-4 py-2 text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                Scan Again
              </button>
            </div>
          )}

          {newPrinters.length > 0 && (
            <ul class="divide-y divide-gray-200">
              {newPrinters.map((printer) => (
                <li
                  key={printer.serial}
                  class="py-4 flex items-center justify-between hover:bg-gray-50 cursor-pointer px-2 -mx-2 rounded"
                  onClick={() => onSelect(printer)}
                >
                  <div>
                    <p class="text-sm font-medium text-gray-900">
                      {printer.name || printer.serial}
                    </p>
                    <p class="text-sm text-gray-500">
                      {printer.model || "Unknown Model"} &bull; {printer.ip_address}
                    </p>
                    <p class="text-xs text-gray-400 font-mono">{printer.serial}</p>
                  </div>
                  <svg class="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                  </svg>
                </li>
              ))}
            </ul>
          )}

          {!discovering && newPrinters.length > 0 && (
            <div class="mt-4 text-center">
              <button
                onClick={startDiscovery}
                class="text-sm text-primary-600 hover:text-primary-700"
              >
                Scan Again
              </button>
            </div>
          )}
        </div>
        <div class="px-6 py-4 border-t border-gray-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            class="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
