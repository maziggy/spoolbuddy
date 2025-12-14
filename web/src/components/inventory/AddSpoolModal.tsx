import { useState, useEffect, useMemo } from 'preact/hooks'
import { Modal } from './Modal'
import { Spool, SpoolInput } from '../../lib/api'
import { X } from 'lucide-preact'
import { getFilamentOptions, COLOR_PRESETS } from './utils'

interface AddSpoolModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (input: SpoolInput) => Promise<void>
  editSpool?: Spool | null  // If provided, we're editing
}

interface SpoolFormData {
  material: string
  subtype: string
  brand: string
  color_name: string
  rgba: string
  label_weight: number
  core_weight: number
  slicer_filament: string
  note: string
}

const defaultFormData: SpoolFormData = {
  material: '',
  subtype: '',
  brand: '',
  color_name: '',
  rgba: '#cccccc',
  label_weight: 1000,
  core_weight: 250,
  slicer_filament: '',
  note: '',
}

const MATERIALS = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'PC', 'PA', 'PVA', 'HIPS']
const WEIGHTS = [250, 500, 750, 1000]
const CORE_WEIGHTS = [200, 220, 245, 250, 280]
const BRANDS = ['Bambu', 'PolyLite', 'PolyTerra', 'eSUN', 'Overture', 'Fiberon', 'SUNLU', 'Generic']

