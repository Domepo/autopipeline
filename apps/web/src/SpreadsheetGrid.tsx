import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from 'react'
import { Braces, Check, Copy, Eye, EyeOff, FileDown, LoaderCircle, Minus, Pencil, Plus, Search } from 'lucide-react'
import { AgGridReact, type CustomCellRendererProps, type CustomHeaderProps } from 'ag-grid-react'
import {
  AllCommunityModule,
  themeBalham,
  type CellFocusedEvent,
  type CellClickedEvent,
  type CellValueChangedEvent,
  type ColDef,
} from 'ag-grid-community'
import type { Artifact, Credential, DataField, Device } from '@autosecure/shared'
import { api, patch } from './api.ts'
import { Button, Input, Select } from './components.tsx'

type GridRow = { id: string; [key: string]: string }

type GridColumn = {
  id: string
  key: string
  label: string
  token?: string
  kind: 'name' | 'baseUrl' | 'credentials' | 'files' | 'data'
  editable: boolean
  field?: DataField
}

type ActiveCell = { rowId: string; columnId: string; rowIndex: number } | null
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type HeaderParams = CustomHeaderProps<GridRow> & {
  model: GridColumn
  columnIndex: number
  zoom: number
  onSelect: (id: string) => void
  onEdit: (field: DataField) => void
}
type CredentialRendererParams = CustomCellRendererProps<GridRow> & {
  zoom: number
  revealedPasswords: Record<string, string>
  togglePassword: (credentialId: string) => void
  onEditCredentials: (deviceId: string) => void
}
type FileRendererParams = CustomCellRendererProps<GridRow> & { zoom: number; onViewFiles: (deviceId: string) => void }

type Props = {
  expanded?: boolean
  toolbarActions?: ReactNode
  devices: Device[]
  dataFields: DataField[]
  credentials: Credential[]
  artifacts: Artifact[]
  notify: (message: string, tone?: 'success' | 'error') => void
  onDevicesSaved: (devices: Device[]) => void
  onAddField: () => void
  onEditField: (field: DataField) => void
  onViewFiles: (deviceId: string) => void
  onEditCredentials: (deviceId: string) => void
}

const baseColumns: GridColumn[] = [
  { id: 'name', key: 'name', label: 'Gerät', token: '{{device.name}}', kind: 'name', editable: true },
  { id: 'baseUrl', key: 'baseUrl', label: 'Start-URL', token: '{{device.baseUrl}}', kind: 'baseUrl', editable: true },
  { id: 'credentials', key: 'credentialsSummary', label: 'Zugangsdaten', kind: 'credentials', editable: false },
  { id: 'files', key: 'filesSummary', label: 'Dateien', kind: 'files', editable: false },
]

const gridModules = [AllCommunityModule]
const makeGridTheme = (zoom: number) => themeBalham.withParams({
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
  fontSize: Math.round(13 * zoom / 100),
  dataFontSize: Math.round(13 * zoom / 100),
  headerFontWeight: 600,
})

