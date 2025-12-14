import type { Spool, SpoolsInPrinters } from '../../lib/api'

/**
 * Filament code to name mapping (from base-filaments-index.csv)
 */
const FILAMENT_INDEX: Record<string, string> = {
  'GFA00': 'Bambu PLA Basic',
  'GFA01': 'Bambu PLA Matte',
  'GFA02': 'Bambu PLA Metal',
  'GFA05': 'Bambu PLA Silk',
  'GFA06': 'Bambu PLA Silk+',
  'GFA07': 'Bambu PLA Marble',
  'GFA08': 'Bambu PLA Sparkle',
  'GFA09': 'Bambu PLA Tough',
  'GFA11': 'Bambu PLA Aero',
  'GFA12': 'Bambu PLA Glow',
  'GFA13': 'Bambu PLA Dynamic',
  'GFA15': 'Bambu PLA Galaxy',
  'GFA16': 'Bambu PLA Wood',
  'GFA17': 'Bambu PLA Translucent',
  'GFA18': 'Bambu PLA Lite',
  'GFA50': 'Bambu PLA-CF',
  'GFB00': 'Bambu ABS',
  'GFB01': 'Bambu ASA',
  'GFB02': 'Bambu ASA-Aero',
  'GFB50': 'Bambu ABS-GF',
  'GFB51': 'Bambu ASA-CF',
  'GFB60': 'PolyLite ABS',
  'GFB61': 'PolyLite ASA',
  'GFB98': 'Generic ASA',
  'GFB99': 'Generic ABS',
  'GFC00': 'Bambu PC',
  'GFC01': 'Bambu PC FR',
  'GFC99': 'Generic PC',
  'GFG00': 'Bambu PETG Basic',
  'GFG01': 'Bambu PETG Translucent',
  'GFG02': 'Bambu PETG HF',
  'GFG50': 'Bambu PETG-CF',
  'GFG60': 'PolyLite PETG',
  'GFG96': 'Generic PETG HF',
  'GFG97': 'Generic PCTG',
  'GFG98': 'Generic PETG-CF',
  'GFG99': 'Generic PETG',
  'GFL00': 'PolyLite PLA',
  'GFL01': 'PolyTerra PLA',
  'GFL03': 'eSUN PLA+',
  'GFL04': 'Overture PLA',
  'GFL05': 'Overture Matte PLA',
  'GFL95': 'Generic PLA High Speed',
  'GFL96': 'Generic PLA Silk',
  'GFL98': 'Generic PLA-CF',
  'GFL99': 'Generic PLA',
  'GFN03': 'Bambu PA-CF',
  'GFN04': 'Bambu PAHT-CF',
  'GFN05': 'Bambu PA6-CF',
  'GFN06': 'Bambu PPA-CF',
  'GFN07': 'Bambu PPA-GF',
  'GFN08': 'Bambu PA6-GF',
  'GFN96': 'Generic PPA-GF',
  'GFN97': 'Generic PPA-CF',
  'GFN98': 'Generic PA-CF',
  'GFN99': 'Generic PA',
  'GFS00': 'Bambu Support W',
  'GFS01': 'Bambu Support G',
  'GFS02': 'Bambu Support For PLA',
  'GFS03': 'Bambu Support For PA/PET',
  'GFS04': 'Bambu PVA',
  'GFS05': 'Bambu Support For PLA/PETG',
  'GFS06': 'Bambu Support for ABS',
  'GFS97': 'Generic BVOH',
  'GFS98': 'Generic HIPS',
  'GFS99': 'Generic PVA',
  'GFT01': 'Bambu PET-CF',
  'GFT02': 'Bambu PPS-CF',
  'GFT97': 'Generic PPS',
  'GFT98': 'Generic PPS-CF',
  'GFU00': 'Bambu TPU 95A HF',
  'GFU01': 'Bambu TPU 95A',
  'GFU02': 'Bambu TPU for AMS',
  'GFU03': 'Bambu TPU 90A',
  'GFU04': 'Bambu TPU 85A',
  'GFU98': 'Generic TPU for AMS',
  'GFU99': 'Generic TPU',
}

