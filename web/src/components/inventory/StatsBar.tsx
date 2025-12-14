import { useMemo } from 'preact/hooks'
import { Spool, SpoolsInPrinters } from '../../lib/api'
import { calculateStats, formatWeight } from './utils'
import { Package, TrendingDown, Layers, Printer, AlertTriangle } from 'lucide-preact'

interface StatsBarProps {
  spools: Spool[]
  spoolsInPrinters?: SpoolsInPrinters
}

export function StatsBar({ spools, spoolsInPrinters = {} }: StatsBarProps) {
  const stats = useMemo(() => calculateStats(spools, spoolsInPrinters), [spools, spoolsInPrinters])

  // Get top 3 materials by weight
  const topMaterials = useMemo(() => {
    return Object.entries(stats.byMaterial)
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 4)
  }, [stats.byMaterial])

  return (
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
      {/* Total Inventory */}
      <div class="stat-card">
        <div class="flex items-center gap-2 mb-1">
          <Package class="w-4 h-4 text-[var(--accent-color)]" />
          <span class="stat-label">Total Inventory</span>
        </div>
        <span class="stat-value">{formatWeight(stats.totalWeight, true)}</span>
        <span class="stat-detail">{stats.totalSpools} spool{stats.totalSpools !== 1 ? 's' : ''}</span>
      </div>

      {/* Total Consumed */}
      <div class="stat-card">
        <div class="flex items-center gap-2 mb-1">
          <TrendingDown class="w-4 h-4 text-[var(--info-color)]" />
          <span class="stat-label">Total Consumed</span>
        </div>
        <span class="stat-value">{formatWeight(stats.totalConsumed, true)}</span>
        <span class="stat-detail">Since tracking started</span>
      </div>

      {/* By Material */}
      <div class="stat-card">
        <div class="flex items-center gap-2 mb-1">
          <Layers class="w-4 h-4 text-[var(--success-color)]" />
          <span class="stat-label">By Material</span>
        </div>
        <div class="flex flex-wrap gap-1 mt-1">
          {topMaterials.map(([material, data]) => (
            <span key={material} class="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
              {material} {formatWeight(data.weight, true)}
            </span>
          ))}
        </div>
      </div>

      {/* In Printer */}
      <div class="stat-card">
        <div class="flex items-center gap-2 mb-1">
          <Printer class="w-4 h-4 text-[var(--badge-printer-text)]" />
          <span class="stat-label">In Printer</span>
        </div>
        <span class="stat-value">{stats.inPrinter}</span>
        <span class="stat-detail">Loaded in AMS/Ext</span>
      </div>

      {/* Low Stock */}
      <div class="stat-card">
        <div class="flex items-center gap-2 mb-1">
          <AlertTriangle class="w-4 h-4 text-[var(--warning-color)]" />
          <span class="stat-label">Low Stock</span>
        </div>
        <span class={`stat-value ${stats.lowStock > 0 ? 'text-[var(--warning-color)]' : ''}`}>
          {stats.lowStock}
        </span>
        <span class="stat-detail">&lt;20% remaining</span>
      </div>
    </div>
  )
}
