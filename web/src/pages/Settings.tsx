import { useWebSocket } from "../lib/websocket";
import { api } from "../lib/api";

export function Settings() {
  const { deviceConnected, currentWeight } = useWebSocket();

  const handleTare = async () => {
    try {
      await api.tareScale();
    } catch (e) {
      console.error("Failed to tare:", e);
      alert("Failed to tare scale");
    }
  };

  return (
    <div class="space-y-6">
      {/* Header */}
      <div>
        <h1 class="text-3xl font-bold text-gray-900">Settings</h1>
        <p class="text-gray-600">Configure SpoolBuddy</p>
      </div>

      {/* Device settings */}
      <div class="bg-white rounded-lg shadow">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-medium text-gray-900">Device</h2>
        </div>
        <div class="p-6 space-y-6">
          {/* Connection status */}
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-medium text-gray-900">Connection Status</h3>
              <p class="text-sm text-gray-500">
                SpoolBuddy device connection
              </p>
            </div>
            <span
              class={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                deviceConnected
                  ? "bg-green-100 text-green-800"
                  : "bg-red-100 text-red-800"
              }`}
            >
              {deviceConnected ? "Connected" : "Disconnected"}
            </span>
          </div>

          {/* Scale */}
          <div class="border-t border-gray-200 pt-6">
            <h3 class="text-sm font-medium text-gray-900">Scale</h3>
            <div class="mt-4 flex items-center justify-between">
              <div>
                <p class="text-sm text-gray-500">Current reading</p>
                <p class="text-2xl font-mono">
                  {currentWeight !== null ? `${currentWeight.toFixed(1)}g` : "--"}
                </p>
              </div>
              <div class="space-x-3">
                <button
                  onClick={handleTare}
                  disabled={!deviceConnected}
                  class="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Tare Scale
                </button>
                <button
                  disabled={!deviceConnected}
                  class="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Calibrate
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Server settings */}
      <div class="bg-white rounded-lg shadow">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-medium text-gray-900">Server</h2>
        </div>
        <div class="p-6 space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-medium text-gray-900">Version</h3>
              <p class="text-sm text-gray-500">SpoolBuddy server version</p>
            </div>
            <span class="text-sm font-mono text-gray-600">0.1.0</span>
          </div>
          <div class="border-t border-gray-200 pt-4">
            <div>
              <h3 class="text-sm font-medium text-gray-900">Database</h3>
              <p class="text-sm text-gray-500">SQLite database for spool inventory</p>
            </div>
          </div>
        </div>
      </div>

      {/* About */}
      <div class="bg-white rounded-lg shadow">
        <div class="px-6 py-4 border-b border-gray-200">
          <h2 class="text-lg font-medium text-gray-900">About</h2>
        </div>
        <div class="p-6">
          <p class="text-sm text-gray-600">
            SpoolBuddy is a filament management system for Bambu Lab 3D printers.
          </p>
          <p class="mt-2 text-sm text-gray-600">
            Based on{" "}
            <a
              href="https://github.com/yanshay/SpoolEase"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary-600 hover:text-primary-700"
            >
              SpoolEase
            </a>{" "}
            by yanshay.
          </p>
          <div class="mt-4 flex space-x-4">
            <a
              href="https://github.com/maziggy/spoolbuddy"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-gray-500 hover:text-gray-700"
            >
              GitHub
            </a>
            <a
              href="https://github.com/maziggy/spoolbuddy/issues"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-gray-500 hover:text-gray-700"
            >
              Report Issue
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
