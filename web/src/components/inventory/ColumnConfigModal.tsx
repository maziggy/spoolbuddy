import { useState, useEffect } from 'preact/hooks'
import { Modal } from './Modal'
import { GripVertical, Eye, EyeOff, ChevronUp, ChevronDown, RotateCcw } from 'lucide-preact'

export interface ColumnConfig {
  id: string
  label: string
  visible: boolean
}

interface ColumnConfigModalProps {
  isOpen: boolean
  onClose: () => void
  columns: ColumnConfig[]
  onSave: (columns: ColumnConfig[]) => void
}

const defaultColumns: ColumnConfig[] = [
  // Required
  { id: 'id', label: 'ID', visible: true },
  // Date columns
  { id: 'added_time', label: 'Added', visible: false },
  { id: 'encode_time', label: 'Encoded', visible: false },
  // Visual/Identity
  { id: 'rgba', label: 'Color', visible: true },
  { id: 'material', label: 'Material', visible: true },
  { id: 'subtype', label: 'Subtype', visible: true },
  { id: 'color_name', label: 'Color Name', visible: false },
  { id: 'brand', label: 'Brand', visible: true },
  { id: 'slicer_filament', label: 'Slicer Filament', visible: false },
  { id: 'location', label: 'Location', visible: true },
  // Weight columns
  { id: 'label_weight', label: 'Label', visible: true },
  { id: 'net', label: 'Net', visible: true },
  { id: 'gross', label: 'Gross', visible: false },
  { id: 'added_full', label: 'Full', visible: false },
  { id: 'used', label: 'Used', visible: false },
  { id: 'printed_total', label: 'Printed Total', visible: false },
  { id: 'printed_since_weight', label: 'Printed Since Weight', visible: false },
  // Other info
  { id: 'note', label: 'Note', visible: false },
  { id: 'pa_k', label: 'PA(K)', visible: true },
  { id: 'tag_id', label: 'Tag ID', visible: false },
  { id: 'data_origin', label: 'Data Origin', visible: false },
  { id: 'tag_type', label: 'Linked Tag Type', visible: false },
  // Extra visual columns
  { id: 'remaining', label: 'Remaining', visible: true },
  { id: 'scale', label: 'Scale', visible: false },
  // Required
  { id: 'actions', label: 'Actions', visible: true },
]

export function getDefaultColumns(): ColumnConfig[] {
  return defaultColumns.map(c => ({ ...c }))
}

export function ColumnConfigModal({ isOpen, onClose, columns, onSave }: ColumnConfigModalProps) {
  const [localColumns, setLocalColumns] = useState<ColumnConfig[]>(columns)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  useEffect(() => {
    if (isOpen) {
      setLocalColumns(columns.map(c => ({ ...c })))
    }
  }, [isOpen, columns])

  const toggleVisibility = (index: number) => {
    setLocalColumns(prev => prev.map((col, i) =>
      i === index ? { ...col, visible: !col.visible } : col
    ))
  }

  const moveColumn = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= localColumns.length) return

    setLocalColumns(prev => {
      const newColumns = [...prev]
      const [moved] = newColumns.splice(fromIndex, 1)
      newColumns.splice(toIndex, 0, moved)
      return newColumns
    })
  }

  const handleDragStart = (index: number) => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== index) {
      moveColumn(draggedIndex, index)
      setDraggedIndex(index)
    }
  }

  const handleDragEnd = () => {
    setDraggedIndex(null)
  }

  const resetToDefaults = () => {
    setLocalColumns(getDefaultColumns())
  }

  const handleSave = () => {
    onSave(localColumns)
    onClose()
  }

  const visibleCount = localColumns.filter(c => c.visible).length

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Configure Columns"
      size="md"
      footer={
        <>
          <button class="btn" onClick={resetToDefaults}>
            <RotateCcw class="w-4 h-4" />
            Reset
          </button>
          <div class="flex-1" />
          <button class="btn" onClick={onClose}>
            Cancel
          </button>
          <button class="btn btn-primary" onClick={handleSave}>
            Apply Changes
          </button>
        </>
      }
    >
      <p class="text-sm text-[var(--text-secondary)] mb-4">
        Drag to reorder columns or use arrows. Toggle visibility with the eye icon.
        <span class="ml-2 text-[var(--text-muted)]">
          ({visibleCount} of {localColumns.length} visible)
        </span>
      </p>

      <div class="space-y-1">
        {localColumns.map((column, index) => (
          <div
            key={column.id}
            class={`flex items-center gap-2 p-2 rounded-lg border transition-colors ${
              draggedIndex === index
                ? 'border-[var(--accent-color)] bg-[var(--accent-color)]/10'
                : 'border-[var(--border-color)] bg-[var(--bg-tertiary)]'
            } ${!column.visible ? 'opacity-50' : ''}`}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e as DragEvent, index)}
            onDragEnd={handleDragEnd}
          >
            {/* Drag Handle */}
            <div class="cursor-grab text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
              <GripVertical class="w-4 h-4" />
            </div>

            {/* Column Name */}
            <span class="flex-1 font-medium text-sm">
              {column.label}
            </span>

            {/* Move Buttons */}
            <div class="flex items-center gap-1">
              <button
                onClick={() => moveColumn(index, index - 1)}
                disabled={index === 0}
                class="p-1 rounded hover:bg-[var(--bg-secondary)] disabled:opacity-30 disabled:cursor-not-allowed"
                title="Move up"
              >
                <ChevronUp class="w-4 h-4" />
              </button>
              <button
                onClick={() => moveColumn(index, index + 1)}
                disabled={index === localColumns.length - 1}
                class="p-1 rounded hover:bg-[var(--bg-secondary)] disabled:opacity-30 disabled:cursor-not-allowed"
                title="Move down"
              >
                <ChevronDown class="w-4 h-4" />
              </button>
            </div>

            {/* Visibility Toggle */}
            <button
              onClick={() => toggleVisibility(index)}
              class={`p-1.5 rounded transition-colors ${
                column.visible
                  ? 'text-[var(--success-color)] hover:bg-[var(--success-color)]/10'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-secondary)]'
              }`}
              title={column.visible ? 'Hide column' : 'Show column'}
            >
              {column.visible ? <Eye class="w-4 h-4" /> : <EyeOff class="w-4 h-4" />}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