/**
 * Get filament name from code (e.g., "GFA02" -> "Bambu PLA Metal")
 */
export function getFilamentName(code: string | undefined | null): string {
  if (!code) return ''
  return FILAMENT_INDEX[code] || code
}

/**
 * Get list of all filament options (code + name), sorted alphabetically by name
 */
export function getFilamentOptions(): { code: string; name: string }[] {
  return Object.entries(FILAMENT_INDEX)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Common color presets for filament
 */
export const COLOR_PRESETS = [
  { name: 'Black', hex: '000000' },
  { name: 'White', hex: 'FFFFFF' },
  { name: 'Gray', hex: '808080' },
  { name: 'Silver', hex: 'C0C0C0' },
  { name: 'Red', hex: 'FF0000' },
  { name: 'Dark Red', hex: '8B0000' },
  { name: 'Orange', hex: 'FFA500' },
  { name: 'Yellow', hex: 'FFFF00' },
  { name: 'Gold', hex: 'FFD700' },
  { name: 'Green', hex: '008000' },
  { name: 'Lime', hex: '00FF00' },
  { name: 'Teal', hex: '008080' },
  { name: 'Cyan', hex: '00FFFF' },
  { name: 'Blue', hex: '0000FF' },
  { name: 'Navy', hex: '000080' },
  { name: 'Purple', hex: '800080' },
  { name: 'Magenta', hex: 'FF00FF' },
  { name: 'Pink', hex: 'FFC0CB' },
  { name: 'Brown', hex: '8B4513' },
  { name: 'Beige', hex: 'F5F5DC' },
  { name: 'Ivory', hex: 'FFFFF0' },
  { name: 'Titan Gray', hex: '5A5A5A' },
  { name: 'Jade White', hex: 'E8E8E8' },
  { name: 'Bambu Green', hex: '00AE42' },
]

/**
 * Calculate total used weight (weight_used + consumed_since_weight)
 */
export function getTotalUsed(spool: Spool): number {
  return (spool.weight_used || 0) + (spool.consumed_since_weight || 0)
}

/**
 * Calculate net weight (remaining filament)
 */
export function getNetWeight(spool: Spool): number {
  return Math.max(0, (spool.label_weight || 0) - getTotalUsed(spool))
}

/**
 * Calculate gross weight (total spool weight including core)
 */
export function getGrossWeight(spool: Spool): number {
  return getNetWeight(spool) + (spool.core_weight || 0)
}

/**
 * Calculate usage percentage (how much has been consumed)
 */
export function getUsagePercent(spool: Spool): number {
  if (!spool.label_weight || spool.label_weight <= 0) return 0
  return Math.min(100, (getTotalUsed(spool) / spool.label_weight) * 100)
}

/**
 * Calculate remaining percentage
 */
export function getRemainingPercent(spool: Spool): number {
  return 100 - getUsagePercent(spool)
}

/**
 * Determine progress level based on remaining percentage
 */
export function getProgressLevel(spool: Spool): 'high' | 'medium' | 'low' {
  const remaining = getRemainingPercent(spool)
  if (remaining > 50) return 'high'
  if (remaining > 20) return 'medium'
  return 'low'
}

/**
 * Check if spool is low on stock (<20% remaining)
 */
export function isLowStock(spool: Spool, threshold: number = 20): boolean {
  return getRemainingPercent(spool) < threshold
}

/**
 * Check if spool is currently in a printer
 */
export function isInPrinter(spool: Spool, spoolsInPrinters: SpoolsInPrinters): boolean {
  if (!spool.id || !spoolsInPrinters) return false
  return !!spoolsInPrinters[spool.id]
}

/**
 * Get printer location for a spool
 */
export function getPrinterLocation(spool: Spool, spoolsInPrinters: SpoolsInPrinters): string | null {
  return spoolsInPrinters[spool.id] || null
}

/**
 * Compare scale weight with calculated gross weight
 * Returns difference and whether it's a match (within threshold)
 */
export function compareWeights(
  spool: Spool,
  threshold: number = 50
): { scaleWeight: number | null; calculatedWeight: number; difference: number | null; isMatch: boolean | null } {
  const calculatedWeight = getGrossWeight(spool)
  const scaleWeight = spool.weight_current ?? null

  if (scaleWeight === null) {
    return { scaleWeight: null, calculatedWeight, difference: null, isMatch: null }
  }

  const difference = scaleWeight - calculatedWeight
  const isMatch = Math.abs(difference) <= threshold

  return { scaleWeight, calculatedWeight, difference, isMatch }
}

/**
 * Format weight in grams or kg
 */
export function formatWeight(grams: number | null | undefined, useKg: boolean = false, decimals: boolean = false): string {
  if (grams === null || grams === undefined) return '-'
  if (useKg && grams >= 1000) {
    return `${(grams / 1000).toFixed(1)}kg`
  }
  if (decimals) {
    return `${grams.toFixed(1)}g`
  }
  return `${Math.round(grams)}g`
}

/**
 * Format date from Unix timestamp string
 */
export function formatDate(timestamp: string | null | undefined): string {
  if (!timestamp) return '-'
  const date = new Date(parseInt(timestamp) * 1000)
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit'
  })
}

