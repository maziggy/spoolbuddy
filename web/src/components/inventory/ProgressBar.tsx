interface ProgressBarProps {
  /** Value between 0 and 100 */
  percent: number
  /** Show text label */
  showLabel?: boolean
  /** Custom label text (overrides default percentage) */
  label?: string
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
  /** Additional classes */
  class?: string
}

export function ProgressBar({
  percent,
  showLabel = false,
  label,
  size = 'md',
  class: className = ''
}: ProgressBarProps) {
  const clampedPercent = Math.max(0, Math.min(100, percent))

  // Determine color based on percentage (remaining)
  let level: 'high' | 'medium' | 'low'
  if (clampedPercent > 50) {
    level = 'high'
  } else if (clampedPercent > 20) {
    level = 'medium'
  } else {
    level = 'low'
  }

  const heightClass = {
    sm: 'h-1.5',
    md: 'h-2',
    lg: 'h-3'
  }[size]

  return (
    <div class={`flex items-center gap-2 ${className}`}>
      <div class={`flex-1 progress-bar ${heightClass}`}>
        <div
          class={`progress-fill ${level}`}
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
      {showLabel && (
        <span class="text-xs text-[var(--text-secondary)] min-w-[45px] text-right">
          {label ?? `${Math.round(clampedPercent)}%`}
        </span>
      )}
    </div>
  )
}

interface WeightProgressProps {
  /** Remaining weight in grams */
  remaining: number
  /** Total/label weight in grams */
  total: number
  /** Show weight as label instead of percentage */
  showWeight?: boolean
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
}

export function WeightProgress({ remaining, total, showWeight = true, size = 'md' }: WeightProgressProps) {
  const percent = total > 0 ? (remaining / total) * 100 : 0
  const label = showWeight ? `${Math.round(remaining)}g` : undefined

  return (
    <ProgressBar
      percent={percent}
      showLabel
      label={label}
      size={size}
    />
  )
}
