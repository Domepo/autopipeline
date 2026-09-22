import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react'
import { Braces, Check, Copy, Eye, EyeOff, LoaderCircle, Pencil, Plus, Search } from 'lucide-react'
import { AgGridReact, type CustomCellRendererProps, type CustomHeaderProps } from 'ag-grid-react'
import {
  AllCommunityModule,
  themeBalham,
  type CellFocusedEvent,
  type CellValueChangedEvent,
  type ColDef,
} from 'ag-grid-community'
import type { Credential, DataField, Device } from '@autosecure/shared'
import { api, patch } from './api.ts'
import { Button, Input, Select } from './components.tsx'

type GridRow = { id: string; [key: string]: string }

type GridColumn = {
  id: string
  key: string
  label: string
  token?: string
  kind: 'name' | 'baseUrl' | 'credentials' | 'data'
  editable: boolean
  field?: DataField
}

type ActiveCell = { rowId: string; columnId: string; rowIndex: number } | null
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type HeaderParams = CustomHeaderProps<GridRow> & {
  model: GridColumn
  columnIndex: number
  onSelect: (id: string) => void
  onEdit: (field: DataField) => void
}
type CredentialRendererParams = CustomCellRendererProps<GridRow> & {
  revealedPasswords: Record<string, string>
  togglePassword: (credentialId: string) => void
}

type Props = {
  devices: Device[]
  dataFields: DataField[]
  credentials: Credential[]
  notify: (message: string, tone?: 'success' | 'error') => void
  onDevicesSaved: (devices: Device[]) => void
  onAddField: () => void
  onEditField: (field: DataField) => void
}

const baseColumns: GridColumn[] = [
  { id: 'name', key: 'name', label: 'Gerät', token: '{{device.name}}', kind: 'name', editable: true },
  { id: 'baseUrl', key: 'baseUrl', label: 'Start-URL', token: '{{device.baseUrl}}', kind: 'baseUrl', editable: true },
  { id: 'credentials', key: 'credentialsSummary', label: 'Zugangsdaten', kind: 'credentials', editable: false },
]

const gridModules = [AllCommunityModule]
const gridTheme = themeBalham.withParams({
  accentColor: '#737373',
  backgroundColor: '#ffffff',
  borderColor: '#e5e5e5',
  foregroundColor: '#171717',
  headerBackgroundColor: '#fafafa',
  headerTextColor: '#171717',
  rowHoverColor: '#fafafa',
  selectedRowBackgroundColor: '#f5f5f5',
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  borderRadius: 0,
  fontFamily: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
  fontSize: 13,
  dataFontSize: 13,
  headerFontWeight: 600,
})

