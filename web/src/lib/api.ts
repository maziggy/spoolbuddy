const API_BASE = "/api";

export interface Spool {
  id: string;
  tag_id: string | null;
  material: string;
  subtype: string | null;
  color_name: string | null;
  rgba: string | null;
  brand: string | null;
  label_weight: number;
  core_weight: number;
  weight_new: number | null;
  weight_current: number | null;
  slicer_filament: string | null;
  note: string | null;
  added_time: string | null;  // Unix timestamp as string for compat
  encode_time: string | null; // Unix timestamp as string for compat
  added_full: boolean | null;
  consumed_since_add: number;
  consumed_since_weight: number;
  weight_used: number;        // For tracking manual used weight
  data_origin: string | null;
  tag_type: string | null;
  ext_has_k: boolean;         // Whether has pressure advance K calibration
  created_at: number | null;
  updated_at: number | null;
}

// Map for tracking which spools are in which printers
export type SpoolsInPrinters = Record<string, string>;

export interface SpoolInput {
  tag_id?: string | null;
  material: string;
  subtype?: string | null;
  color_name?: string | null;
  rgba?: string | null;
  brand?: string | null;
  label_weight?: number | null;
  core_weight?: number | null;
  weight_new?: number | null;
  weight_current?: number | null;
  slicer_filament?: string | null;
  note?: string | null;
  data_origin?: string | null;
  tag_type?: string | null;
}

export interface Printer {
  serial: string;
  name: string | null;
  model: string | null;
  ip_address: string | null;
  access_code: string | null;
  last_seen: number | null;
  config: string | null;
  auto_connect: boolean | null;
  connected?: boolean;
}

export interface PrinterInput {
  serial: string;
  name?: string | null;
  model?: string | null;
  ip_address?: string | null;
  access_code?: string | null;
}

export interface SetSlotRequest {
  ams_id: number;
  tray_id: number;
  tray_info_idx: string;
  tray_type: string;
  tray_color: string;
  nozzle_temp_min: number;
  nozzle_temp_max: number;
}

export interface DeviceStatus {
  connected: boolean;
  last_weight: number | null;
  weight_stable: boolean;
  current_tag_id: string | null;
}

export interface DiscoveryStatus {
  running: boolean;
}

export interface DiscoveredPrinter {
  serial: string;
  name: string | null;
  ip_address: string;
  model: string | null;
}

class ApiClient {
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `HTTP ${response.status}`);
    }

    // Handle 204 No Content or empty body
    if (response.status === 204) {
      return undefined as T;
    }

    // Check if response has content before parsing JSON
    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    return JSON.parse(text);
  }

  // Spools
  async listSpools(params?: {
    material?: string;
    brand?: string;
    search?: string;
  }): Promise<Spool[]> {
    const searchParams = new URLSearchParams();
    if (params?.material) searchParams.set("material", params.material);
    if (params?.brand) searchParams.set("brand", params.brand);
    if (params?.search) searchParams.set("search", params.search);

    const query = searchParams.toString();
    return this.request<Spool[]>(`/spools${query ? `?${query}` : ""}`);
  }

  async getSpool(id: string): Promise<Spool> {
    return this.request<Spool>(`/spools/${id}`);
  }

  async createSpool(input: SpoolInput): Promise<Spool> {
    return this.request<Spool>("/spools", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateSpool(id: string, input: SpoolInput): Promise<Spool> {
    return this.request<Spool>(`/spools/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deleteSpool(id: string): Promise<void> {
    return this.request<void>(`/spools/${id}`, {
      method: "DELETE",
    });
  }

  // Printers
  async listPrinters(): Promise<Printer[]> {
    return this.request<Printer[]>("/printers");
  }

  async getPrinter(serial: string): Promise<Printer> {
    return this.request<Printer>(`/printers/${serial}`);
  }

  async createPrinter(input: PrinterInput): Promise<Printer> {
    return this.request<Printer>("/printers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updatePrinter(serial: string, input: Partial<PrinterInput>): Promise<Printer> {
    return this.request<Printer>(`/printers/${serial}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async deletePrinter(serial: string): Promise<void> {
    return this.request<void>(`/printers/${serial}`, {
      method: "DELETE",
    });
  }

  async connectPrinter(serial: string): Promise<void> {
    return this.request<void>(`/printers/${serial}/connect`, {
      method: "POST",
    });
  }

  async disconnectPrinter(serial: string): Promise<void> {
    return this.request<void>(`/printers/${serial}/disconnect`, {
      method: "POST",
    });
  }

  async setSlotFilament(serial: string, request: SetSlotRequest): Promise<void> {
    return this.request<void>(`/printers/${serial}/set-slot`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async setAutoConnect(serial: string, autoConnect: boolean): Promise<Printer> {
    return this.request<Printer>(`/printers/${serial}/auto-connect`, {
      method: "POST",
      body: JSON.stringify({ auto_connect: autoConnect }),
    });
  }

  // Device
  async getDeviceStatus(): Promise<DeviceStatus> {
    return this.request<DeviceStatus>("/device/status");
  }

  async tareScale(): Promise<void> {
    return this.request<void>("/device/tare", { method: "POST" });
  }

  async writeTag(spoolId: string): Promise<void> {
    return this.request<void>("/device/write-tag", {
      method: "POST",
      body: JSON.stringify({ spool_id: spoolId }),
    });
  }

  // Discovery
  async getDiscoveryStatus(): Promise<DiscoveryStatus> {
    return this.request<DiscoveryStatus>("/discovery/status");
  }

  async startDiscovery(): Promise<DiscoveryStatus> {
    return this.request<DiscoveryStatus>("/discovery/start", {
      method: "POST",
    });
  }

  async stopDiscovery(): Promise<DiscoveryStatus> {
    return this.request<DiscoveryStatus>("/discovery/stop", {
      method: "POST",
    });
  }

  async getDiscoveredPrinters(): Promise<DiscoveredPrinter[]> {
    return this.request<DiscoveredPrinter[]>("/discovery/printers");
  }
}

export const api = new ApiClient();
