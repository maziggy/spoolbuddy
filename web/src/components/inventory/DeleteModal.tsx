import { useState } from 'preact/hooks'
import { Modal } from './Modal'
import { Spool } from '../../lib/api'
import { getNetWeight, formatWeight, formatDateTime } from './utils'

interface DeleteModalProps {
  isOpen: boolean
  onClose: () => void
  spool: Spool | null
  onDelete: (spool: Spool) => Promise<void>
}

export function DeleteModal({ isOpen, onClose, spool, onDelete }: DeleteModalProps) {
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!spool) return null

  const netWeight = getNetWeight(spool)

  const handleDelete = async () => {
    setIsDeleting(true)
    setError(null)

    try {
      await onDelete(spool)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete spool')
    } finally {
      setIsDeleting(false)
    }
  }

  // Format rgba color
  const colorStyle = spool.rgba
    ? (spool.rgba.startsWith('#') ? spool.rgba : `#${spool.rgba}`)
    : '#e2e8f0'

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Delete Spool"
      size="md"
      footer={
        <>
          <button class="btn" onClick={onClose} disabled={isDeleting}>
            Cancel
          </button>
          <button class="btn btn-danger" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting ? 'Deleting...' : 'Yes, Delete'}
          </button>
        </>
      }
    >
      <p class="text-[var(--text-secondary)] mb-4">
        Are you sure you want to delete this spool?
      </p>

      {error && (
        <div class="mb-4 p-3 bg-[var(--error-color)]/10 border border-[var(--error-color)]/30 rounded-lg text-[var(--error-color)] text-sm">
          {error}
        </div>
      )}

      {/* Spool Info Card */}
      <div class="bg-[var(--bg-tertiary)] rounded-lg overflow-hidden">
        {/* Color Header */}
        <div
          class="h-12 flex items-center justify-center"
          style={{ backgroundColor: colorStyle }}
        >
          <span class="bg-white/90 text-gray-800 px-3 py-1 rounded-full text-sm font-medium">
            {spool.color_name || 'Unknown'}
          </span>
        </div>

        <div class="p-4">
          {/* Header */}
          <div class="text-lg font-semibold text-[var(--text-primary)] mb-3 pb-2 border-b border-[var(--border-color)]">
            #{spool.id} - {spool.material} {formatWeight(netWeight)} / {formatWeight(spool.label_weight)}
          </div>

          {/* Details Grid */}
          <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <span class="text-[var(--text-muted)]">Brand:</span>
              <span class="ml-2 text-[var(--text-primary)]">{spool.brand || '-'}</span>
            </div>
            <div>
              <span class="text-[var(--text-muted)]">Subtype:</span>
              <span class="ml-2 text-[var(--text-primary)]">{spool.subtype || '-'}</span>
            </div>

            <div>
              <span class="text-[var(--text-muted)]">Tag ID:</span>
              <span class="ml-2 text-[var(--text-primary)] font-mono text-xs">{spool.tag_id || '-'}</span>
            </div>
            <div>
              <span class="text-[var(--text-muted)]">Added:</span>
              <span class="ml-2 text-[var(--text-primary)]">{formatDateTime(spool.added_time)}</span>
            </div>

            <div>
              <span class="text-[var(--text-muted)]">Full Weight:</span>
              <span class="ml-2 text-[var(--text-primary)]">{formatWeight(spool.label_weight)}</span>
            </div>
            <div>
              <span class="text-[var(--text-muted)]">Core Weight:</span>
              <span class="ml-2 text-[var(--text-primary)]">{formatWeight(spool.core_weight)}</span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