export function SpreadsheetGrid({ devices, dataFields, credentials, notify, onDevicesSaved, onAddField, onEditField }: Props) {
  const [rows, setRows] = useState<GridRow[]>(() => makeRows(devices, dataFields, credentials))
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<ActiveCell>(null)
  const [selectedColumnId, setSelectedColumnId] = useState<string>(dataFields[0] ? `data:${dataFields[0].key}` : 'baseUrl')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({})
  const [gridHeight, setGridHeight] = useState(getGridHeight)
  const rowsRef = useRef(rows)
  const devicesRef = useRef(devices)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const savedTimer = useRef<number | undefined>(undefined)
  const saveSequence = useRef(0)

  const columnModels = useMemo<GridColumn[]>(() => [
    ...baseColumns,
    ...dataFields.map((field) => ({ id: `data:${field.key}`, key: field.key, label: field.label, token: `{{data.${field.key}}}`, kind: 'data' as const, editable: true, field })),
  ], [dataFields])
  const columnMap = useMemo(() => new Map(columnModels.map((column) => [column.id, column])), [columnModels])
  const variableColumns = useMemo(() => columnModels.filter((column) => column.token), [columnModels])
  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) => Object.entries(row).some(([key, value]) => !key.startsWith('_') && value.toLowerCase().includes(needle)))
  }, [rows, search])
  const selectedColumn = columnMap.get(selectedColumnId) ?? variableColumns[0]
  const activeRow = active ? rows.find((row) => row.id === active.rowId) : undefined
  const activeColumn = active ? columnMap.get(active.columnId) : undefined

  rowsRef.current = rows
  devicesRef.current = devices

  useEffect(() => {
    setRows(makeRows(devices, dataFields, credentials))
  }, [credentials, dataFields, devices])
  useEffect(() => {
    const updateHeight = () => setGridHeight(getGridHeight())
    window.addEventListener('resize', updateHeight)
    return () => {
      window.removeEventListener('resize', updateHeight)
      window.clearTimeout(savedTimer.current)
    }
  }, [])

  const commitRows = useCallback((changedRows: GridRow[]) => {
    window.clearTimeout(savedTimer.current)
    const sequence = ++saveSequence.current
    const operation = saveQueue.current.catch(() => undefined).then(async () => {
      setSaveState('saving')
      const saved = await Promise.all(changedRows.map((row) => {
        const original = devicesRef.current.find((device) => device.id === row.id)
        if (!original) throw new Error('Das bearbeitete Gerät wurde nicht gefunden.')
        const data = Object.fromEntries(dataFields.map((field) => [field.key, row[field.key] ?? '']))
        return patch<Device>(`/api/devices/${row.id}`, { name: row.name, baseUrl: row.baseUrl, data })
      }))
      onDevicesSaved(saved)
      if (sequence === saveSequence.current) {
        setSaveState('saved')
        savedTimer.current = window.setTimeout(() => setSaveState('idle'), 1800)
      }
    })
    saveQueue.current = operation.catch((error) => {
      if (sequence === saveSequence.current) setSaveState('error')
      notify(error instanceof Error ? error.message : String(error), 'error')
    })
    return operation
  }, [dataFields, notify, onDevicesSaved])

  const updateAndCommitRows = useCallback((updates: GridRow[], message?: string) => {
    if (!updates.length) return
    const byId = new Map(updates.map((row) => [row.id, row]))
    setRows((current) => current.map((row) => byId.get(row.id) ?? row))
    void commitRows(updates).then(() => { if (message) notify(message) }).catch(() => undefined)
  }, [commitRows, notify])

  const togglePassword = useCallback(async (credentialId: string) => {
    if (Object.hasOwn(revealedPasswords, credentialId)) {
      setRevealedPasswords((current) => { const next = { ...current }; delete next[credentialId]; return next })
      return
    }
    try {
      const result = await api<{ password: string }>(`/api/credentials/${credentialId}/secret`)
      setRevealedPasswords((current) => ({ ...current, [credentialId]: result.password }))
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [notify, revealedPasswords])

  const gridColumns = useMemo<ColDef<GridRow>[]>(() => [
    {
      colId: '__rowNumber',
      headerName: '#',
      valueGetter: ({ node }) => (node?.rowIndex ?? 0) + 2,
      width: 46,
      minWidth: 46,
      maxWidth: 46,
      resizable: false,
      editable: false,
      sortable: false,
      suppressMovable: true,
      cellClass: 'asc-ag-row-number',
      headerClass: 'asc-ag-row-number',
    },
    ...columnModels.map((model, columnIndex): ColDef<GridRow> => ({
      colId: model.id,
      field: model.key,
      headerComponent: GridHeader,
      headerComponentParams: { model, columnIndex, onSelect: setSelectedColumnId, onEdit: onEditField },
      editable: model.editable,
      suppressPaste: !model.editable,
      sortable: false,
      filter: false,
      resizable: true,
      suppressMovable: true,
      flex: 1,
      width: model.kind === 'baseUrl' ? 190 : model.kind === 'name' ? 150 : model.kind === 'credentials' ? 220 : 150,
      minWidth: model.kind === 'baseUrl' ? 170 : model.kind === 'credentials' ? 200 : 130,
      cellClass: model.kind === 'baseUrl' ? 'asc-ag-url' : model.kind === 'name' ? 'asc-ag-name' : model.kind === 'credentials' ? 'asc-ag-credential' : undefined,
      cellRenderer: model.kind === 'credentials' ? CredentialRenderer : undefined,
      cellRendererParams: model.kind === 'credentials' ? { revealedPasswords, togglePassword: (credentialId: string) => { void togglePassword(credentialId) } } : undefined,
    })),
  ], [columnModels, onEditField, revealedPasswords, togglePassword])

  const handleCellFocused = useCallback((event: CellFocusedEvent<GridRow>) => {
    if (event.rowIndex == null || !event.column) return
    const columnId = typeof event.column === 'string' ? event.column : event.column.getColId()
    const model = columnMap.get(columnId)
    const row = visibleRows[event.rowIndex]
    if (!model || !row) return
    setActive({ rowId: row.id, columnId: model.id, rowIndex: event.rowIndex })
    if (model.token) setSelectedColumnId(model.id)
  }, [columnMap, visibleRows])

  const handleCellValueChanged = useCallback((event: CellValueChangedEvent<GridRow>) => {
    if (!event.data || event.colDef.editable !== true) return
    updateAndCommitRows([{ ...event.data }])
  }, [updateAndCommitRows])

  const handleCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!activeRow || !activeColumn || isTextInput(event.target)) return
    const value = activeColumn.kind === 'credentials' ? activeRow.credentialsSummary : activeRow[activeColumn.key] ?? ''
    event.clipboardData.setData('text/plain', value)
    event.preventDefault()
  }

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!active || !activeColumn?.editable || isTextInput(event.target)) return
    const text = event.clipboardData.getData('text/plain')
    if (!text && !event.clipboardData.types.includes('text/plain')) return
    event.preventDefault()
    event.stopPropagation()
    const matrix = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((line) => line.split('\t'))
    const startColumn = columnModels.findIndex((column) => column.id === activeColumn.id)
    const updates = new Map<string, GridRow>()
    for (let rowOffset = 0; rowOffset < matrix.length; rowOffset++) {
      const target = visibleRows[active.rowIndex + rowOffset]
      if (!target) break
      const updated = { ...target }
      for (let columnOffset = 0; columnOffset < matrix[rowOffset].length; columnOffset++) {
        const column = columnModels[startColumn + columnOffset]
        if (!column) break
        if (!column.editable) continue
        updated[column.key] = matrix[rowOffset][columnOffset]
      }
      updates.set(updated.id, updated)
    }
    updateAndCommitRows([...updates.values()], `${updates.size} Tabellenzeile${updates.size === 1 ? '' : 'n'} eingefügt.`)
  }

  const selectedValue = activeRow && activeColumn
    ? activeColumn.kind === 'credentials' && Object.hasOwn(revealedPasswords, activeRow._credentialId)
      ? `${activeRow.credentialProfile} · ${activeRow.credentialUsername} · ${revealedPasswords[activeRow._credentialId] || 'Leer'}`
      : activeRow[activeColumn.key] ?? ''
    : ''
  const activeColumnIndex = activeColumn ? columnModels.findIndex((column) => column.id === activeColumn.id) : -1
  const address = active && activeColumnIndex >= 0 ? `${columnLetter(activeColumnIndex)}${active.rowIndex + 2}` : '—'

  return <div className="overflow-hidden rounded-xl border bg-background">
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2">
      <div className="relative min-w-56 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"/><Input className="h-8 bg-background pl-8" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tabelle durchsuchen …"/></div>
      <div className="hidden h-5 w-px bg-border sm:block"/>
      <Braces className="size-4 text-muted-foreground"/>
      <Select className="w-52 bg-background" value={selectedColumn?.id ?? ''} onChange={(event) => setSelectedColumnId(event.target.value)} aria-label="Variable auswählen">{variableColumns.map((column) => <option value={column.id} key={column.id}>{column.label}</option>)}</Select>
      <code className="hidden max-w-52 truncate rounded border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground lg:block">{selectedColumn?.token}</code>
      <Button variant="secondary" icon={<Copy/>} onClick={() => { if (selectedColumn?.token) void navigator.clipboard.writeText(selectedColumn.token).then(() => notify(`Variable ${selectedColumn.token} kopiert.`)) }}>Kopieren</Button>
      {selectedColumn?.field && <Button variant="ghost" size="icon" aria-label={`${selectedColumn.label} bearbeiten`} onClick={() => onEditField(selectedColumn.field!)}><Pencil/></Button>}
      <Button variant="secondary" icon={<Plus/>} onClick={onAddField}>Spalte</Button>
      <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">{saveState === 'saving' && <><LoaderCircle className="size-3.5 animate-spin"/>Speichert …</>}{saveState === 'saved' && <><Check className="size-3.5 text-emerald-600"/>Gespeichert</>}{saveState === 'error' && <span className="text-red-600">Fehler beim Speichern</span>}{saveState === 'idle' && `${visibleRows.length} Zeilen`}</span>
    </div>

    <div className="grid grid-cols-[54px_28px_minmax(0,1fr)] items-center border-b bg-background">
      <div className="border-r px-2 py-1.5 text-center font-mono text-xs text-muted-foreground">{address}</div>
      <div className="text-center font-serif text-sm italic text-muted-foreground">fx</div>
      <input className="h-8 min-w-0 border-0 bg-transparent px-2 text-sm outline-none disabled:text-muted-foreground" value={selectedValue} disabled={!activeRow || !activeColumn?.editable} aria-label="Wert der aktiven Zelle" placeholder={activeColumn && !activeColumn.editable ? 'Diese Spalte ist nur zur Anzeige' : 'Zelle auswählen, um den Wert zu bearbeiten'} onChange={(event) => { if (!activeRow || !activeColumn?.editable) return; const updated = { ...activeRow, [activeColumn.key]: event.target.value }; setRows((current) => current.map((row) => row.id === updated.id ? updated : row)) }} onBlur={() => { if (!activeColumn?.editable) return; const row = active ? rowsRef.current.find((item) => item.id === active.rowId) : undefined; if (row) void commitRows([row]).catch(() => undefined) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}/>
    </div>

    <div className="asc-ag-grid" style={{ height: gridHeight }} onCopyCapture={handleCopy} onPasteCapture={handlePaste}>
      <AgGridReact<GridRow>
        modules={gridModules}
        theme={gridTheme}
        rowData={visibleRows}
        columnDefs={gridColumns}
        getRowId={({ data }) => data.id}
        rowHeight={48}
        headerHeight={62}
        defaultColDef={{ suppressHeaderMenuButton: true }}
        singleClickEdit={false}
        stopEditingWhenCellsLoseFocus
        suppressRowClickSelection
        animateRows={false}
        onCellFocused={handleCellFocused}
        onCellValueChanged={handleCellValueChanged}
        overlayNoRowsTemplate={rows.length ? 'Keine Treffer für diese Suche.' : 'Noch keine Geräte. Lege zuerst unter „Geräte“ eine Zeile an.'}
      />
    </div>

    <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground"><span><strong className="font-medium text-foreground">Wie in Excel:</strong> Zelle einmal auswählen, doppelklicken oder tippen zum Bearbeiten</span><span><kbd className="rounded border bg-background px-1.5 py-0.5 font-mono">Tab</kbd> nächste Zelle · <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono">Enter</kbd> übernehmen · <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono">⌘C / ⌘V</kbd> kopieren und einfügen</span></div>
  </div>
}

