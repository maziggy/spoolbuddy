import { useState, useEffect, useMemo } from 'preact/hooks'
import { Modal } from './Modal'
import { Spool, SpoolInput, Printer, CalibrationProfile, SlicerPreset, api } from '../../lib/api'
import { X, ChevronDown, ChevronRight, Cloud, CloudOff } from 'lucide-preact'
import { getFilamentOptions, COLOR_PRESETS } from './utils'
import { useToast } from '../../lib/toast'
import { useWebSocket } from '../../lib/websocket'

// Type for printer with its calibrations
export interface PrinterWithCalibrations {
  printer: Printer;
  calibrations: CalibrationProfile[];
}

interface AddSpoolModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (input: SpoolInput) => Promise<void>
  editSpool?: Spool | null  // If provided, we're editing
  printersWithCalibrations?: PrinterWithCalibrations[]
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
  rgba: '#808080',
  label_weight: 1000,
  core_weight: 250,
  slicer_filament: '',
  note: '',
}

const MATERIALS = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'PC', 'PA', 'PVA', 'HIPS', 'PA-CF', 'PETG-CF', 'PLA-CF']
const WEIGHTS = [250, 500, 750, 1000, 2000, 3000]
const CORE_WEIGHTS = [200, 220, 245, 250, 280]
const BRANDS = ['Bambu', 'PolyLite', 'PolyTerra', 'eSUN', 'Overture', 'Fiberon', 'SUNLU', 'Inland', 'Hatchbox', 'Generic']

// Quick color swatches - most common colors
const QUICK_COLORS = [
  { name: 'Black', hex: '000000' },
  { name: 'White', hex: 'FFFFFF' },
  { name: 'Gray', hex: '808080' },
  { name: 'Red', hex: 'FF0000' },
  { name: 'Orange', hex: 'FFA500' },
  { name: 'Yellow', hex: 'FFFF00' },
  { name: 'Green', hex: '00AE42' },
  { name: 'Blue', hex: '0066FF' },
  { name: 'Purple', hex: '8B00FF' },
  { name: 'Pink', hex: 'FF69B4' },
  { name: 'Brown', hex: '8B4513' },
  { name: 'Silver', hex: 'C0C0C0' },
]

