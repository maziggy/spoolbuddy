import { Spool } from '../../lib/api'
import { WeightProgress } from './ProgressBar'
import { PrinterBadge, LowStockBadge, KBadge, OriginBadge } from './Badge'
import { getNetWeight, getRemainingPercent, isLowStock, formatWeight, formatDateTime } from './utils'

interface SpoolCardProps {
  spool: Spool
  isInPrinter: boolean
  printerLocation?: string
  onClick?: () => void
}

export function SpoolCard({ spool, isInPrinter, printerLocation, onClick }: SpoolCardProps) {
  const netWeight = getNetWeight(spool)
  const remainingPercent = getRemainingPercent(spool)
  const lowStock = isLowStock(spool)

  // Format rgba color - add # if not present
  const colorStyle = spool.rgba
    ? (spool.rgba.startsWith('#') ? spool.rgba : `#${spool.rgba}`)
    : '#e2e8f0'

  return (
    <div
      class="card overflow-hidden hover:border-[var(--accent-color)] transition-colors cursor-pointer"
      onClick={onClick}
    >
      {/* Color Header */}
      <div
        class="h-16 flex items-center justify-center relative"
        style={{ backgroundColor: colorStyle }}
      >
        <span class="bg-white/90 text-gray-800 px-3 py-1 rounded-full text-sm font-medium">
          {spool.color_name || 'Unknown'}
        </span>
      </div>

      {/* Content */}
      <div class="p-4 space-y-4">
        {/* Title Row */}
        <div class="flex items-start justify-between gap-2">
          <div>
            <h3 class="font-semibold text-[var(--text-primary)]">
              {spool.material}{spool.subtype ? ` ${spool.subtype}` : ''}
            </h3>
            <p class="text-sm text-[var(--text-secondary)]">
              {spool.brand || 'Unknown Brand'}
            </p>
          </div>
          <span class="text-xs font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-2 py-1 rounded">
            #{spool.id}
          </span>
        </div>

        {/* Progress Bar */}
        <div>
          <div class="flex justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span>Remaining</span>
            <span>{Math.round(remainingPercent)}%</span>
          </div>
          <WeightProgress
            remaining={netWeight}
            total={spool.label_weight || 0}
            showWeight={true}
            size="md"
          />
        </div>

        {/* Weight Info */}
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span class="text-[var(--text-muted)]">Label: </span>
            <span class="text-[var(--text-secondary)]">{formatWeight(spool.label_weight)}</span>
          </div>
          <div>
            <span class="text-[var(--text-muted)]">Core: </span>
            <span class="text-[var(--text-secondary)]">{formatWeight(spool.core_weight)}</span>
          </div>
          <div>
            <span class="text-[var(--text-muted)]">Used: </span>
            <span class="text-[var(--text-secondary)]">{formatWeight(spool.consumed_since_add)}</span>
          </div>
          {spool.weight_current && (
            <div>
              <span class="text-[var(--text-muted)]">Scale: </span>
              <span class="text-[var(--text-secondary)]">{formatWeight(spool.weight_current)}</span>
            </div>
          )}
        </div>

        {/* Badges */}
        <div class="flex flex-wrap gap-1.5">
          {isInPrinter && printerLocation && (
            <PrinterBadge location={printerLocation} />
          )}
          {lowStock && <LowStockBadge />}
          {spool.ext_has_k && <KBadge />}
          {spool.data_origin && <OriginBadge origin={spool.data_origin} />}
        </div>

        {/* Meta Info */}
        <div class="text-xs text-[var(--text-muted)] pt-2 border-t border-[var(--border-color)]">
          <div class="flex justify-between">
            <span>Added: {formatDateTime(spool.added_time)}</span>
            {spool.encode_time && <span>NFC</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
