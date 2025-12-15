import { createContext } from 'preact'
import { useContext, useState, useCallback } from 'preact/hooks'
import { Check, X, AlertCircle, Info, Loader2 } from 'lucide-preact'

type ToastType = 'success' | 'error' | 'info' | 'loading'

interface Toast {
  id: string
  type: ToastType
  message: string
  duration?: number
}

interface ToastContextValue {
  toasts: Toast[]
  showToast: (type: ToastType, message: string, duration?: number) => string
  dismissToast: (id: string) => void
  updateToast: (id: string, type: ToastType, message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

export function ToastProvider({ children }: { children: preact.ComponentChildren }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = useCallback((type: ToastType, message: string, duration = 4000) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    setToasts(prev => [...prev, { id, type, message, duration }])

    // Auto dismiss (except for loading toasts)
    if (type !== 'loading' && duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id))
      }, duration)
    }

    return id
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const updateToast = useCallback((id: string, type: ToastType, message: string) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, type, message } : t))

    // Auto dismiss after update (if not loading)
    if (type !== 'loading') {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id))
      }, 4000)
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast, updateToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[], onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null

  return (
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast, onDismiss: (id: string) => void }) {
  const icons = {
    success: <Check class="w-5 h-5 text-green-500" />,
    error: <AlertCircle class="w-5 h-5 text-red-500" />,
    info: <Info class="w-5 h-5 text-blue-500" />,
    loading: <Loader2 class="w-5 h-5 text-[var(--accent-color)] animate-spin" />,
  }

  const bgColors = {
    success: 'bg-green-500/10 border-green-500/30',
    error: 'bg-red-500/10 border-red-500/30',
    info: 'bg-blue-500/10 border-blue-500/30',
    loading: 'bg-[var(--accent-color)]/10 border-[var(--accent-color)]/30',
  }

  return (
    <div
      class={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg animate-slide-in ${bgColors[toast.type]} bg-[var(--bg-secondary)]`}
      role="alert"
    >
      {icons[toast.type]}
      <span class="flex-1 text-sm text-[var(--text-primary)]">{toast.message}</span>
      {toast.type !== 'loading' && (
        <button
          onClick={() => onDismiss(toast.id)}
          class="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X class="w-4 h-4" />
        </button>
      )}
    </div>
  )
}
