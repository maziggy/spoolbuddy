import { useEffect, useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { api, Spool, Printer } from "../lib/api";
import { useWebSocket } from "../lib/websocket";

export function Dashboard() {
  const [spools, setSpools] = useState<Spool[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const { deviceConnected, currentWeight, weightStable, currentTagId, printerStatuses, subscribe } = useWebSocket();
  const [currentSpool, setCurrentSpool] = useState<Spool | null>(null);

  useEffect(() => {
    loadSpools();
    loadPrinters();

    // Subscribe to events
    const unsubscribe = subscribe((message) => {
      if (message.type === "tag_detected" && message.spool) {
        setCurrentSpool(message.spool as Spool);
      } else if (message.type === "tag_removed") {
        setCurrentSpool(null);
      } else if (
        message.type === "printer_connected" ||
        message.type === "printer_disconnected"
      ) {
        loadPrinters();
      }
    });

    return unsubscribe;
  }, [subscribe]);

  const loadSpools = async () => {
    try {
      const data = await api.listSpools();
      setSpools(data);
    } catch (e) {
      console.error("Failed to load spools:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadPrinters = async () => {
    try {
      const data = await api.listPrinters();
      setPrinters(data);
    } catch (e) {
      console.error("Failed to load printers:", e);
    }
  };

  // Get effective connection status for a printer
  const isPrinterConnected = (printer: Printer) => {
    return printerStatuses.get(printer.serial) ?? printer.connected ?? false;
  };

  // Calculate stats
  const totalSpools = spools.length;
  const materials = new Set(spools.map((s) => s.material)).size;
  const brands = new Set(spools.filter((s) => s.brand).map((s) => s.brand)).size;

  return (
    <div class="space-y-6">
      {/* Page header */}
      <div>
        <h1 class="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p class="text-gray-600">Overview of your filament inventory</p>
      </div>

      {/* Stats cards */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="bg-white rounded-lg shadow p-6">
          <div class="flex items-center">
            <div class="p-3 bg-blue-100 rounded-full">
              <svg class="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <div class="ml-4">
              <p class="text-sm font-medium text-gray-500">Total Spools</p>
              <p class="text-2xl font-semibold text-gray-900">
                {loading ? "-" : totalSpools}
              </p>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-lg shadow p-6">
          <div class="flex items-center">
            <div class="p-3 bg-green-100 rounded-full">
              <svg class="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
              </svg>
            </div>
            <div class="ml-4">
              <p class="text-sm font-medium text-gray-500">Materials</p>
              <p class="text-2xl font-semibold text-gray-900">
                {loading ? "-" : materials}
              </p>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-lg shadow p-6">
          <div class="flex items-center">
            <div class="p-3 bg-purple-100 rounded-full">
              <svg class="w-8 h-8 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div class="ml-4">
              <p class="text-sm font-medium text-gray-500">Brands</p>
              <p class="text-2xl font-semibold text-gray-900">
                {loading ? "-" : brands}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Printer status */}
      {printers.length > 0 && (
        <div class="bg-white rounded-lg shadow p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">Printers</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {printers.map((printer) => (
              <div key={printer.serial} class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <p class="font-medium text-gray-900">{printer.name || printer.serial}</p>
                  <p class="text-sm text-gray-500">{printer.model}</p>
                </div>
                <span
                  class={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    isPrinterConnected(printer)
                      ? "bg-green-100 text-green-800"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {isPrinterConnected(printer) ? "Connected" : "Offline"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Device status & current spool */}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Device status */}
        <div class="bg-white rounded-lg shadow p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">SpoolBuddy Device</h2>
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <span class="text-gray-600">Connection</span>
              <span
                class={`px-3 py-1 rounded-full text-sm font-medium ${
                  deviceConnected
                    ? "bg-green-100 text-green-800"
                    : "bg-red-100 text-red-800"
                }`}
              >
                {deviceConnected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-gray-600">Scale Weight</span>
              <span class="text-xl font-mono">
                {currentWeight !== null ? (
                  <>
                    {currentWeight.toFixed(1)}g
                    {weightStable && (
                      <span class="ml-2 text-green-600 text-sm">stable</span>
                    )}
                  </>
                ) : (
                  <span class="text-gray-400">--</span>
                )}
              </span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-gray-600">NFC Tag</span>
              <span class="font-mono text-sm">
                {currentTagId || <span class="text-gray-400">No tag</span>}
              </span>
            </div>
          </div>
        </div>

        {/* Current spool */}
        <div class="bg-white rounded-lg shadow p-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">Current Spool</h2>
          {currentSpool ? (
            <div class="space-y-3">
              <div class="flex items-center space-x-3">
                {currentSpool.rgba && (
                  <div
                    class="w-10 h-10 rounded-full border-2 border-gray-200"
                    style={{ backgroundColor: `#${currentSpool.rgba.slice(0, 6)}` }}
                  />
                )}
                <div>
                  <p class="font-medium text-gray-900">
                    {currentSpool.color_name || "Unknown color"}
                  </p>
                  <p class="text-sm text-gray-600">
                    {currentSpool.brand} {currentSpool.material}
                    {currentSpool.subtype && ` ${currentSpool.subtype}`}
                  </p>
                </div>
              </div>
              <Link
                href={`/spool/${currentSpool.id}`}
                class="inline-flex items-center text-primary-600 hover:text-primary-700"
              >
                View details
                <svg class="w-4 h-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          ) : (
            <p class="text-gray-500">
              {currentTagId
                ? "Unknown spool - not in inventory"
                : "Place a spool on the scale to identify it"}
            </p>
          )}
        </div>
      </div>

      {/* Quick actions */}
      <div class="bg-white rounded-lg shadow p-6">
        <h2 class="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h2>
        <div class="flex flex-wrap gap-4">
          <Link
            href="/inventory"
            class="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
          >
            <svg class="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add Spool
          </Link>
          <Link
            href="/printers"
            class="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            <svg class="w-5 h-5 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Manage Printers
          </Link>
        </div>
      </div>
    </div>
  );
}
