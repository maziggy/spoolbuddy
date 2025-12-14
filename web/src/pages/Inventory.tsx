import { useEffect, useState, useCallback } from "preact/hooks";
import { api, Spool, SpoolInput, SpoolsInPrinters } from "../lib/api";
import {
  SpoolsTable,
  StatsBar,
  AddSpoolModal,
  DeleteModal,
  ColumnConfigModal,
  getDefaultColumns,
  ColumnConfig,
} from "../components/inventory";
import { Plus } from "lucide-preact";

const COLUMN_CONFIG_KEY = "spoolbuddy-column-config";

function loadColumnConfig(): ColumnConfig[] {
  try {
    const stored = localStorage.getItem(COLUMN_CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ColumnConfig[];
      // Validate and merge with defaults (in case new columns were added)
      const defaults = getDefaultColumns();
      const defaultIds = new Set(defaults.map((c) => c.id));
      const storedIds = new Set(parsed.map((c) => c.id));

      // Keep stored columns that still exist
      const validStored = parsed.filter((c) => defaultIds.has(c.id));

      // Add any new columns that weren't in stored config
      const newColumns = defaults.filter((c) => !storedIds.has(c.id));

      return [...validStored, ...newColumns];
    }
  } catch {
    // Ignore errors
  }
  return getDefaultColumns();
}

function saveColumnConfig(config: ColumnConfig[]) {
  try {
    localStorage.setItem(COLUMN_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Ignore errors
  }
}

export function Inventory() {
  const [spools, setSpools] = useState<Spool[]>([]);
  const [spoolsInPrinters] = useState<SpoolsInPrinters>({}); // TODO: Get from printer state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editSpool, setEditSpool] = useState<Spool | null>(null);
  const [deleteSpool, setDeleteSpool] = useState<Spool | null>(null);
  const [showColumnModal, setShowColumnModal] = useState(false);

  // Column configuration
  const [columnConfig, setColumnConfig] = useState<ColumnConfig[]>(loadColumnConfig);

  const loadSpools = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listSpools();
      setSpools(data);
    } catch (e) {
      console.error("Failed to load spools:", e);
      setError(e instanceof Error ? e.message : "Failed to load spools");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSpools();
  }, [loadSpools]);

  const handleAddSpool = async (input: SpoolInput) => {
    await api.createSpool(input);
    await loadSpools();
  };

  const handleEditSpool = async (input: SpoolInput) => {
    if (!editSpool) return;
    await api.updateSpool(editSpool.id, input);
    await loadSpools();
  };

  const handleDeleteSpool = async (spool: Spool) => {
    await api.deleteSpool(spool.id);
    await loadSpools();
  };

  const handleColumnConfigSave = (config: ColumnConfig[]) => {
    setColumnConfig(config);
    saveColumnConfig(config);
  };

  return (
    <div class="space-y-6">
      {/* Header */}
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-3xl font-bold text-[var(--text-primary)]">Inventory</h1>
          <p class="text-[var(--text-secondary)]">Manage your filament spools</p>
        </div>
        <button onClick={() => setShowAddModal(true)} class="btn btn-primary">
          <Plus class="w-5 h-5" />
          <span>Add Spool</span>
        </button>
      </div>

      {/* Error message */}
      {error && (
        <div class="p-4 bg-[var(--error-color)]/10 border border-[var(--error-color)]/30 rounded-lg text-[var(--error-color)]">
          {error}
        </div>
      )}

      {/* Stats */}
      {!loading && spools.length > 0 && (
        <StatsBar spools={spools} spoolsInPrinters={spoolsInPrinters} />
      )}

      {/* Loading state */}
      {loading ? (
        <div class="card p-12 text-center text-[var(--text-muted)]">
          Loading...
        </div>
      ) : (
        /* Spools table */
        <SpoolsTable
          spools={spools}
          spoolsInPrinters={spoolsInPrinters}
          columnConfig={columnConfig}
          onEditSpool={(spool) => setEditSpool(spool)}
          onDeleteSpool={(spool) => setDeleteSpool(spool)}
          onOpenColumns={() => setShowColumnModal(true)}
        />
      )}

      {/* Add Spool Modal */}
      <AddSpoolModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSave={handleAddSpool}
      />

      {/* Edit Spool Modal */}
      <AddSpoolModal
        isOpen={!!editSpool}
        onClose={() => setEditSpool(null)}
        onSave={handleEditSpool}
        editSpool={editSpool}
      />

      {/* Delete Confirmation Modal */}
      <DeleteModal
        isOpen={!!deleteSpool}
        onClose={() => setDeleteSpool(null)}
        spool={deleteSpool}
        onDelete={handleDeleteSpool}
      />

      {/* Column Configuration Modal */}
      <ColumnConfigModal
        isOpen={showColumnModal}
        onClose={() => setShowColumnModal(false)}
        columns={columnConfig}
        onSave={handleColumnConfigSave}
      />
    </div>
  );
}