export function SpreadsheetGrid({ expanded = false, toolbarActions, devices, dataFields, credentials, artifacts, notify, onDevicesSaved, onAddField, onEditField, onViewFiles, onEditCredentials }: Props) {
  const [rows, setRows] = useState<GridRow[]>(() => makeRows(devices, dataFields, credentials, artifacts))
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<ActiveCell>(null)
  const [selectedColumnId, setSelectedColumnId] = useState<string>(dataFields[0] ? `data:${dataFields[0].key}` : 'baseUrl')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({})
  const [gridHeight, setGridHeight] = useState(getGridHeight)
  const [zoom, setZoom] = useState(() => {
    const saved = Number(localStorage.getItem('asc-grid-zoom'))
    return saved >= 70 && saved <= 150 && saved % 10 === 0 ? saved : 100
  })
  const rowsRef = useRef(rows)
  const devicesRef = useRef(devices)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const savedTimer = useRef<number | undefined>(undefined)
  const saveSequence = useRef(0)
  const gridTheme = useMemo(() => makeGridTheme(zoom), [zoom])
  const scale = zoom / 100
  const changeZoom = (step: -10 | 10) => setZoom((current) => {
    const next = Math.min(150, Math.max(70, current + step))
    localStorage.setItem('asc-grid-zoom', String(next))
    return next
  })

  const columnModels = useMemo<GridColumn[]>(() => [
    ...baseColumns,
    ...dataFields.map((field) => ({ id: `data:${field.key}`, key: field.key, label: field.label, token: `{{data.${field.key}}}`, kind: 'data' as const, editable: field.type !== 'file', field })),
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
    setRows(makeRows(devices, dataFields, credentials, artifacts))
  }, [artifacts, credentials, dataFields, devices])
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
      width: Math.round(46 * scale),
      minWidth: Math.round(46 * scale),
      maxWidth: Math.round(46 * scale),
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
      headerComponentParams: { model, columnIndex, zoom, onSelect: setSelectedColumnId, onEdit: onEditField },
      editable: model.editable,
      suppressPaste: !model.editable,
      sortable: false,
      filter: false,
      resizable: true,
      suppressMovable: true,
      flex: 1,
      width: Math.round((model.kind === 'baseUrl' ? 190 : model.kind === 'name' ? 150 : model.kind === 'credentials' ? 220 : model.kind === 'files' ? 210 : 150) * scale),
      minWidth: Math.round((model.kind === 'baseUrl' ? 170 : model.kind === 'credentials' ? 200 : model.kind === 'files' ? 180 : 130) * scale),
      cellClass: model.kind === 'baseUrl' ? 'asc-ag-url' : model.kind === 'name' ? 'asc-ag-name' : model.kind === 'credentials' ? 'asc-ag-credential' : undefined,
      cellRenderer: model.kind === 'credentials' ? CredentialRenderer : model.kind === 'files' ? FileRenderer : model.field?.type === 'file' ? ({ value }: CustomCellRendererProps<GridRow>) => {
        const artifact = artifacts.find((item) => item.id === value)
        return artifact ? <a href={artifact.downloadUrl} download className="flex items-center gap-2 truncate text-blue-700 hover:underline" onClick={(event) => event.stopPropagation()}><FileDown className="size-4 shrink-0"/>{displayArtifactName(artifact)}</a> : <span className="text-muted-foreground">{value ? 'Datei nicht mehr vorhanden' : 'Keine Datei'}</span>
      } : undefined,
      cellRendererParams: model.kind === 'credentials'
        ? { zoom, revealedPasswords, togglePassword: (credentialId: string) => { void togglePassword(credentialId) }, onEditCredentials }
        : model.kind === 'files' ? { zoom, onViewFiles } : undefined,
    })),
  ], [artifacts, columnModels, onEditField, onViewFiles, onEditCredentials, revealedPasswords, togglePassword, zoom, scale])

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

  const handleCellClicked = useCallback((event: CellClickedEvent<GridRow>) => {
    if (event.column.getColId() === 'credentials' && event.data) onEditCredentials(event.data.id)
  }, [onEditCredentials])

  const handleCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (!activeRow || !activeColumn || isTextInput(event.target)) return
    const value = activeColumn.kind === 'credentials' ? activeRow.credentialsSummary : activeColumn.field?.type === 'file'
      ? artifacts.find((artifact) => artifact.id === activeRow[activeColumn.key])?.name ?? ''
      : activeRow[activeColumn.key] ?? ''
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
      : activeColumn.field?.type === 'file'
        ? artifacts.find((artifact) => artifact.id === activeRow[activeColumn.key])?.name ?? (activeRow[activeColumn.key] ? 'Datei nicht mehr vorhanden' : '')
        : activeRow[activeColumn.key] ?? ''
    : ''
  const activeColumnIndex = activeColumn ? columnModels.findIndex((column) => column.id === activeColumn.id) : -1
  const address = active && activeColumnIndex >= 0 ? `${columnLetter(activeColumnIndex)}${active.rowIndex + 2}` : '—'

  return <div className={expanded ? 'flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background' : 'overflow-hidden rounded-xl border bg-background'}>
    <div className="flex min-h-12 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2">
      <div className="relative min-w-56 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"/><Input className="h-8 bg-background pl-8" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tabelle durchsuchen …"/></div>
      <div className="hidden h-5 w-px bg-border sm:block"/>
      <Braces className="size-4 text-muted-foreground"/>
      <Select className={`${expanded ? 'w-40' : 'w-52'} bg-background`} value={selectedColumn?.id ?? ''} onChange={(event) => setSelectedColumnId(event.target.value)} aria-label="Variable auswählen">{variableColumns.map((column) => <option value={column.id} key={column.id}>{column.label}</option>)}</Select>
      <code className="hidden max-w-52 truncate rounded border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground lg:block">{selectedColumn?.token}</code>
      <Button variant="secondary" icon={<Copy/>} onClick={() => { if (selectedColumn?.token) void navigator.clipboard.writeText(selectedColumn.token).then(() => notify(`Variable ${selectedColumn.token} kopiert.`)) }}>Kopieren</Button>
      {!expanded && selectedColumn?.field && <Button variant="ghost" size="icon" aria-label={`${selectedColumn.label} bearbeiten`} onClick={() => onEditField(selectedColumn.field!)}><Pencil/></Button>}
      {!expanded && <Button variant="secondary" icon={<Plus/>} onClick={onAddField}>Spalte</Button>}
      <div className="flex items-center rounded-lg border bg-background" aria-label="Tabellengröße">
        <Button variant="ghost" size="icon-sm" aria-label="Tabelle verkleinern" title="Tabelle verkleinern" disabled={zoom === 70} onClick={() => changeZoom(-10)}><Minus/></Button>
        <span className="w-11 text-center text-xs tabular-nums" aria-live="polite">{zoom}%</span>
        <Button variant="ghost" size="icon-sm" aria-label="Tabelle vergrößern" title="Tabelle vergrößern" disabled={zoom === 150} onClick={() => changeZoom(10)}><Plus/></Button>
      </div>
      {toolbarActions}
      {!expanded && <span className="ml-auto text-xs text-muted-foreground">{visibleRows.length} Zeilen</span>}
    </div>

    <div className="grid grid-cols-[54px_28px_minmax(0,1fr)] items-center border-b bg-background">
      <div className="border-r px-2 py-1.5 text-center font-mono text-xs text-muted-foreground">{address}</div>
      <div className="text-center font-serif text-sm italic text-muted-foreground">fx</div>
      <input className="h-8 min-w-0 border-0 bg-transparent px-2 text-sm outline-none disabled:text-muted-foreground" value={selectedValue} disabled={!activeRow || !activeColumn?.editable} aria-label="Wert der aktiven Zelle" placeholder={activeColumn && !activeColumn.editable ? 'Diese Spalte ist nur zur Anzeige' : 'Zelle auswählen, um den Wert zu bearbeiten'} onChange={(event) => { if (!activeRow || !activeColumn?.editable) return; const updated = { ...activeRow, [activeColumn.key]: event.target.value }; setRows((current) => current.map((row) => row.id === updated.id ? updated : row)) }} onBlur={() => { if (!activeColumn?.editable) return; const row = active ? rowsRef.current.find((item) => item.id === active.rowId) : undefined; if (row) void commitRows([row]).catch(() => undefined) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}/>
    </div>

    <div className={expanded ? 'asc-ag-grid min-h-0 flex-1' : 'asc-ag-grid'} style={expanded ? undefined : { height: gridHeight }} onCopyCapture={handleCopy} onPasteCapture={handlePaste}>
      <AgGridReact<GridRow>
        modules={gridModules}
        theme={gridTheme}
        rowData={visibleRows}
        columnDefs={gridColumns}
        getRowId={({ data }) => data.id}
        rowHeight={Math.round(48 * scale)}
        headerHeight={Math.round(62 * scale)}
        defaultColDef={{ suppressHeaderMenuButton: true }}
        singleClickEdit={false}
        stopEditingWhenCellsLoseFocus
        suppressRowClickSelection
        animateRows={false}
        onCellFocused={handleCellFocused}
        onCellClicked={handleCellClicked}
        onCellValueChanged={handleCellValueChanged}
        overlayNoRowsTemplate={rows.length ? 'Keine Treffer für diese Suche.' : 'Noch keine Geräte. Lege zuerst unter „Geräte“ eine Zeile an.'}
      />
    </div>

    <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      {expanded && <span className="tabular-nums">{visibleRows.length} Zeilen</span>}
      <span><strong className="font-medium text-foreground">Wie in Excel:</strong> Zelle einmal auswählen, doppelklicken oder tippen zum Bearbeiten</span>
      <span className="hidden xl:inline"><kbd className="rounded border bg-background px-1.5 py-0.5 font-mono">Tab</kbd> nächste Zelle · <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono">Enter</kbd> übernehmen · <kbd className="rounded border bg-background px-1.5 py-0.5 font-mono">⌘C / ⌘V</kbd> kopieren und einfügen</span>
      <span className="ml-auto flex w-32 shrink-0 items-center justify-end gap-1.5" aria-live="polite">
        {saveState === 'saving' && <><LoaderCircle className="size-3.5 animate-spin"/>Speichert …</>}
        {saveState === 'saved' && <><Check className="size-3.5 text-emerald-600"/>Gespeichert</>}
        {saveState === 'error' && <span className="text-red-600">Fehler beim Speichern</span>}
        {saveState === 'idle' && <span className="invisible">Gespeichert</span>}
      </span>
    </div>
  </div>
}