function GridHeader({ model, columnIndex, onSelect, onEdit }: HeaderParams) {
  return <div className="flex h-full min-w-0 items-center gap-1.5 text-foreground">
    {model.token ? <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(model.id)}><span className="mb-0.5 block font-mono text-[9px] font-normal text-muted-foreground">{columnLetter(columnIndex)}</span><span className="block truncate text-xs font-semibold">{model.label}</span><code className="block truncate font-mono text-[9px] font-normal text-muted-foreground">{model.token}</code></button> : <div className="min-w-0 flex-1"><span className="mb-0.5 block font-mono text-[9px] font-normal text-muted-foreground">{columnLetter(columnIndex)}</span><span className="block truncate text-xs font-semibold">{model.label}</span><small className="block truncate text-[9px] font-normal text-muted-foreground">Profil · Benutzer · Passwort</small></div>}
    {model.field && <Button variant="ghost" size="icon-xs" aria-label={`${model.label} bearbeiten`} onClick={(event) => { event.stopPropagation(); onEdit(model.field!) }}><Pencil/></Button>}
  </div>
}

function CredentialRenderer({ data, revealedPasswords, togglePassword }: CredentialRendererParams) {
  if (!data) return null
  const credentialId = data._credentialId
  const hasPassword = data._hasPassword === 'true'
  if (!credentialId) return <span className="truncate text-muted-foreground">Nicht zugewiesen</span>
  const revealed = Object.hasOwn(revealedPasswords, credentialId)
  const password = revealed ? revealedPasswords[credentialId] || 'Leer' : hasPassword ? '••••••••' : 'Kein Passwort'
  return <div className="flex min-w-0 flex-1 items-center gap-1.5 leading-tight">
    <div className="min-w-0 flex-1">
      <strong className="block truncate text-xs font-medium text-foreground">{data.credentialProfile}</strong>
      <span className="block truncate text-[10px] text-muted-foreground">{data.credentialUsername} · <span className={hasPassword ? 'font-mono' : undefined}>{password}</span></span>
    </div>
    {hasPassword && <Button variant="ghost" size="icon-xs" aria-label={revealed ? 'Passwort verbergen' : 'Passwort anzeigen'} title={revealed ? 'Passwort verbergen' : 'Passwort anzeigen'} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); togglePassword(credentialId) }}>{revealed ? <EyeOff/> : <Eye/>}</Button>}
  </div>
}

function makeRows(devices: Device[], fields: DataField[], credentials: Credential[]): GridRow[] {
  const credentialMap = new Map(credentials.map((credential) => [credential.id, credential]))
  return devices.map((device) => {
    const credential = device.credentialId ? credentialMap.get(device.credentialId) : undefined
    return {
      id: device.id,
      name: device.name,
      baseUrl: device.baseUrl,
      _credentialId: credential?.id ?? '',
      _hasPassword: String(Boolean(credential?.hasPassword)),
      credentialProfile: credential?.name ?? 'Nicht zugewiesen',
      credentialUsername: credential?.username || (credential ? 'Kein Benutzername' : '—'),
      credentialsSummary: credential
        ? `${credential.name} · ${credential.username || 'Kein Benutzername'} · ${credential.hasPassword ? '••••••••' : 'Kein Passwort'}`
        : 'Nicht zugewiesen',
      ...Object.fromEntries(fields.map((field) => [field.key, device.data[field.key] ?? ''])),
    }
  })
}

function getGridHeight() {
  if (typeof window === 'undefined') return 360
  return Math.max(240, Math.min(560, window.innerHeight - 380))
}

function isTextInput(target: EventTarget) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

function columnLetter(index: number) {
  let value = index + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}
