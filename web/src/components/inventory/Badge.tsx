import type { ComponentChildren } from 'preact'

type BadgeVariant = 'printer' | 'low' | 'k' | 'origin' | 'manual' | 'encoded' | 'default'

interface BadgeProps {
  variant?: BadgeVariant
  children: ComponentChildren
  class?: string
}

export function Badge({ variant = 'default', children, class: className = '' }: BadgeProps) {
  const variantClass = variant === 'default' ? '' : `badge-${variant}`

  return (
    <span class={`badge ${variantClass} ${className}`}>
      {children}
    </span>
  )
}

// Pre-built badge components for common use cases

export function PrinterBadge({ location }: { location: string }) {
  if (!location) return null
  return <Badge variant="printer">{location}</Badge>
}

export function LowStockBadge() {
  return <Badge variant="low">Low</Badge>
}

export function KBadge() {
  return <Badge variant="k">K</Badge>
}

export function OriginBadge({ origin }: { origin: string }) {
  if (!origin) return null
  const variant = origin.toLowerCase().includes('bambu') ? 'origin' : 'manual'
  const label = origin || 'Manual'
  return <Badge variant={variant}>{label}</Badge>
}

export function EncodedBadge({ encoded }: { encoded: boolean }) {
  if (!encoded) return null
  return <Badge variant="encoded">NFC</Badge>
}