function GridHeader({ model, columnIndex, zoom = 100, onSelect, onEdit }: HeaderParams) {
  const scale = zoom / 100
  return <div className="flex h-full min-w-0 items-center gap-1.5 text-foreground">
    {model.token ? <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(model.id)}><span className="mb-0.5 block font-mono font-normal text-muted-foreground" style={{ fontSize: 9 * scale }}>{columnLetter(columnIndex)}</span><span className="block truncate font-semibold" style={{ fontSize: 12 * scale }}>{model.label}</span><code className="block truncate font-mono font-normal text-muted-foreground" style={{ fontSize: 9 * scale }}>{model.token}</code></button> : <div className="min-w-0 flex-1"><span className="mb-0.5 block font-mono font-normal text-muted-foreground" style={{ fontSize: 9 * scale }}>{columnLetter(columnIndex)}</span><span className="block truncate font-semibold" style={{ fontSize: 12 * scale }}>{model.label}</span><small className="block truncate font-normal text-muted-foreground" style={{ fontSize: 9 * scale }}>{model.kind === 'files' ? 'Downloads aus Läufen' : 'Profil · Benutzer · Passwort'}</small></div>}
    {model.field && <Button variant="ghost" size="icon-xs" aria-label={`${model.label} bearbeiten`} onClick={(event) => { event.stopPropagation(); onEdit(model.field!) }}><Pencil/></Button>}
  </div>
}