export function AddSpoolModal({ isOpen, onClose, onSave, editSpool, printersWithCalibrations = [] }: AddSpoolModalProps) {
  const [formData, setFormData] = useState<SpoolFormData>(defaultFormData)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAllColors, setShowAllColors] = useState(false)
  const [activeTab, setActiveTab] = useState<'filament' | 'pa_profile'>('filament')
  const [expandedPrinters, setExpandedPrinters] = useState<Set<string>>(new Set())
  const [selectedProfiles, setSelectedProfiles] = useState<Set<string>>(new Set()) // "serial:cali_idx:extruder_id"
  const { showToast, updateToast } = useToast()
  const { printerStates } = useWebSocket()

  // Cloud presets state
  const [cloudPresets, setCloudPresets] = useState<SlicerPreset[]>([])
  const [cloudAuthenticated, setCloudAuthenticated] = useState(false)
  const [loadingCloudPresets, setLoadingCloudPresets] = useState(false)

  // Separate state for preset input display (shows name, not code)
  const [presetInputValue, setPresetInputValue] = useState('')

  const isEditing = !!editSpool

  // Fetch cloud presets when modal opens
  useEffect(() => {
    if (isOpen) {
      const fetchCloudPresets = async () => {
        setLoadingCloudPresets(true)
        try {
          const status = await api.getCloudStatus()
          setCloudAuthenticated(status.is_authenticated)

          if (status.is_authenticated) {
            const presets = await api.getFilamentPresets()
            setCloudPresets(presets)
          }
        } catch (e) {
          console.error('Failed to fetch cloud presets:', e)
          setCloudAuthenticated(false)
        } finally {
          setLoadingCloudPresets(false)
        }
      }
      fetchCloudPresets()
    }
  }, [isOpen])

  // Reset form when modal opens/closes or editSpool changes
  useEffect(() => {
    if (isOpen) {
      if (editSpool) {
        setFormData({
          material: editSpool.material || '',
          subtype: editSpool.subtype || '',
          brand: editSpool.brand || '',
          color_name: editSpool.color_name || '',
          rgba: editSpool.rgba ? (editSpool.rgba.startsWith('#') ? editSpool.rgba : `#${editSpool.rgba}`) : '#808080',
          label_weight: editSpool.label_weight || 1000,
          core_weight: editSpool.core_weight || 250,
          slicer_filament: editSpool.slicer_filament || '',
          note: editSpool.note || '',
        })
        // presetInputValue will be synced by the effect below
      } else {
        setFormData(defaultFormData)
        setPresetInputValue('')
      }
      setError(null)
      setShowAllColors(false)
      setActiveTab('filament')
      // Expand all printers by default
      setExpandedPrinters(new Set(printersWithCalibrations.map(p => p.printer.serial)))
      setSelectedProfiles(new Set())
    }
  }, [isOpen, editSpool, printersWithCalibrations])

  const updateField = <K extends keyof SpoolFormData>(key: K, value: SpoolFormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }

  const handleSubmit = async () => {
    if (!formData.slicer_filament) {
      setError('Slicer preset is required')
      setActiveTab('filament')
      return
    }

    // Parse selected profiles into a structured format
    // Key format: "serial:cali_idx:extruder_id" (extruder_id may be undefined)
    const profilesToApply: { serial: string; caliIdx: number; extruderId: number | undefined; name: string; printerName: string }[] = []
    selectedProfiles.forEach(key => {
      const parts = key.split(':')
      const serial = parts[0]
      const caliIdx = parseInt(parts[1], 10)
      const extruderId = parts[2] !== undefined && parts[2] !== 'undefined' ? parseInt(parts[2], 10) : undefined
      const printerData = printersWithCalibrations.find(p => p.printer.serial === serial)
      const profile = printerData?.calibrations.find(c => c.cali_idx === caliIdx)
      profilesToApply.push({
        serial,
        caliIdx,
        extruderId,
        name: profile?.name || profile?.filament_id || `Profile ${caliIdx}`,
        printerName: printerData?.printer.name || serial
      })
    })

    setIsSubmitting(true)
    setError(null)

    // Show loading toast
    const toastId = showToast('loading', 'Saving spool...')

    try {
      // Step 1: Save the spool
      const input: SpoolInput = {
        material: formData.material,
        subtype: formData.subtype || null,
        brand: formData.brand || null,
        color_name: formData.color_name || null,
        rgba: formData.rgba.replace('#', '') || null,
        label_weight: formData.label_weight,
        core_weight: formData.core_weight,
        slicer_filament: formData.slicer_filament || null,
        note: formData.note || null,
        ext_has_k: profilesToApply.length > 0,
      }

      await onSave(input)

      // Step 2: Apply K-profiles to matching AMS slots
      const profileResults: { success: boolean; slot: string; error?: string }[] = []

      for (const profile of profilesToApply) {
        // Get the printer's current state to find slots with matching filament
        const printerState = printerStates.get(profile.serial)
        if (!printerState) {
          profileResults.push({ success: false, slot: `${profile.printerName}`, error: 'Printer state not available' })
          continue
        }

        // Find all AMS slots that have matching filament (tray_info_idx)
        const matchingSlots: { amsId: number; trayId: number; extruder: number | null }[] = []

        for (const amsUnit of printerState.ams_units) {
          for (const tray of amsUnit.trays) {
            // Match by tray_info_idx (filament preset ID)
            if (tray.tray_info_idx === formData.slicer_filament) {
              // For multi-nozzle printers, only apply to slots matching the extruder
              if (profile.extruderId !== undefined) {
                // Check if this AMS unit is for the correct extruder
                if (amsUnit.extruder === profile.extruderId) {
                  matchingSlots.push({ amsId: amsUnit.id, trayId: tray.tray_id, extruder: amsUnit.extruder })
                }
              } else {
                matchingSlots.push({ amsId: amsUnit.id, trayId: tray.tray_id, extruder: amsUnit.extruder })
              }
            }
          }
        }

        // Also check external spool (vt_tray)
        if (printerState.vt_tray && printerState.vt_tray.tray_info_idx === formData.slicer_filament) {
          matchingSlots.push({ amsId: printerState.vt_tray.ams_id, trayId: printerState.vt_tray.tray_id, extruder: null })
        }

        if (matchingSlots.length === 0) {
          profileResults.push({ success: false, slot: `${profile.printerName}`, error: 'No matching slots found' })
          continue
        }

        // Apply K-profile to each matching slot
        for (const slot of matchingSlots) {
          updateToast(toastId, 'loading', `Setting K-profile on ${profile.printerName} AMS${slot.amsId}:${slot.trayId}...`)
          try {
            await api.setCalibration(profile.serial, slot.amsId, slot.trayId, {
              cali_idx: profile.caliIdx,
              filament_id: formData.slicer_filament,
              nozzle_diameter: "0.4"
            })
            profileResults.push({ success: true, slot: `${profile.printerName} AMS${slot.amsId}:${slot.trayId}` })
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Failed'
            profileResults.push({ success: false, slot: `${profile.printerName} AMS${slot.amsId}:${slot.trayId}`, error: errorMsg })
          }
        }
      }

      // Show final result
      const successes = profileResults.filter(r => r.success)
      const failures = profileResults.filter(r => !r.success)

      if (profilesToApply.length === 0) {
        updateToast(toastId, 'success', 'Spool saved successfully')
      } else if (failures.length > 0 && successes.length === 0) {
        updateToast(toastId, 'error', `Spool saved but K-profiles failed: ${failures.map(f => f.error).join(', ')}`)
      } else if (failures.length > 0) {
        updateToast(toastId, 'success', `Spool saved. K-profiles set on ${successes.length} slot(s), ${failures.length} failed`)
      } else if (successes.length > 0) {
        updateToast(toastId, 'success', `Spool saved with K-profiles on ${successes.length} slot(s)`)
      } else {
        updateToast(toastId, 'success', 'Spool saved successfully')
      }

      onClose()
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Failed to save spool'
      setError(errorMsg)
      updateToast(toastId, 'error', errorMsg)
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectColor = (hex: string, name: string) => {
    updateField('rgba', `#${hex}`)
    updateField('color_name', name)
  }

  const togglePrinterExpanded = (serial: string) => {
    setExpandedPrinters(prev => {
      const next = new Set(prev)
      if (next.has(serial)) next.delete(serial)
      else next.add(serial)
      return next
    })
  }

  const toggleProfileSelected = (serial: string, caliIdx: number, extruderId?: number) => {
    const key = `${serial}:${caliIdx}:${extruderId}`
    setSelectedProfiles(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Get configured printer models for filtering
  const configuredPrinterModels = useMemo(() => {
    const models = new Set<string>()
    printersWithCalibrations.forEach(({ printer }) => {
      if (printer.model) {
        // Normalize model names (e.g., "X1 Carbon" -> "X1C", "P1S" -> "P1S")
        const model = printer.model.toUpperCase()
        models.add(model)
        // Also add common variants
        if (model.includes('X1')) models.add('X1C')
        if (model.includes('P1S')) models.add('P1S')
        if (model.includes('P1P')) models.add('P1P')
        if (model.includes('A1')) models.add('A1')
        if (model.includes('A1 MINI')) models.add('A1 MINI')
      }
    })
    return models
  }, [printersWithCalibrations])

  // Get filament options for dropdown - use cloud presets if available, else defaults
  const filamentOptions = useMemo(() => {
    // If we have cloud presets, filter and deduplicate them
    if (cloudPresets.length > 0) {
      const customPresets: { code: string; name: string; displayName: string; isCustom: boolean; allCodes: string[] }[] = []
      const defaultPresetsMap = new Map<string, { code: string; name: string; displayName: string; isCustom: boolean; allCodes: string[] }>()

      for (const preset of cloudPresets) {
        if (preset.is_custom) {
          // Custom presets: include if matches configured printers or no printer filter
          const presetNameUpper = preset.name.toUpperCase()
          const matchesPrinter = configuredPrinterModels.size === 0 ||
            Array.from(configuredPrinterModels).some(model => presetNameUpper.includes(model)) ||
            !presetNameUpper.includes('@')  // Include presets without printer suffix

          if (matchesPrinter) {
            customPresets.push({
              code: preset.setting_id,
              name: preset.name,
              displayName: `${preset.name} (Custom)`,
              isCustom: true,
              allCodes: [preset.setting_id],
            })
          }
        } else {
          // Default presets: deduplicate by base name (without @printer suffix)
          // Extract base name: "Bambu PLA Basic @BBL X1C" -> "Bambu PLA Basic"
          const baseName = preset.name.replace(/@.*$/, '').trim()

          // Collect all setting_ids for this base name (for K-profile matching)
          const existing = defaultPresetsMap.get(baseName)
          if (existing) {
            existing.allCodes.push(preset.setting_id)
          } else {
            defaultPresetsMap.set(baseName, {
              code: preset.setting_id,
              name: baseName,
              displayName: baseName,
              isCustom: false,
              allCodes: [preset.setting_id],
            })
          }
        }
      }

      // Combine and sort all presets alphabetically (A-Z)
      const result = [
        ...customPresets,
        ...Array.from(defaultPresetsMap.values()),
      ].sort((a, b) => a.displayName.localeCompare(b.displayName))

      return result
    }

    // Fallback to hardcoded defaults
    return getFilamentOptions().map(o => ({ ...o, displayName: o.name, isCustom: false, allCodes: [o.code] }))
  }, [cloudPresets, configuredPrinterModels])

  // Find the selected preset option (for display and K-profile matching)
  // Check both primary code and allCodes array for matches
  const selectedPresetOption = useMemo(() => {
    if (!formData.slicer_filament) return undefined
    // First try exact match on primary code
    let option = filamentOptions.find(o => o.code === formData.slicer_filament)
    if (!option) {
      // Try matching against any code in allCodes
      option = filamentOptions.find(o => o.allCodes.includes(formData.slicer_filament))
    }
    if (!option) {
      // Try case-insensitive match
      const slicerLower = formData.slicer_filament.toLowerCase()
      option = filamentOptions.find(o =>
        o.code.toLowerCase() === slicerLower ||
        o.allCodes.some(c => c.toLowerCase() === slicerLower)
      )
    }
    return option
  }, [filamentOptions, formData.slicer_filament])

  // Sync presetInputValue with selected preset's display name
  useEffect(() => {
    if (selectedPresetOption) {
      setPresetInputValue(selectedPresetOption.displayName)
    } else if (formData.slicer_filament) {
      // If no matching option found, show the raw code
      setPresetInputValue(formData.slicer_filament)
    }
  }, [selectedPresetOption, formData.slicer_filament])

  // Color list based on toggle
  const colorList = showAllColors ? COLOR_PRESETS : QUICK_COLORS

  // Check if a calibration matches the selected slicer filament
  // Uses allCodes from the selected preset to match across printer variants
  const isMatchingCalibration = (cal: CalibrationProfile) => {
    if (!formData.slicer_filament) return false
    const calFilamentId = cal.filament_id?.toLowerCase() || ''

    // If we have a selected preset option, check against all its codes
    if (selectedPresetOption) {
      for (const code of selectedPresetOption.allCodes) {
        const codeLower = code.toLowerCase()
        // Exact match
        if (calFilamentId === codeLower) return true
        // Base code match (e.g., "GFSG02" matches "GFSG02_03")
        const baseCode = codeLower.replace(/_\d+$/, '')
        const calBaseCode = calFilamentId.replace(/_\d+$/, '')
        if (baseCode === calBaseCode) return true
        // Partial match (contains)
        if (calFilamentId.includes(codeLower) || codeLower.includes(calFilamentId)) return true
        // Material type match - compare first 3-4 chars after 'GF' prefix
        // e.g., "GFHG02" and "GFG02" both contain "G" for PETG
        if (codeLower.startsWith('gf') && calFilamentId.startsWith('gf')) {
          // Extract material chars (everything between GF and digits)
          const codeMatl = codeLower.replace(/^gf/, '').replace(/\d+.*$/, '')
          const calMatl = calFilamentId.replace(/^gf/, '').replace(/\d+.*$/, '')
          // Match if one contains the other (e.g., "hg" contains "g", "g" matches "g")
          if (codeMatl && calMatl && (codeMatl.includes(calMatl) || calMatl.includes(codeMatl))) {
            return true
          }
        }
      }
    }

    // Also match directly against the selected slicer_filament value
    const selectedLower = formData.slicer_filament.toLowerCase()
    const selectedBase = selectedLower.replace(/_\d+$/, '')
    const calBase = calFilamentId.replace(/_\d+$/, '')
    return calFilamentId === selectedLower ||
           calBase === selectedBase ||
           calFilamentId.includes(selectedLower) ||
           selectedLower.includes(calFilamentId)
  }

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

      {/* Tabs */}
      <div class="tabs mb-4">
        <button
          class={`tab ${activeTab === 'filament' ? 'active' : ''}`}
          onClick={() => setActiveTab('filament')}
        >
          Filament Info
        </button>
        <button
          class={`tab ${activeTab === 'pa_profile' ? 'active' : ''}`}
          onClick={() => setActiveTab('pa_profile')}
        >
          PA Profile (K)
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'filament' ? (
        <div class="space-y-5">
          {/* === FILAMENT SECTION === */}
          <div class="space-y-3">
            <h3 class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Filament</h3>

            {/* Slicer Preset - REQUIRED */}
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="label mb-0">Slicer Preset *</label>
                <span class={`flex items-center gap-1 text-xs ${cloudAuthenticated ? 'text-green-500' : 'text-[var(--text-muted)]'}`}>
                  {loadingCloudPresets ? (
                    <>Loading...</>
                  ) : cloudAuthenticated ? (
                    <><Cloud class="w-3 h-3" /> Cloud</>
                  ) : (
                    <><CloudOff class="w-3 h-3" /> Local</>
                  )}
                </span>
              </div>
              <input
                type="text"
                list="slicer-presets"
                class="input"
                placeholder={loadingCloudPresets ? "Loading presets..." : "Type to search presets..."}
                value={presetInputValue}
                disabled={loadingCloudPresets}
                onInput={(e) => {
                  const inputValue = (e.target as HTMLInputElement).value
                  setPresetInputValue(inputValue)

                  // Look up option by displayName first, then by code
                  let option = filamentOptions.find(o => o.displayName === inputValue)
                  if (!option) {
                    // Try matching by code (in case datalist returned the code)
                    option = filamentOptions.find(o => o.code === inputValue)
                  }
                  if (!option) {
                    // Try case-insensitive displayName match
                    const inputLower = inputValue.toLowerCase()
                    option = filamentOptions.find(o => o.displayName.toLowerCase() === inputLower)
                  }

                  if (option) {
                    updateField('slicer_filament', option.code)
                    // Auto-fill material/brand from preset
                    const name = option.name
                    const brands = ['PolyTerra', 'PolyLite', 'Overture', 'Bambu', 'eSUN', 'Generic']
                    const materials = ['PLA-CF', 'PETG-CF', 'ABS-GF', 'ASA-CF', 'PA-CF', 'PAHT-CF', 'PA6-CF', 'PA6-GF', 'PPA-CF', 'PPA-GF', 'PET-CF', 'PPS-CF', 'PETG', 'PLA', 'ABS', 'ASA', 'PC', 'PA', 'TPU', 'PVA', 'HIPS', 'BVOH', 'PPS', 'PCTG']

                    let brand = ''
                    let material = ''
                    let subtype = ''
                    let remaining = name

                    for (const b of brands) {
                      if (name.toUpperCase().includes(b.toUpperCase())) {
                        brand = b
                        remaining = name.replace(new RegExp(b, 'i'), '').trim()
                        break
                      }
                    }
                    for (const m of materials) {
                      if (remaining.toUpperCase().includes(m.toUpperCase())) {
                        material = m
                        remaining = remaining.replace(new RegExp(m, 'i'), '').trim()
                        break
                      }
                    }
                    subtype = remaining.replace(/^\s*[-_]\s*/, '').replace(/\s*[-_]\s*$/, '').trim()

                    if (brand) updateField('brand', brand)
                    if (material) updateField('material', material)
                    if (subtype && subtype !== '(Custom)') updateField('subtype', subtype)
                  } else {
                    // User is typing - store the raw input as the code for now
                    updateField('slicer_filament', inputValue)
                  }
                }}
              />
              <datalist id="slicer-presets">
                {filamentOptions.map(({ code, displayName }) => (
                  <option key={code} value={displayName}>{displayName}</option>
                ))}
              </datalist>
              {selectedPresetOption && (
                <p class="text-xs text-[var(--accent-color)] mt-1">
                  Selected: {selectedPresetOption.displayName}
                </p>
              )}
              {!cloudAuthenticated && !loadingCloudPresets && !selectedPresetOption && (
                <p class="text-xs text-[var(--text-muted)] mt-1">
                  Login to Bambu Cloud in Settings for custom presets
                </p>
              )}
            </div>

            {/* Material + Subtype */}
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label">Material</label>
                <select
                  class="select"
                  value={formData.material}
                  onChange={(e) => updateField('material', (e.target as HTMLSelectElement).value)}
                >
                  <option value="">Select...</option>
                  {MATERIALS.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label class="label">Variant</label>
                <input
                  type="text"
                  class="input"
                  placeholder="e.g., Silk, Matte, HF"
                  value={formData.subtype}
                  onInput={(e) => updateField('subtype', (e.target as HTMLInputElement).value)}
                />
              </div>
            </div>

            {/* Brand + Weight */}
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label">Brand</label>
                <select
                  class="select"
                  value={formData.brand}
                  onChange={(e) => updateField('brand', (e.target as HTMLSelectElement).value)}
                >
                  <option value="">Select...</option>
                  {BRANDS.map(brand => (
                    <option key={brand} value={brand}>{brand}</option>
                  ))}
                </select>
              </div>
              <div>
                <label class="label">Spool Weight</label>
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
          </div>

          {/* === COLOR SECTION === */}
          <div class="space-y-3">
            <h3 class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Color</h3>

            {/* Color Preview Banner */}
            <div
              class="h-12 rounded-lg flex items-center justify-between px-4 border border-[var(--border-color)]"
              style={{ backgroundColor: formData.rgba }}
            >
              <span
                class="text-sm font-medium px-2 py-0.5 rounded"
                style={{ backgroundColor: 'rgba(255,255,255,0.9)', color: '#333' }}
              >
                {formData.color_name || 'Select a color'}
              </span>
              <span
                class="font-mono text-xs px-2 py-0.5 rounded"
                style={{ backgroundColor: 'rgba(0,0,0,0.5)', color: '#fff' }}
              >
                #{formData.rgba.replace('#', '').toUpperCase()}
              </span>
            </div>

            {/* Color Swatches */}
            <div class="flex flex-wrap gap-2">
              {colorList.map(color => (
                <button
                  key={color.name}
                  type="button"
                  onClick={() => selectColor(color.hex, color.name)}
                  class={`w-7 h-7 rounded-md border-2 transition-transform hover:scale-110 ${
                    formData.rgba.replace('#', '').toUpperCase() === color.hex.toUpperCase()
                      ? 'border-[var(--accent-color)] ring-2 ring-[var(--accent-color)]/30'
                      : 'border-[var(--border-color)]'
                  }`}
                  style={{ backgroundColor: `#${color.hex}` }}
                  title={color.name}
                />
              ))}
              <button
                type="button"
                onClick={() => setShowAllColors(!showAllColors)}
                class="w-7 h-7 rounded-md border-2 border-dashed border-[var(--border-color)] text-[var(--text-muted)] text-xs flex items-center justify-center hover:border-[var(--text-secondary)]"
                title={showAllColors ? 'Show less' : 'Show more colors'}
              >
                {showAllColors ? '−' : '+'}
              </button>
            </div>

            {/* Color Name + Hex */}
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="label">Color Name</label>
                <input
                  type="text"
                  list="color-name-presets"
                  class="input"
                  placeholder="Type or select..."
                  value={formData.color_name}
                  onInput={(e) => {
                    const name = (e.target as HTMLInputElement).value
                    updateField('color_name', name)
                    const preset = COLOR_PRESETS.find(c => c.name === name)
                    if (preset) updateField('rgba', `#${preset.hex}`)
                  }}
                />
                <datalist id="color-name-presets">
                  {COLOR_PRESETS.map(color => (
                    <option key={color.name} value={color.name} />
                  ))}
                </datalist>
              </div>
              <div>
                <label class="label">Hex Color</label>
                <div class="flex gap-2">
                  <input
                    type="text"
                    class="input flex-1 font-mono"
                    placeholder="RRGGBB"
                    value={formData.rgba.replace('#', '')}
                    onInput={(e) => {
                      let val = (e.target as HTMLInputElement).value.replace('#', '').replace(/[^0-9A-Fa-f]/g, '')
                      if (val.length <= 8) updateField('rgba', `#${val}`)
                    }}
                  />
                  <input
                    type="color"
                    class="w-10 h-[38px] rounded cursor-pointer border border-[var(--border-color)] shrink-0"
                    value={formData.rgba.substring(0, 7)}
                    onInput={(e) => updateField('rgba', (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* === ADDITIONAL SECTION === */}
          <div class="space-y-3">
            <h3 class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Additional</h3>

            {/* Core Weight */}
            <div>
              <label class="label">Empty Spool Weight</label>
              <select
                class="select"
                value={formData.core_weight}
                onChange={(e) => updateField('core_weight', parseInt((e.target as HTMLSelectElement).value))}
              >
                {CORE_WEIGHTS.map(w => (
                  <option key={w} value={w}>{w}g</option>
                ))}
              </select>
              <p class="text-xs text-[var(--text-muted)] mt-1">Weight of the empty spool (without filament)</p>
            </div>

            {/* Note */}
            <div>
              <label class="label">Notes</label>
              <textarea
                class="input min-h-[60px] resize-none"
                placeholder="Any additional notes about this spool..."
                value={formData.note}
                onInput={(e) => updateField('note', (e.target as HTMLTextAreaElement).value)}
              />
            </div>
          </div>
        </div>
      ) : (
        /* PA Profile Tab */
        <div class="space-y-4">
          {!formData.slicer_filament ? (
            <div class="p-4 bg-[var(--bg-tertiary)] rounded-lg text-center text-[var(--text-secondary)]">
              <p>Please select a slicer preset first in the Filament Info tab.</p>
            </div>
          ) : printersWithCalibrations.length === 0 ? (
            <div class="p-4 bg-[var(--bg-tertiary)] rounded-lg text-center text-[var(--text-secondary)]">
              <p>No printers configured. Add printers in the Printers page.</p>
            </div>
          ) : (
            <div class="space-y-3">
              {printersWithCalibrations.map(({ printer, calibrations }) => {
                const isExpanded = expandedPrinters.has(printer.serial)
                // Only show matching calibrations
                const matchingCals = calibrations.filter(cal => isMatchingCalibration(cal))
                const hasMatchingCals = matchingCals.length > 0

                // Check if multi-nozzle printer (has matching profiles with different extruder_ids)
                const extruderIds = new Set(matchingCals.map(cal => cal.extruder_id ?? 0))
                const isMultiNozzle = extruderIds.size > 1 || (extruderIds.size === 1 && matchingCals.some(cal => cal.extruder_id !== undefined && cal.extruder_id !== null))

                // Group matching profiles by extruder for multi-nozzle printers
                const leftNozzleCals = matchingCals.filter(cal => cal.extruder_id === 1)
                const rightNozzleCals = matchingCals.filter(cal => cal.extruder_id === 0 || cal.extruder_id === undefined || cal.extruder_id === null)

                const renderProfile = (cal: CalibrationProfile) => {
                  const key = `${printer.serial}:${cal.cali_idx}:${cal.extruder_id}`
                  const isSelected = selectedProfiles.has(key)
                  return (
                    <label
                      key={`${cal.cali_idx}-${cal.extruder_id}`}
                      class="flex items-center gap-3 p-2 rounded cursor-pointer bg-[var(--accent-color)]/10 hover:bg-[var(--accent-color)]/20"
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleProfileSelected(printer.serial, cal.cali_idx, cal.extruder_id)}
                        class="w-4 h-4 rounded border-[var(--border-color)] text-[var(--accent-color)]"
                      />
                      <span class="flex-1 text-sm font-medium text-[var(--accent-color)]">
                        {cal.name || cal.filament_id}
                      </span>
                      <span class="text-xs font-mono text-[var(--text-muted)]">
                        K={cal.k_value.toFixed(3)}
                      </span>
                    </label>
                  )
                }

                return (
                  <div key={printer.serial} class="border border-[var(--border-color)] rounded-lg overflow-hidden">
                    {/* Printer Header */}
                    <button
                      type="button"
                      onClick={() => togglePrinterExpanded(printer.serial)}
                      class="w-full px-4 py-3 flex items-center justify-between bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)] transition-colors"
                    >
                      <div class="flex items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown class="w-4 h-4 text-[var(--text-muted)]" />
                        ) : (
                          <ChevronRight class="w-4 h-4 text-[var(--text-muted)]" />
                        )}
                        <span class="font-medium text-[var(--text-primary)]">
                          {printer.name || printer.serial}
                        </span>
                        {hasMatchingCals && (
                          <span class="text-xs px-2 py-0.5 rounded bg-[var(--accent-color)]/20 text-[var(--accent-color)]">
                            {matchingCals.length} profile{matchingCals.length > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      <span class={`text-xs px-2 py-1 rounded ${
                        printer.connected
                          ? 'bg-green-500/20 text-green-500'
                          : 'bg-[var(--text-muted)]/20 text-[var(--text-muted)]'
                      }`}>
                        {printer.connected ? 'Connected' : 'Offline'}
                      </span>
                    </button>

                    {/* Calibration Profiles */}
                    {isExpanded && (
                      <div class="px-4 py-3 space-y-3 bg-[var(--bg-primary)]">
                        {!printer.connected ? (
                          <p class="text-sm text-[var(--text-muted)] italic">
                            Printer is offline. Connect to view calibration profiles.
                          </p>
                        ) : calibrations.length === 0 ? (
                          <p class="text-sm text-[var(--text-muted)] italic">
                            No calibration profiles found on this printer.
                          </p>
                        ) : !hasMatchingCals ? (
                          <div class="text-sm text-[var(--text-muted)] italic space-y-1">
                            <p>No matching K-profiles for "{presetInputValue || formData.slicer_filament}"</p>
                            <p class="text-xs">
                              Looking for: {formData.slicer_filament}
                              {selectedPresetOption?.allCodes && selectedPresetOption.allCodes.length > 1 &&
                                ` (also: ${selectedPresetOption.allCodes.slice(1).join(', ')})`}
                            </p>
                            <p class="text-xs">
                              {calibrations.length} profile{calibrations.length !== 1 ? 's' : ''} on printer: {[...new Set(calibrations.map(c => c.filament_id))].join(', ')}
                            </p>
                          </div>
                        ) : isMultiNozzle ? (
                          /* Multi-nozzle: group by extruder */
                          <>
                            {leftNozzleCals.length > 0 && (
                              <div class="space-y-2">
                                <p class="text-xs font-medium text-[var(--text-secondary)]">
                                  Left Nozzle ({leftNozzleCals.length})
                                </p>
                                {leftNozzleCals.map(renderProfile)}
                              </div>
                            )}
                            {rightNozzleCals.length > 0 && (
                              <div class="space-y-2">
                                <p class="text-xs font-medium text-[var(--text-secondary)]">
                                  Right Nozzle ({rightNozzleCals.length})
                                </p>
                                {rightNozzleCals.map(renderProfile)}
                              </div>
                            )}
                          </>
                        ) : (
                          /* Single nozzle: show matching profiles */
                          <div class="space-y-2">
                            {matchingCals.map(renderProfile)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Summary */}
              {selectedProfiles.size > 0 && (
                <div class="p-3 bg-[var(--accent-color)]/10 border border-[var(--accent-color)]/30 rounded-lg">
                  <p class="text-sm text-[var(--text-primary)]">
                    <span class="font-medium">{selectedProfiles.size}</span> calibration profile(s) selected
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