export function AddSpoolModal({ isOpen, onClose, onSave, editSpool }: AddSpoolModalProps) {
  const [formData, setFormData] = useState<SpoolFormData>(defaultFormData)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEditing = !!editSpool

  // Reset form when modal opens/closes or editSpool changes
  useEffect(() => {
    if (isOpen) {
      if (editSpool) {
        setFormData({
          material: editSpool.material || '',
          subtype: editSpool.subtype || '',
          brand: editSpool.brand || '',
          color_name: editSpool.color_name || '',
          rgba: editSpool.rgba ? (editSpool.rgba.startsWith('#') ? editSpool.rgba : `#${editSpool.rgba}`) : '#cccccc',
          label_weight: editSpool.label_weight || 1000,
          core_weight: editSpool.core_weight || 250,
          slicer_filament: editSpool.slicer_filament || '',
          note: editSpool.note || '',
        })
      } else {
        setFormData(defaultFormData)
      }
      setError(null)
    }
  }, [isOpen, editSpool])

  const updateField = <K extends keyof SpoolFormData>(key: K, value: SpoolFormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }

  const handleSubmit = async () => {
    if (!formData.material) {
      setError('Material is required')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const input: SpoolInput = {
        material: formData.material,
        subtype: formData.subtype || null,
        brand: formData.brand || null,
        color_name: formData.color_name || null,
        // Backend expects color WITHOUT # prefix (e.g., "FF0000" not "#FF0000")
        rgba: formData.rgba.replace('#', '') || null,
        label_weight: formData.label_weight,
        core_weight: formData.core_weight,
        slicer_filament: formData.slicer_filament || null,
        note: formData.note || null,
      }

      await onSave(input)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save spool')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Get filament options for dropdown
  const filamentOptions = useMemo(() => getFilamentOptions(), [])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Edit Spool' : 'Add New Spool'}
      size="lg"
      footer={
        <>
          <button class="btn" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button class="btn btn-primary" onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Spool'}
          </button>
        </>
      }
    >
      {error && (
        <div class="mb-4 p-3 bg-[var(--error-color)]/10 border border-[var(--error-color)]/30 rounded-lg text-[var(--error-color)] text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X class="w-4 h-4" /></button>
        </div>
      )}

      <div class="space-y-4">
        {/* ID and Tag ID (edit mode only) */}
        {isEditing && editSpool && (
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label">ID</label>
              <input
                type="text"
                class="input bg-[var(--bg-tertiary)]"
                value={editSpool.id}
                disabled
              />
            </div>
            <div>
              <label class="label">Tag ID</label>
              <input
                type="text"
                class="input bg-[var(--bg-tertiary)] font-mono text-sm"
                value={editSpool.tag_id || '-'}
                disabled
              />
            </div>
          </div>
        )}

        {/* Slicer Filament */}
        <div>
          <label class="label">Slicer Filament</label>
          <select
            class="select"
            value={formData.slicer_filament}
            onChange={(e) => updateField('slicer_filament', (e.target as HTMLSelectElement).value)}
          >
            <option value="">Select filament...</option>
            {filamentOptions.map(({ code, name }) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
          {formData.slicer_filament && (
            <p class="text-xs text-[var(--text-muted)] mt-1">Code: {formData.slicer_filament}</p>
          )}
        </div>

        {/* Brand and Label Weight */}
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label">Brand</label>
            <select
              class="select"
              value={formData.brand}
              onChange={(e) => updateField('brand', (e.target as HTMLSelectElement).value)}
            >
              <option value="">Select brand...</option>
              {BRANDS.map(brand => (
                <option key={brand} value={brand}>{brand}</option>
              ))}
            </select>
          </div>
          <div>
            <label class="label">Label Weight *</label>
            <select
              class="select"
              value={formData.label_weight}
              onChange={(e) => updateField('label_weight', parseInt((e.target as HTMLSelectElement).value))}
            >
              {WEIGHTS.map(w => (
                <option key={w} value={w}>{w >= 1000 ? `${w/1000}kg` : `${w}g`}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Material and Subtype */}
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label">Material *</label>
            <select
              class="select"
              value={formData.material}
              onChange={(e) => updateField('material', (e.target as HTMLSelectElement).value)}
            >
              <option value="">Select material...</option>
              {MATERIALS.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label class="label">Subtype</label>
            <input
              type="text"
              class="input"
              placeholder="e.g., Silk+, Matte, HF"
              value={formData.subtype}
              onInput={(e) => updateField('subtype', (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        {/* Color Preview */}
        <div>
          <label class="label">Color</label>
          <div
            class="h-16 rounded-lg flex items-center justify-center mb-3"
            style={{ backgroundColor: formData.rgba }}
          >
            <span class="bg-white/90 text-gray-800 px-3 py-1 rounded-full text-sm font-medium">
              {formData.color_name || 'Color Preview'}
            </span>
          </div>
        </div>

        {/* RGBA, Color Name, and Presets */}
        <div class="grid grid-cols-3 gap-4">
          <div>
            <label class="label">RGBA Color</label>
            <div class="flex gap-2">
              <input
                type="text"
                class="input flex-1 font-mono"
                placeholder="RRGGBB"
                value={formData.rgba.replace('#', '')}
                onInput={(e) => {
                  let val = (e.target as HTMLInputElement).value.replace('#', '')
                  if (val.length <= 8) {
                    updateField('rgba', `#${val}`)
                  }
                }}
              />
              <input
                type="color"
                class="w-10 h-10 rounded cursor-pointer border border-[var(--border-color)] shrink-0"
                value={formData.rgba.substring(0, 7)}
                onInput={(e) => updateField('rgba', (e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <div>
            <label class="label">Color Name</label>
            <input
              type="text"
              class="input"
              placeholder="e.g., Titan Gray"
              value={formData.color_name}
              onInput={(e) => updateField('color_name', (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label class="label">Preset</label>
            <select
              class="select"
              value=""
              onChange={(e) => {
                const preset = COLOR_PRESETS.find(c => c.name === (e.target as HTMLSelectElement).value)
                if (preset) {
                  updateField('color_name', preset.name)
                  updateField('rgba', `#${preset.hex}`)
                }
                (e.target as HTMLSelectElement).value = '' // Reset select
              }}
            >
              <option value="">Select...</option>
              {COLOR_PRESETS.map(color => (
                <option key={color.name} value={color.name}>{color.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Core Weight */}
        <div>
          <label class="label">Empty Spool Weight (g)</label>
          <select
            class="select"
            value={formData.core_weight}
            onChange={(e) => updateField('core_weight', parseInt((e.target as HTMLSelectElement).value))}
          >
            {CORE_WEIGHTS.map(w => (
              <option key={w} value={w}>{w}g</option>
            ))}
          </select>
        </div>

        {/* Note */}
        <div>
          <label class="label">Note</label>
          <input
            type="text"
            class="input"
            placeholder="Enter any additional notes..."
            value={formData.note}
            onInput={(e) => updateField('note', (e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
    </Modal>
  )
}
