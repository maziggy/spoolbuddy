import { useMemo, useState, useEffect } from 'preact/hooks'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
  SortingState,
  ColumnDef,
} from '@tanstack/react-table'
import { Spool, SpoolsInPrinters } from '../../lib/api'
import { SpoolCard } from './SpoolCard'
import { WeightProgress } from './ProgressBar'
import { PrinterBadge, KBadge, OriginBadge } from './Badge'
import { getNetWeight, getGrossWeight, compareWeights, formatWeight, getFilamentName } from './utils'
import { ChevronUp, ChevronDown, Search, Check, AlertTriangle, Trash2, Columns } from 'lucide-preact'
import { ColumnConfig } from './ColumnConfigModal'

const columnHelper = createColumnHelper<Spool>()
const PAGE_SIZE_KEY = 'spoolbuddy-page-size'
const SORTING_KEY = 'spoolbuddy-sorting'

function getStoredPageSize(): number {
  try {
    const stored = localStorage.getItem(PAGE_SIZE_KEY)
    if (stored) {
      const size = parseInt(stored, 10)
      if ([15, 30, 50, 100].includes(size)) return size
    }
  } catch {
    // Ignore errors
  }
  return 15
}

function getStoredSorting(): SortingState {
  try {
    const stored = localStorage.getItem(SORTING_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    // Ignore errors
  }
  return [{ id: 'id', desc: false }]
}

interface SpoolsTableProps {
  spools: Spool[]
  spoolsInPrinters?: SpoolsInPrinters
  onEditSpool?: (spool: Spool) => void
  onDeleteSpool?: (spool: Spool) => void
  columnConfig?: ColumnConfig[]
  onOpenColumns?: () => void
}

export function SpoolsTable({
  spools,
  spoolsInPrinters = {},
  onEditSpool,
  onDeleteSpool,
  columnConfig,
  onOpenColumns
}: SpoolsTableProps) {
  const [sorting, setSorting] = useState<SortingState>(getStoredSorting)
  const [globalFilter, setGlobalFilter] = useState('')
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table')
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: getStoredPageSize(),
  })

  // Save page size to localStorage when it changes
  useEffect(() => {
    localStorage.setItem(PAGE_SIZE_KEY, String(pagination.pageSize))
  }, [pagination.pageSize])

  // Save sorting to localStorage when it changes
  useEffect(() => {
    localStorage.setItem(SORTING_KEY, JSON.stringify(sorting))
  }, [sorting])

  // All available column definitions
  const allColumnDefs = useMemo(
    () => [
      // ID (required)
      columnHelper.accessor('id', {
        header: 'ID',
        cell: (info) => <span class="font-medium">{info.getValue() || '-'}</span>,
        size: 50,
      }),
      // Added
      columnHelper.accessor('added_time', {
        id: 'added_time',
        header: 'Added',
        cell: (info) => {
          const value = info.getValue()
          if (!value) return <span class="text-[var(--text-muted)]">-</span>
          const date = new Date(parseInt(value) * 1000)
          return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })
        },
        size: 90,
      }),
      // Encoded
      columnHelper.accessor('encode_time', {
        id: 'encode_time',
        header: 'Encoded',
        cell: (info) => {
          const value = info.getValue()
          if (!value) return <span class="text-[var(--text-muted)]">-</span>
          const date = new Date(parseInt(value) * 1000)
          return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })
        },
        size: 90,
      }),
      // RGBA (color swatch)
      columnHelper.accessor('rgba', {
        header: 'Color',
        cell: (info) => {
          const rgba = info.getValue()
          const colorStyle = rgba ? (rgba.startsWith('#') ? rgba : `#${rgba}`) : '#ccc'
          return (
            <div
              class="color-swatch"
              style={{ backgroundColor: colorStyle }}
              title={info.row.original.color_name || rgba || undefined}
            />
          )
        },
        size: 60,
      }),
      // Material
      columnHelper.accessor('material', {
        header: 'Material',
        cell: (info) => info.getValue() || '-',
        size: 80,
      }),
      // Subtype
      columnHelper.accessor('subtype', {
        header: 'Subtype',
        cell: (info) => info.getValue() || <span class="text-[var(--text-muted)]">-</span>,
        size: 80,
      }),
      // Color (name)
      columnHelper.accessor('color_name', {
        id: 'color_name',
        header: 'Color Name',
        cell: (info) => info.getValue() || <span class="text-[var(--text-muted)]">-</span>,
        size: 120,
      }),
      // Brand
      columnHelper.accessor('brand', {
        header: 'Brand',
        cell: (info) => info.getValue() || '-',
        size: 100,
      }),
      // Slicer Filament
      columnHelper.accessor('slicer_filament', {
        id: 'slicer_filament',
        header: 'Slicer Filament',
        cell: (info) => {
          const code = info.getValue()
          if (!code) return <span class="text-[var(--text-muted)]">-</span>
          const name = getFilamentName(code)
          return <span title={code}>{name}</span>
        },
        size: 150,
      }),
      // Location
      columnHelper.accessor((row) => spoolsInPrinters[row.id] || '', {
        id: 'location',
        header: 'Location',
        cell: (info) => {
          const location = info.getValue()
          return location ? <PrinterBadge location={location} /> : <span class="text-[var(--text-muted)]">-</span>
        },
        size: 120,
      }),
      // Label (label_weight)
      columnHelper.accessor('label_weight', {
        id: 'label_weight',
        header: 'Label',
        cell: (info) => formatWeight(info.getValue() || 0),
        size: 70,
      }),
      // Net (calculated remaining weight)
      columnHelper.accessor((row) => getNetWeight(row), {
        id: 'net',
        header: 'Net',
        cell: (info) => formatWeight(info.getValue()),
        size: 70,
      }),
      // Gross (net + core weight)
      columnHelper.accessor((row) => getGrossWeight(row), {
        id: 'gross',
        header: 'Gross',
        cell: (info) => formatWeight(info.getValue()),
        size: 70,
      }),
      // Full (was spool full when added)
      columnHelper.accessor('added_full', {
        id: 'added_full',
        header: 'Full',
        cell: (info) => {
          const value = info.getValue()
          if (value === undefined || value === null) return <span class="text-[var(--text-muted)]">-</span>
          return value ? 'Yes' : 'No'
        },
        size: 50,
      }),
      // Used (weight_used + consumed_since_weight)
      columnHelper.accessor((row) => (row.weight_used || 0) + (row.consumed_since_weight || 0), {
        id: 'used',
        header: 'Used',
        cell: (info) => {
          const value = info.getValue()
          if (!value) return <span class="text-[var(--text-muted)]">-</span>
          return formatWeight(value, false, true)
        },
        size: 70,
      }),
      // Printed Total (same as consumed_since_add)
      columnHelper.accessor('consumed_since_add', {
        id: 'printed_total',
        header: 'Printed Total',
        cell: (info) => formatWeight(info.getValue() || 0, false, true),
        size: 100,
      }),
      // Printed Since Weight
      columnHelper.accessor('consumed_since_weight', {
        id: 'printed_since_weight',
        header: 'Printed Since Weight',
        cell: (info) => formatWeight(info.getValue() || 0, false, true),
        size: 130,
      }),
      // Note
      columnHelper.accessor('note', {
        id: 'note',
        header: 'Note',
        cell: (info) => {
          const note = info.getValue()
          return note ? (
            <span class="truncate max-w-[150px] block" title={note}>{note}</span>
          ) : (
            <span class="text-[var(--text-muted)]">-</span>
          )
        },
        size: 150,
      }),
      // PA(K) - has pressure advance calibration
      columnHelper.accessor('ext_has_k', {
        id: 'pa_k',
        header: 'PA(K)',
        cell: (info) => info.getValue() ? <KBadge /> : <span class="text-[var(--text-muted)]">-</span>,
        size: 60,
      }),
      // Tag ID
      columnHelper.accessor('tag_id', {
        id: 'tag_id',
        header: 'Tag ID',
        cell: (info) => (
          <span class="font-mono text-xs">{info.getValue() || '-'}</span>
        ),
        size: 100,
      }),
      // Data Origin
      columnHelper.accessor('data_origin', {
        header: 'Data Origin',
        cell: (info) => {
          const origin = info.getValue()
          return origin ? <OriginBadge origin={origin} /> : <span class="text-[var(--text-muted)]">-</span>
        },
        size: 100,
      }),
      // Linked Tag Type
      columnHelper.accessor('tag_type', {
        id: 'tag_type',
        header: 'Linked Tag Type',
        cell: (info) => info.getValue() || <span class="text-[var(--text-muted)]">-</span>,
        size: 120,
      }),
      // Remaining (progress bar) - extra visual column
      columnHelper.accessor((row) => getNetWeight(row), {
        id: 'remaining',
        header: 'Remaining',
        cell: (info) => {
          const spool = info.row.original
          const netWeight = getNetWeight(spool)
          return (
            <WeightProgress
              remaining={netWeight}
              total={spool.label_weight || 0}
              size="md"
            />
          )
        },
        size: 150,
      }),
      // Scale weight with comparison
      columnHelper.accessor('weight_current', {
        id: 'scale',
        header: 'Scale',
        cell: (info) => {
          const spool = info.row.original
          const { scaleWeight, calculatedWeight, difference, isMatch } = compareWeights(spool)

          if (scaleWeight === null) {
            return <span class="text-[var(--text-muted)]" title="No scale measurement">-</span>
          }

          const diffStr = difference !== null ? (difference > 0 ? `+${Math.round(difference)}` : Math.round(difference)) : '?'
          const tooltip = isMatch
            ? `Scale: ${Math.round(scaleWeight)}g\nCalculated: ${Math.round(calculatedWeight)}g\nDifference: ${diffStr}g (within tolerance)`
            : `Scale: ${Math.round(scaleWeight)}g\nCalculated: ${Math.round(calculatedWeight)}g\nDifference: ${diffStr}g\n\nMismatch! Possible causes:\n- Filament used without tracking\n- Incorrect core weight setting\n- Consumption tracking drift`

          return (
            <div
              class={`flex items-center gap-1 cursor-help ${isMatch ? 'weight-match' : 'weight-mismatch'}`}
              title={tooltip}
            >
              <span>{Math.round(scaleWeight)}g</span>
              {isMatch ? (
                <Check class="w-3 h-3" />
              ) : (
                <AlertTriangle class="w-3 h-3" />
              )}
            </div>
          )
        },
        size: 80,
      }),
      // Actions (required)
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: (info) => (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDeleteSpool?.(info.row.original)
            }}
            class="p-1.5 rounded hover:bg-[var(--error-color)]/10 text-[var(--text-muted)] hover:text-[var(--error-color)] transition-colors"
            title="Delete spool"
          >
            <Trash2 class="w-4 h-4" />
          </button>
        ),
        size: 50,
      }),
    ],
    [spoolsInPrinters, onDeleteSpool]
  )

  // Apply column configuration (visibility and order)
  const columns = useMemo(() => {
    if (!columnConfig) return allColumnDefs

    // Create a map for quick lookup - use id or accessorKey
    const columnDefsMap = new Map(
      allColumnDefs.map(col => {
        const colId = col.id || (col as { accessorKey?: string }).accessorKey
        return [colId, col]
      })
    )

    // Filter and order based on config
    return columnConfig
      .filter(cfg => cfg.visible)
      .map(cfg => columnDefsMap.get(cfg.id))
      .filter((col): col is ColumnDef<Spool, unknown> => col !== undefined)
  }, [allColumnDefs, columnConfig])

  const table = useReactTable({
    data: spools,
    columns,
    state: {
      sorting,
      globalFilter,
      pagination,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  return (
    <div class="space-y-4">
      {/* Toolbar */}
      <div class="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div class="flex items-center gap-2">
          <button
            onClick={onOpenColumns}
            class="btn"
            title="Configure Columns"
          >
            <Columns class="w-4 h-4" />
            <span>Columns</span>
          </button>
          <div class="relative w-full sm:w-72">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-muted)]" />
            <input
              type="text"
              value={globalFilter}
              onInput={(e) => setGlobalFilter((e.target as HTMLInputElement).value)}
              placeholder="Search spools..."
              class="input input-with-icon"
            />
          </div>
        </div>

        <div class="flex items-center gap-1">
          <div class="flex bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('table')}
              class={`px-4 py-2 text-sm font-medium transition-colors ${
                viewMode === 'table'
                  ? 'bg-[var(--accent-color)] text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              Table
            </button>
            <button
              onClick={() => setViewMode('cards')}
              class={`px-4 py-2 text-sm font-medium transition-colors ${
                viewMode === 'cards'
                  ? 'bg-[var(--accent-color)] text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              Cards
            </button>
          </div>
        </div>
      </div>

      <div class="text-xs text-[var(--text-muted)]">
        Click row to view details
      </div>

      {/* Content */}
      {viewMode === 'cards' ? (
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {table.getRowModel().rows.map((row, index) => (
            <SpoolCard
              key={row.original.id || index}
              spool={row.original}
              isInPrinter={!!spoolsInPrinters[row.original.id]}
              printerLocation={spoolsInPrinters[row.original.id]}
              onClick={() => onEditSpool?.(row.original)}
            />
          ))}
          {table.getRowModel().rows.length === 0 && (
            <div class="col-span-full text-center py-12 text-[var(--text-muted)]">
              {globalFilter ? 'No spools match your search' : 'No spools in inventory'}
            </div>
          )}
        </div>
      ) : (
        <>
          <div class="card overflow-hidden">
            <div class="overflow-x-auto">
              <table class="table">
                <thead>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          style={{ width: header.getSize() }}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <div class="flex items-center gap-1">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getIsSorted() === 'asc' && <ChevronUp class="w-3 h-3" />}
                            {header.column.getIsSorted() === 'desc' && <ChevronDown class="w-3 h-3" />}
                          </div>
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => onEditSpool?.(row.original)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {table.getRowModel().rows.length === 0 && (
                    <tr>
                      <td colSpan={columns.length} class="text-center py-12 text-[var(--text-muted)]">
                        {globalFilter ? 'No spools match your search' : 'No spools in inventory'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div class="flex items-center justify-between px-4 py-3 bg-[var(--bg-tertiary)] border-t border-[var(--border-color)] text-sm">
              <span class="text-[var(--text-secondary)]">
                Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{' '}
                {Math.min(
                  (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
                  table.getFilteredRowModel().rows.length
                )}{' '}
                of {table.getFilteredRowModel().rows.length} spools
              </span>

              <div class="flex items-center gap-2">
                <span class="text-[var(--text-secondary)]">Show</span>
                <select
                  class="select w-auto"
                  value={table.getState().pagination.pageSize}
                  onChange={(e) => table.setPageSize(Number((e.target as HTMLSelectElement).value))}
                >
                  {[15, 30, 50, 100].map((size) => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>

                <button
                  onClick={() => table.setPageIndex(0)}
                  disabled={!table.getCanPreviousPage()}
                  class="btn btn-icon"
                >
                  ««
                </button>
                <button
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  class="btn btn-icon"
                >
                  ‹
                </button>
                <span class="px-2 text-[var(--text-secondary)] whitespace-nowrap">
                  Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
                </span>
                <button
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  class="btn btn-icon"
                >
                  ›
                </button>
                <button
                  onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                  disabled={!table.getCanNextPage()}
                  class="btn btn-icon"
                >
                  »»
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