function FileRenderer({ data, zoom = 100, onViewFiles }: FileRendererParams) {
  if (!data) return null
  const count = Number(data._fileCount || 0)
  if (!count) return <span className="truncate text-muted-foreground">Keine Dateien</span>
  return <button type="button" className="flex min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-blue-50" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onViewFiles(data.id) }}><span className="grid size-7 shrink-0 place-items-center rounded-md bg-blue-50 text-blue-700"><FileDown className="size-3.5"/></span><span className="grid min-w-0"><strong className="truncate font-medium" style={{ fontSize: 12 * zoom / 100 }}>{count} {count === 1 ? 'Datei' : 'Dateien'}</strong><small className="truncate text-muted-foreground" style={{ fontSize: 10 * zoom / 100 }}>{data._latestFileName}</small></span></button>
}

function CredentialRenderer({ data, zoom = 100, revealedPasswords, togglePassword, onEditCredentials }: CredentialRendererParams) {
  if (!data) return null
  const credentialId = data._credentialId
  const hasPassword = data._hasPassword === 'true'
  if (!credentialId) return <button type="button" className="truncate text-left text-muted-foreground hover:text-blue-700 hover:underline" onClick={(event) => { event.stopPropagation(); onEditCredentials(data.id) }}>Nicht zugewiesen</button>
  const revealed = Object.hasOwn(revealedPasswords, credentialId)
  const password = revealed ? revealedPasswords[credentialId] || 'Leer' : hasPassword ? '••••••••' : 'Kein Passwort'
  return <div className="flex min-w-0 flex-1 items-center gap-1.5 leading-tight">
    <button type="button" className="min-w-0 flex-1 text-left hover:text-blue-700 hover:underline" onClick={(event) => { event.stopPropagation(); onEditCredentials(data.id) }}>
      <strong className="block truncate font-medium text-foreground" style={{ fontSize: 12 * zoom / 100 }}>{data.credentialProfile}</strong>
      <span className="block truncate text-muted-foreground" style={{ fontSize: 10 * zoom / 100 }}>{data.credentialUsername} · <span className={hasPassword ? 'font-mono' : undefined}>{password}</span></span>
    </button>
    {hasPassword && <Button variant="ghost" size="icon-xs" aria-label={revealed ? 'Passwort verbergen' : 'Passwort anzeigen'} title={revealed ? 'Passwort verbergen' : 'Passwort anzeigen'} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); togglePassword(credentialId) }}>{revealed ? <EyeOff/> : <Eye/>}</Button>}
  </div>
}

function makeRows(devices: Device[], fields: DataField[], credentials: Credential[], artifacts: Artifact[]): GridRow[] {
  const credentialMap = new Map(credentials.map((credential) => [credential.id, credential]))
  const filesByDevice = new Map<string, Artifact[]>()
  for (const artifact of artifacts) {
    if (!artifact.deviceId || artifact.kind !== 'download') continue
    const items = filesByDevice.get(artifact.deviceId) ?? []
    items.push(artifact)
    filesByDevice.set(artifact.deviceId, items)
  }
  return devices.map((device) => {
    const credential = device.credentialId ? credentialMap.get(device.credentialId) : undefined
    const files = filesByDevice.get(device.id) ?? []
    const latest = files[0]
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
      _fileCount: String(files.length),
      _latestFileName: latest ? displayArtifactName(latest) : '',
      filesSummary: files.length ? `${files.length} ${files.length === 1 ? 'Datei' : 'Dateien'} · ${displayArtifactName(latest)}` : 'Keine Dateien',
      ...Object.fromEntries(fields.map((field) => [field.key, device.data[field.key] ?? ''])),
    }
  })
}

function displayArtifactName(artifact: Artifact) {
  const prefix = artifact.artifactKey ? `${artifact.artifactKey}__` : ''
  return prefix && artifact.name.startsWith(prefix) ? artifact.name.slice(prefix.length) : artifact.name
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