/**
 * Format date with time
 */
export function formatDateTime(timestamp: string | null | undefined): string {
  if (!timestamp) return '-'
  const date = new Date(parseInt(timestamp) * 1000)
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Calculate inventory statistics
 */
export interface InventoryStats {
  totalSpools: number
  totalWeight: number
  totalConsumed: number
  byMaterial: Record<string, { count: number; weight: number }>
  byBrand: Record<string, { count: number; weight: number }>
  inPrinter: number
  lowStock: number
  hasK: number
}

export function calculateStats(spools: Spool[], spoolsInPrinters: SpoolsInPrinters): InventoryStats {
  const stats: InventoryStats = {
    totalSpools: spools.length,
    totalWeight: 0,
    totalConsumed: 0,
    byMaterial: {},
    byBrand: {},
    inPrinter: 0,
    lowStock: 0,
    hasK: 0
  }

  for (const spool of spools) {
    const netWeight = getNetWeight(spool)
    stats.totalWeight += netWeight
    stats.totalConsumed += spool.consumed_since_add || 0

    // By material
    const material = spool.material || 'Unknown'
    if (!stats.byMaterial[material]) {
      stats.byMaterial[material] = { count: 0, weight: 0 }
    }
    stats.byMaterial[material].count++
    stats.byMaterial[material].weight += netWeight

    // By brand
    const brand = spool.brand || 'Unknown'
    if (!stats.byBrand[brand]) {
      stats.byBrand[brand] = { count: 0, weight: 0 }
    }
    stats.byBrand[brand].count++
    stats.byBrand[brand].weight += netWeight

    // Counters
    if (isInPrinter(spool, spoolsInPrinters)) stats.inPrinter++
    if (isLowStock(spool)) stats.lowStock++
    if (spool.ext_has_k) stats.hasK++
  }

  return stats
}

/**
 * Get unique values from spools for filter dropdowns
 */
export function getUniqueValues(spools: Spool[]): {
  materials: string[]
  brands: string[]
  subtypes: string[]
} {
  const materials = new Set<string>()
  const brands = new Set<string>()
  const subtypes = new Set<string>()

  for (const spool of spools) {
    if (spool.material) materials.add(spool.material)
    if (spool.brand) brands.add(spool.brand)
    if (spool.subtype) subtypes.add(spool.subtype)
  }

  return {
    materials: Array.from(materials).sort(),
    brands: Array.from(brands).sort(),
    subtypes: Array.from(subtypes).sort()
  }
}
