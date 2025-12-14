import type { ComponentChildren } from 'preact'
import { useEffect, useCallback } from 'preact/hooks'
import { X } from 'lucide-preact'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ComponentChildren
  footer?: ComponentChildren
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

export function Modal({ isOpen, onClose, title, children, footer, size = 'md' }: ModalProps) {
  // Handle escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const maxWidthClass = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }[size]

  return (
    <div class="modal-overlay animate-fade-in" onClick={onClose}>
      <div
        class={`modal ${maxWidthClass} animate-slide-up`}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h2 class="modal-title">{title}</h2>
          <button
            onClick={onClose}
            class="btn btn-icon"
            title="Close"
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        <div class="modal-body">
          {children}
        </div>

        {footer && (
          <div class="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// Simple confirmation modal
interface ConfirmModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string | ComponentChildren
  confirmText?: string
  cancelText?: string
  confirmVariant?: 'primary' | 'danger'
  isLoading?: boolean
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmVariant = 'primary',
  isLoading = false,
}: ConfirmModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button class="btn" onClick={onClose} disabled={isLoading}>
            {cancelText}
          </button>
          <button
            class={`btn ${confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? 'Loading...' : confirmText}
          </button>
        </>
      }
    >
      <div class="text-[var(--text-secondary)]">
        {message}
      </div>
    </Modal>
  )
}
