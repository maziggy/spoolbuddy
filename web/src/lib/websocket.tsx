import { createContext, ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useCallback } from "preact/hooks";
import { signal } from "@preact/signals";

interface WebSocketState {
  deviceConnected: boolean;
  currentWeight: number | null;
  weightStable: boolean;
  currentTagId: string | null;
  printerStatuses: Map<string, boolean>;
}

interface WebSocketContextValue extends WebSocketState {
  subscribe: (handler: (message: WebSocketMessage) => void) => () => void;
}

interface WebSocketMessage {
  type: string;
  [key: string]: unknown;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// Global signals for reactive state
const deviceConnected = signal(false);
const currentWeight = signal<number | null>(null);
const weightStable = signal(false);
const currentTagId = signal<string | null>(null);
const printerStatuses = signal<Map<string, boolean>>(new Map());

export function WebSocketProvider({ children }: { children: ComponentChildren }) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<(message: WebSocketMessage) => void>>(new Set());
  const reconnectTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    // Determine WebSocket URL
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/ui`;

    console.log("Connecting to WebSocket:", wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected");
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected, reconnecting in 3s...");
      deviceConnected.value = false;
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        handleMessage(message);

        // Notify subscribers
        handlersRef.current.forEach((handler) => handler(message));
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
      }
    };
  }, []);

  const handleMessage = (message: WebSocketMessage) => {
    switch (message.type) {
      case "initial_state":
        if (message.device && typeof message.device === "object") {
          const device = message.device as {
            connected?: boolean;
            last_weight?: number;
            weight_stable?: boolean;
            current_tag_id?: string;
          };
          deviceConnected.value = device.connected ?? false;
          currentWeight.value = device.last_weight ?? null;
          weightStable.value = device.weight_stable ?? false;
          currentTagId.value = device.current_tag_id ?? null;
        }
        break;

      case "device_connected":
        deviceConnected.value = true;
        break;

      case "device_disconnected":
        deviceConnected.value = false;
        currentWeight.value = null;
        currentTagId.value = null;
        break;

      case "weight":
        currentWeight.value = message.grams as number;
        weightStable.value = message.stable as boolean;
        break;

      case "tag_detected":
        currentTagId.value = message.tag_id as string;
        break;

      case "tag_removed":
        currentTagId.value = null;
        break;

      case "printer_connected": {
        const serial = message.serial as string;
        const newMap = new Map(printerStatuses.value);
        newMap.set(serial, true);
        printerStatuses.value = newMap;
        break;
      }

      case "printer_disconnected": {
        const serial = message.serial as string;
        const newMap = new Map(printerStatuses.value);
        newMap.set(serial, false);
        printerStatuses.value = newMap;
        break;
      }

      case "printer_added":
      case "printer_updated":
      case "printer_removed":
        // These are handled by subscribers (e.g., Printers page)
        break;
    }
  };

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback((handler: (message: WebSocketMessage) => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const value: WebSocketContextValue = {
    deviceConnected: deviceConnected.value,
    currentWeight: currentWeight.value,
    weightStable: weightStable.value,
    currentTagId: currentTagId.value,
    printerStatuses: printerStatuses.value,
    subscribe,
  };

  return (
    <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>
  );
}

export function useWebSocket(): WebSocketContextValue {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error("useWebSocket must be used within a WebSocketProvider");
  }
  return context;
}
