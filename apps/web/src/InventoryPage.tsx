import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, CircleStop, Clock3, Copy, Download, FileImage, Globe2, GripVertical, History, KeyRound, Layers3, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Save, Search, Server, SkipForward, Trash2, Workflow, X } from 'lucide-react'
import type { Artifact, Credential, Device, Pipeline, PipelineGroup, Run, RunStatus } from '@autosecure/shared'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { api, patch, post, remove } from './api.ts'
import { Badge, Button, ConfirmButton, Empty, Field, FormActions, formatBytes, formatDate, Input, Modal, Notice, Select, submitForm } from './components.tsx'
import { InventoryDialogs, type InventoryAction } from './InventoryDialogs.tsx'
import { inspectDevicePlan } from './run-preflight.ts'

const statusLabel: Record<RunStatus, string> = { queued: 'Warteschlange', running: 'Läuft', paused: 'Pausiert', completed: 'Erfolgreich', failed: 'Fehlgeschlagen', stopped: 'Gestoppt', interrupted: 'Unterbrochen' }
const statusTone: Record<RunStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { queued: 'neutral', running: 'info', paused: 'warning', completed: 'success', failed: 'danger', stopped: 'neutral', interrupted: 'danger' }

interface InventoryPageProps {
  runs: Run[]
  devices: Device[]
  credentials: Credential[]
  pipelines: Pipeline[]
  pipelineGroups: PipelineGroup[]
  artifacts: Artifact[]
  reload: () => Promise<void>
  notify: (message: string, tone?: 'success' | 'error') => void
}

export function InventoryPage({ runs, devices, credentials, pipelines, pipelineGroups, artifacts, reload, notify }: InventoryPageProps) {
  const sourceDeviceIds = useMemo(() => new Set(pipelines.flatMap((pipeline) => pipeline.steps.flatMap((step) => step.type === 'discoverDevices' && step.sourceDeviceId ? [step.sourceDeviceId] : []))), [pipelines])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Run | null>(null)
  const [duplicateDevice, setDuplicateDevice] = useState<Device | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'ready' | 'unconfigured'>('all')
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([])
  const [bulkAutomationModal, setBulkAutomationModal] = useState(false)
  const [bulkCredentialModal, setBulkCredentialModal] = useState(false)
  const [startingDeviceId, setStartingDeviceId] = useState<string | null>(null)
  const [pendingRunDevice, setPendingRunDevice] = useState<Device | null>(null)
  const [deviceArtifacts, setDeviceArtifacts] = useState<Artifact[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [applyGroupModal, setApplyGroupModal] = useState(false)
  const [inventoryAction, setInventoryAction] = useState<InventoryAction | null>(null)
  const active = runs.find((run) => run.id === activeId)
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId)
  const normalizedQuery = query.trim().toLocaleLowerCase('de')
  const visibleDevices = devices.filter((device) => {
    if (filter === 'ready' && !device.pipelineIds.length) return false
    if (filter === 'unconfigured' && device.pipelineIds.length) return false
    const pipelineNames = device.pipelineIds.map((id) => pipelines.find((pipeline) => pipeline.id === id)?.name ?? '').join(' ')
    return !normalizedQuery || `${device.name} ${device.baseUrl} ${device.credentialName ?? ''} ${pipelineNames}`.toLocaleLowerCase('de').includes(normalizedQuery)
  })
  const selectedIds = new Set(selectedDeviceIds)
  const visibleSelectedCount = visibleDevices.filter((device) => selectedIds.has(device.id)).length
  const allVisibleSelected = visibleDevices.length > 0 && visibleSelectedCount === visibleDevices.length
  const selectedRuns = selectedDevice ? runs.filter((run) => run.deviceIds.includes(selectedDevice.id)).slice(0, 8) : []

  useEffect(() => {
    if (!active) { setDetail(null); return }
    void api<Run>(`/api/runs/${active.id}`).then(setDetail)
  }, [active?.id, active?.status, active?.currentStep, runs.length])
  useEffect(() => {
    let cancelled = false
    if (!selectedDevice) { setDeviceArtifacts([]); return }
    setArtifactsLoading(true)
    void api<Artifact[]>(`/api/devices/${selectedDevice.id}/artifacts`)
      .then((artifacts) => { if (!cancelled) setDeviceArtifacts(artifacts) })
      .catch((error) => { if (!cancelled) notify(error instanceof Error ? error.message : String(error), 'error') })
      .finally(() => { if (!cancelled) setArtifactsLoading(false) })
    return () => { cancelled = true }
  }, [notify, runs, selectedDevice?.id])

  const selectDevice = (device?: Device) => {
    if (!device) return
    setSelectedDeviceId(device.id)
    setActiveId(null)
  }
  const selectRun = (run: Run) => {
    setActiveId(run.id)
    const device = devices.find((candidate) => run.deviceIds.includes(candidate.id))
    if (device) setSelectedDeviceId(device.id)
  }
  const command = async (name: string) => {
    if (!active) return
    try { await post(`/api/runs/${active.id}/${name}`); await reload() }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const closeDetails = () => { setActiveId(null); setSelectedDeviceId(null) }
  const toggleDeviceSelection = (deviceId: string) => setSelectedDeviceIds((current) => current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId])
  const toggleVisibleSelection = () => setSelectedDeviceIds((current) => allVisibleSelected ? current.filter((id) => !visibleDevices.some((device) => device.id === id)) : [...new Set([...current, ...visibleDevices.map((device) => device.id)])])
  const activateDeviceRow = (device: Device) => {
    if (selectedDeviceIds.length > 0) toggleDeviceSelection(device.id)
    else selectDevice(device)
  }
  const executeDeviceRun = async (device: Device) => {
    setStartingDeviceId(device.id)
    try {
      const run = await post<Run>(`/api/devices/${device.id}/run`)
      await reload()
      selectRun(run)
      notify(sourceDeviceIds.has(device.id) ? `Synchronisierung über „${device.name}“ wurde gestartet.` : `Geräteablauf für „${device.name}“ wurde gestartet.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setStartingDeviceId(null) }
  }
  const startDevice = (device: Device) => {
    const warnings = inspectDevicePlan(device, pipelines, credentials, artifacts)
    if (warnings.length) setPendingRunDevice(device)
    else void executeDeviceRun(device)
  }

  return <>
    <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Gerätezentrum</p><h1 className="text-2xl font-semibold tracking-tight">Inventar</h1><p className="mt-0.5 text-xs text-muted-foreground">{devices.length} Geräte · {devices.filter((device) => device.pipelineIds.length > 0).length} mit Ablauf · {runs.filter((run) => ['queued', 'running', 'paused'].includes(run.status)).length} aktive Läufe</p></div>
      <div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="sm" icon={<RefreshCw/>} onClick={() => void reload()}>Aktualisieren</Button><Button variant="secondary" size="sm" icon={<KeyRound/>} onClick={() => setInventoryAction({ kind: 'credentials' })}>Zugangsdaten</Button><Button size="sm" icon={<Plus/>} onClick={() => setInventoryAction({ kind: 'new' })}>Gerät hinzufügen</Button></div>
    </header>
    <Card className="gap-0 overflow-hidden py-0 shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gerät, Zugang oder Automation suchen …" aria-label="Inventar durchsuchen"/></div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" aria-label="Geräte filtern">
          {([{ id: 'all', label: 'Alle' }, { id: 'ready', label: 'Mit Ablauf' }, { id: 'unconfigured', label: 'Ohne Ablauf' }] as const).map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', filter === item.id ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')} onClick={() => setFilter(item.id)}>{item.label}</button>)}
        </div>
      </div>
      {selectedDeviceIds.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b bg-blue-50 px-4 py-2.5 text-sm"><strong className="mr-auto text-blue-900">{selectedDeviceIds.length} {selectedDeviceIds.length === 1 ? 'Gerät' : 'Geräte'} ausgewählt</strong><Button size="sm" variant="secondary" icon={<KeyRound/>} title={!credentials.length ? 'Lege zuerst ein Zugangsdatenprofil an.' : undefined} disabled={!credentials.length} onClick={() => setBulkCredentialModal(true)}>Zugangsdaten zuweisen</Button><Button size="sm" variant="secondary" icon={<Plus/>} disabled={!pipelines.length} onClick={() => setBulkAutomationModal(true)}>Automation hinzufügen</Button><Button size="sm" icon={<Layers3/>} title={!pipelineGroups.length ? 'Speichere zuerst bei einem Gerät einen Ablauf als Vorlage.' : undefined} disabled={!pipelineGroups.length} onClick={() => setApplyGroupModal(true)}>Vorlage zuweisen</Button><Button size="sm" variant="ghost" onClick={() => setSelectedDeviceIds([])}>Auswahl aufheben</Button></div>}
      {visibleDevices.length ? <>
        <div className="hidden grid-cols-[minmax(170px,1.25fr)_minmax(135px,1fr)_minmax(125px,.8fr)_auto] items-center gap-3 border-b bg-muted/30 px-5 py-2 text-xs font-medium text-muted-foreground md:grid lg:grid-cols-[minmax(170px,1.25fr)_minmax(135px,1fr)_minmax(110px,.7fr)_minmax(125px,.8fr)_auto]"><span className="flex items-center gap-3"><input type="checkbox" className="size-4 accent-blue-600" aria-label="Alle sichtbaren Geräte auswählen" checked={allVisibleSelected} ref={(input) => { if (input) input.indeterminate = visibleSelectedCount > 0 && !allVisibleSelected }} onChange={toggleVisibleSelection}/>Gerät</span><span>Ablauf</span><span className="hidden lg:block">Zugangsdaten</span><span>Letzter Lauf</span><span className="text-right">Aktion</span></div>
        <div className="divide-y">{visibleDevices.map((device) => {
          const latest = runs.find((run) => run.deviceIds.includes(device.id))
          const inProgress = runs.find((run) => run.deviceIds.includes(device.id) && ['queued', 'running', 'paused'].includes(run.status))
          const source = sourceDeviceIds.has(device.id)
          const assigned = device.pipelineIds.map((id) => pipelines.find((pipeline) => pipeline.id === id)?.name).filter(Boolean)
          return <div key={device.id} onClick={(event) => {
            if ((event.target as HTMLElement).closest('button, input, select, a')) return
            activateDeviceRow(device)
          }} className={cn('grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-2.5 transition-colors hover:bg-muted/20 md:grid-cols-[minmax(170px,1.25fr)_minmax(135px,1fr)_minmax(125px,.8fr)_auto] md:gap-3 md:px-5 lg:grid-cols-[minmax(170px,1.25fr)_minmax(135px,1fr)_minmax(110px,.7fr)_minmax(125px,.8fr)_auto]', (selectedIds.has(device.id) || selectedDeviceId === device.id && !activeId) && 'bg-blue-50/70')}>
            <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3 md:col-auto md:row-auto"><input type="checkbox" className="size-4 shrink-0 accent-blue-600" aria-label={`${device.name} auswählen`} checked={selectedIds.has(device.id)} onChange={() => toggleDeviceSelection(device.id)}/><button type="button" className="group flex min-w-0 items-center gap-3 text-left" onClick={() => selectDevice(device)} aria-label={`Details zu ${device.name} öffnen`}><span className={cn('grid size-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700', source && 'bg-violet-50 text-violet-700')}>{source ? <Globe2 className="size-[17px]"/> : <Server className="size-[17px]"/>}</span><span className="grid min-w-0"><strong className="truncate text-sm font-semibold group-hover:text-blue-700">{device.name}</strong><small className="truncate font-mono text-[11px] text-muted-foreground">{device.baseUrl}</small></span></button></div>
            <div className="col-start-1 row-start-2 min-w-0 pl-[76px] md:col-auto md:row-auto md:pl-0">{assigned.length ? <><p className="truncate text-sm font-medium">{assigned.length === 1 ? assigned[0] : `${assigned[0]} + ${assigned.length - 1} weitere`}</p><p className="hidden text-xs text-muted-foreground md:block">{assigned.length} {assigned.length === 1 ? 'Automation' : 'Automationen'} · in Reihenfolge</p></> : <button type="button" className="text-left text-xs font-medium text-blue-700 hover:underline" onClick={() => selectDevice(device)}>Ablauf einrichten</button>}</div>
            <div className="hidden min-w-0 lg:block"><button type="button" className={cn('flex max-w-full items-center gap-1.5 truncate text-left text-xs hover:underline', device.credentialId ? 'text-blue-700' : 'text-muted-foreground hover:text-blue-700')} onClick={() => setInventoryAction({ kind: 'credentials', deviceId: device.id })}><KeyRound className="size-3.5 shrink-0"/><span className="truncate">{device.credentialName || 'Zuweisen'}</span></button></div>
            <div className="col-start-2 row-start-2 text-right md:col-auto md:row-auto md:text-left">{latest ? <button type="button" className="flex flex-wrap items-center justify-end gap-1.5 text-left md:justify-start" onClick={() => selectRun(latest)}><Badge tone={statusTone[latest.status]}>{statusLabel[latest.status]}</Badge><span className="hidden text-xs text-muted-foreground md:inline">{formatDate(latest.createdAt)}</span></button> : <span className="text-xs text-muted-foreground">Noch kein Lauf</span>}{inProgress?.status === 'running' && inProgress.totalSteps > 0 && <p className="mt-1 text-[11px] text-blue-700">Schritt {Math.min((inProgress.currentStep ?? 0) + 1, inProgress.totalSteps)} von {inProgress.totalSteps}</p>}</div>
            <div className="col-start-2 row-start-1 flex items-center justify-end gap-2 md:col-auto md:row-auto"><Button variant="ghost" size="sm" className="hidden md:inline-flex" onClick={() => selectDevice(device)}>Details <ChevronRight className="size-3.5"/></Button>{inProgress ? <Button variant="secondary" size="sm" onClick={() => selectRun(inProgress)}>Lauf ansehen</Button> : <Button size="sm" icon={<Play className="size-3.5"/>} disabled={!assigned.length || startingDeviceId === device.id} onClick={() => void startDevice(device)}>{startingDeviceId === device.id ? 'Startet …' : source ? 'Synchronisieren' : 'Starten'}</Button>}</div>
          </div>
        })}</div>
      </> : <Empty icon={<Server/>} title={devices.length ? 'Keine passenden Geräte' : 'Noch keine Geräte'} text={devices.length ? 'Passe Suche oder Filter an.' : 'Lege dein erstes Gerät an.'} action={!devices.length && <Button icon={<Plus/>} onClick={() => setInventoryAction({ kind: 'new' })}>Gerät hinzufügen</Button>}/>}
      <div className="border-t bg-muted/20 px-5 py-2.5 text-xs text-muted-foreground">{visibleDevices.length} von {devices.length} Geräten angezeigt</div>
    </Card>
    {(active || selectedDevice) && <aside className="fixed inset-y-0 right-0 z-40 w-full overflow-y-auto border-l bg-white shadow-2xl md:w-[min(480px,48vw)] lg:w-[480px] xl:w-[540px]" aria-label={active ? 'Laufdetails' : 'Gerätedetails'}>
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-5 py-2"><span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{active ? 'Laufdetails' : 'Gerätedetails'}</span><Button variant="ghost" size="icon-sm" aria-label="Details schließen" onClick={closeDetails}><X/></Button></div>
      {active ? detail?.id === active.id ? <RunDetail detail={detail} devices={devices} command={command} reload={reload} clear={closeDetails}/> : <p className="p-5 text-sm text-muted-foreground">Lauf wird geladen …</p> : selectedDevice ? <DevicePlan key={selectedDevice.id} device={selectedDevice} pipelines={pipelines} pipelineGroups={pipelineGroups} recentRuns={selectedRuns} artifacts={deviceArtifacts} artifactsLoading={artifactsLoading} isSource={sourceDeviceIds.has(selectedDevice.id)} reload={reload} notify={notify} onStart={() => startDevice(selectedDevice)} starting={startingDeviceId === selectedDevice.id} onSelectRun={selectRun} onDuplicate={() => setDuplicateDevice(selectedDevice)} onEdit={() => setInventoryAction({ kind: 'edit', deviceId: selectedDevice.id })} onCredentials={() => setInventoryAction({ kind: 'credentials', deviceId: selectedDevice.id })}/> : null}
    </aside>}
    {duplicateDevice && <DuplicateDeviceModal device={duplicateDevice} close={() => setDuplicateDevice(null)} reload={reload} notify={notify} onCreated={(device) => { setSelectedDeviceId(device.id); setActiveId(null) }}/>}
    {applyGroupModal && <ApplyGroupModal groups={pipelineGroups} devices={devices} pipelines={pipelines} initialDeviceIds={selectedDeviceIds} close={() => setApplyGroupModal(false)} reload={reload} notify={notify} onApplied={() => setSelectedDeviceIds([])}/>}
    {bulkAutomationModal && <BulkAutomationModal pipelines={pipelines} devices={devices.filter((device) => selectedIds.has(device.id))} close={() => setBulkAutomationModal(false)} reload={reload} notify={notify} onAdded={() => setSelectedDeviceIds([])}/>}
    {bulkCredentialModal && <BulkCredentialModal credentials={credentials} devices={devices.filter((device) => selectedIds.has(device.id))} close={() => setBulkCredentialModal(false)} reload={reload} notify={notify} onAssigned={() => setSelectedDeviceIds([])}/>}
    {pendingRunDevice && <Modal title={`Ablauf für „${pendingRunDevice.name}“ prüfen`} description="Vor dem Start wurden mögliche Probleme gefunden." onClose={() => setPendingRunDevice(null)}><div className="grid gap-4 px-6 py-5"><Notice tone="warning" title="Hinweise vor dem Start">{inspectDevicePlan(pendingRunDevice, pipelines, credentials, artifacts).map((warning) => <span key={warning} className="block">{warning}</span>)}</Notice><p className="text-sm text-muted-foreground">Der Ablauf führt echte Aktionen am Gerät aus.</p></div><div className="flex justify-end gap-2 border-t bg-muted/20 px-6 py-4"><Button variant="ghost" onClick={() => setPendingRunDevice(null)}>Abbrechen</Button><Button onClick={() => { const device = pendingRunDevice; setPendingRunDevice(null); void executeDeviceRun(device) }}>Trotzdem starten</Button></div></Modal>}
    {inventoryAction && <InventoryDialogs key={`${inventoryAction.kind}-${inventoryAction.deviceId ?? 'all'}`} action={inventoryAction} devices={devices} credentials={credentials} reload={reload} notify={notify} onClose={() => setInventoryAction(null)}/>}
  </>
}

function DevicePlan({ device, pipelines, pipelineGroups, recentRuns, artifacts, artifactsLoading, isSource, reload, notify, onStart, starting, onSelectRun, onDuplicate, onEdit, onCredentials }: { device: Device; pipelines: Pipeline[]; pipelineGroups: PipelineGroup[]; recentRuns: Run[]; artifacts: Artifact[]; artifactsLoading: boolean; isSource: boolean; reload: () => Promise<void>; notify: InventoryPageProps['notify']; onStart: () => void; starting: boolean; onSelectRun: (run: Run) => void; onDuplicate: () => void; onEdit: () => void; onCredentials: () => void }) {
  const [candidate, setCandidate] = useState('')
  const [groupCandidate, setGroupCandidate] = useState('')
  const [saveGroupModal, setSaveGroupModal] = useState(false)
  const assigned = device.pipelineIds.map((id) => pipelines.find((pipeline) => pipeline.id === id)).filter((pipeline): pipeline is Pipeline => Boolean(pipeline))
  const available = pipelines.filter((pipeline) => !device.pipelineIds.includes(pipeline.id))
  const selectedCandidate = available.some((pipeline) => pipeline.id === candidate) ? candidate : available[0]?.id ?? ''
  const selectedGroup = pipelineGroups.find((group) => group.id === groupCandidate) ?? pipelineGroups[0]
  const totalSteps = assigned.reduce((sum, pipeline) => sum + pipeline.steps.length, 0)
  const downloadedFiles = artifacts.filter((artifact) => artifact.kind === 'download')
  const updateOrder = async (pipelineIds: string[]) => {
    try { await patch(`/api/devices/${device.id}`, { pipelineIds }); await reload() }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const move = (index: number, offset: number) => {
    const next = [...device.pipelineIds]
    const target = index + offset
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    void updateOrder(next)
  }
  const applyGroup = async () => {
    if (!selectedGroup) return
    try {
      await post(`/api/pipeline-groups/${selectedGroup.id}/apply`, { deviceIds: [device.id] })
      await reload()
      notify(`Vorlage „${selectedGroup.name}“ wurde „${device.name}“ zugewiesen.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  return <>
    <div className="border-b bg-gradient-to-b from-blue-50/70 to-white px-5 py-5">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('grid size-11 shrink-0 place-items-center rounded-xl border border-blue-100 bg-white text-blue-700 shadow-sm', isSource && 'border-violet-100 text-violet-700')}>
          {isSource ? <Globe2 className="size-5"/> : <Server className="size-5"/>}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-700">{isSource ? 'Portalquelle' : 'Zielgerät'}</p>
          <h2 className="mt-0.5 truncate text-xl font-semibold tracking-tight" title={device.name}>{device.name}</h2>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={device.baseUrl}>{device.baseUrl}</p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <Button className="min-w-0 flex-1" icon={<Play className="size-4"/>} disabled={!assigned.length || starting} title={!assigned.length ? 'Füge zuerst eine Automation hinzu.' : undefined} onClick={onStart}>{starting ? 'Wird gestartet …' : isSource ? 'Synchronisieren' : 'Ablauf starten'}</Button>
        <Button variant="secondary" icon={<Pencil className="size-4"/>} onClick={onEdit}>Bearbeiten</Button>
        <Button variant="ghost" size="icon" aria-label="Gerät duplizieren" title="Gerät duplizieren" onClick={onDuplicate}><Copy className="size-4"/></Button>
      </div>
      <button type="button" className="mt-3 flex w-full items-center gap-3 rounded-xl border border-blue-100 bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50/50" onClick={onCredentials}>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700"><KeyRound className="size-4"/></span>
        <span className="grid min-w-0 flex-1"><span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zugangsdaten</span><strong className={cn('truncate text-sm font-medium', !device.credentialId && 'text-blue-700')}>{device.credentialName || 'Profil zuweisen'}</strong></span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground"/>
      </button>
    </div>
    <section className="min-w-0 px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-sm font-semibold">{isSource ? 'Synchronisierungsablauf' : 'Ablauf'}</h3>{assigned.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">{assigned.length} {assigned.length === 1 ? 'Automation' : 'Automationen'}</p>}</div>
        {assigned.length > 0 && <Button className="shrink-0" variant="ghost" size="sm" icon={<Save className="size-4"/>} onClick={() => setSaveGroupModal(true)}>Als Vorlage speichern</Button>}
      </div>
      {pipelineGroups.length > 0 && <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/60 p-2"><Layers3 className="ml-1 size-4 text-blue-700"/><Select className="min-w-44 flex-1 border-blue-200 bg-white" value={selectedGroup?.id ?? ''} onChange={(event) => setGroupCandidate(event.target.value)} aria-label="Ablaufvorlage auswählen">{pipelineGroups.map((group) => <option value={group.id} key={group.id}>{group.name} · {group.pipelineIds.length} Automationen</option>)}</Select><Button size="sm" onClick={() => void applyGroup()}>Übernehmen</Button></div>}
      <div className={cn('mt-4 overflow-hidden rounded-xl border bg-white', !assigned.length && 'border-dashed bg-slate-50/60')}>
        {assigned.length ? <div className="divide-y">
          {assigned.map((pipeline, index) => <div className="flex items-center gap-2 px-3 py-2.5" key={pipeline.id}>
            <GripVertical className="size-4 shrink-0 text-muted-foreground/50"/><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-xs font-semibold text-blue-700">{index + 1}</span>
            <span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{pipeline.name}</strong><small className="text-xs text-muted-foreground">{pipeline.steps.length} Schritte · {speedName(pipeline.speed)}</small></span>
            <Button variant="ghost" size="icon" aria-label="Nach oben" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp/></Button>
            <Button variant="ghost" size="icon" aria-label="Nach unten" disabled={index === assigned.length - 1} onClick={() => move(index, 1)}><ArrowDown/></Button>
            <Button variant="ghost" size="icon" aria-label="Automation entfernen" onClick={() => void updateOrder(device.pipelineIds.filter((id) => id !== pipeline.id))}><X/></Button>
          </div>)}
        </div> : <div className="flex items-center gap-3 px-4 py-5"><span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-white text-blue-700"><Workflow className="size-4"/></span><div><p className="text-sm font-medium">Noch kein Ablauf eingerichtet</p><p className="mt-0.5 text-xs text-muted-foreground">Wähle unten eine Automation aus.</p></div></div>}
        <div className="flex flex-wrap gap-2 border-t bg-white p-3"><Select className="min-w-40 flex-1" value={selectedCandidate} disabled={!available.length} onChange={(event) => setCandidate(event.target.value)} aria-label="Automation hinzufügen"><option value="">{available.length ? 'Automation auswählen …' : 'Alle Automationen sind zugeordnet'}</option>{available.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.name} · {pipeline.steps.length} Schritte</option>)}</Select><Button variant="secondary" icon={<Plus className="size-4"/>} disabled={!selectedCandidate} onClick={() => void updateOrder([...device.pipelineIds, selectedCandidate])}>Hinzufügen</Button></div>
      </div>
    </section>
    <section className="border-t bg-slate-50/60 px-5 py-5">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Auf einen Blick</h3>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Metric label="Automationen" value={assigned.length}/><Metric label="Schritte" value={totalSteps}/><Metric label="Datenwerte" value={Object.values(device.data).filter(Boolean).length}/>
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border bg-white">
        <div className="px-3 py-3"><div className="flex items-center gap-2"><Download className="size-4 text-muted-foreground"/><h3 className="flex-1 text-sm font-medium">Dateien</h3><Badge>{downloadedFiles.length}</Badge></div><div className="mt-2 max-h-52 space-y-1 overflow-auto">{artifactsLoading ? <p className="text-xs text-muted-foreground">Dateien werden geladen …</p> : downloadedFiles.length ? downloadedFiles.map((artifact) => <a key={artifact.id} href={artifact.downloadUrl} download className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/40"><span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50 text-muted-foreground"><Download className="size-3.5"/></span><span className="grid min-w-0 flex-1"><strong className="truncate text-xs font-medium">{artifact.name}</strong><small className="text-[10px] text-muted-foreground">{formatBytes(artifact.size)} · {formatDate(artifact.createdAt)}</small></span></a>) : <p className="text-xs text-muted-foreground">Noch keine Dateien.</p>}</div></div>
        <div className="border-t px-3 py-3"><div className="flex items-center gap-2"><History className="size-4 text-muted-foreground"/><h3 className="flex-1 text-sm font-medium">Letzte Ausführungen</h3><Badge>{recentRuns.length}</Badge></div><div className="mt-2 space-y-1">{recentRuns.length ? recentRuns.slice(0, 5).map((run) => <button key={run.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/40" onClick={() => onSelectRun(run)}><i className={cn('size-2 shrink-0 rounded-full bg-zinc-300', run.status === 'completed' && 'bg-emerald-500', run.status === 'running' && 'bg-blue-500', run.status === 'paused' && 'bg-amber-500', ['failed', 'interrupted'].includes(run.status) && 'bg-red-500')}/><span className="grid min-w-0 flex-1"><strong className="truncate text-xs font-medium">{run.pipelineName}</strong><small className="text-[10px] text-muted-foreground">{formatDate(run.createdAt)}</small></span><Badge tone={statusTone[run.status]} className="px-1.5 text-[9px]">{statusLabel[run.status]}</Badge></button>) : <p className="text-xs text-muted-foreground">Noch keine Ausführung.</p>}</div></div>
      </div>
    </section>
    {saveGroupModal && <SaveGroupModal device={device} close={() => setSaveGroupModal(false)} reload={reload} notify={notify}/>}
  </>
}

function RunDetail({ detail, devices, command, reload, clear }: { detail: Run; devices: Device[]; command: (name: string) => Promise<void>; reload: () => Promise<void>; clear: () => void }) {
  const current = detail.currentStep == null ? (detail.status === 'completed' ? detail.totalSteps : 0) : Math.min(detail.currentStep + 1, detail.totalSteps)
  const percentage = detail.totalSteps ? current / detail.totalSteps * 100 : 0
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5"><div><p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-blue-700"><Server className="size-3.5"/>{deviceName(detail, devices)}</p><div className="flex items-center gap-2"><h2 className="text-lg font-semibold">{detail.pipelineName}</h2><Badge tone={statusTone[detail.status]}>{statusLabel[detail.status]}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Gestartet {formatDate(detail.startedAt || detail.createdAt)}</p></div><div className="flex flex-wrap gap-2">{detail.status === 'running' && <Button variant="secondary" icon={<Pause/>} onClick={() => void command('pause')}>Pause</Button>}{detail.status === 'paused' && !detail.error && <Button variant="secondary" icon={<Play/>} onClick={() => void command('resume')}>Fortsetzen</Button>}{detail.status === 'paused' && detail.error && <><Button variant="secondary" icon={<RotateCcw/>} onClick={() => void command('retry')}>Erneut versuchen</Button><Button variant="secondary" icon={<SkipForward/>} onClick={() => void command('skip')}>Überspringen</Button></>}{['running', 'paused', 'queued'].includes(detail.status) && <Button variant="danger" icon={<CircleStop/>} onClick={() => void command('stop')}>Stoppen</Button>}{!['running', 'paused', 'queued'].includes(detail.status) && <ConfirmButton variant="ghost" icon={<Trash2/>} title="Lauf löschen" description="Der Lauf und alle dazugehörigen Dateien werden gelöscht." onConfirm={async () => { await remove(`/api/runs/${detail.id}`); clear(); await reload() }}>Löschen</ConfirmButton>}</div></div>
    {detail.stages?.length ? <div className="flex flex-wrap gap-2 border-b bg-muted/20 px-5 py-3">{detail.stages.map((stage, index) => <Badge key={`${stage.pipelineId}-${index}`} tone="info">{index + 1}. {stage.name} · {stage.stepCount}</Badge>)}</div> : null}
    <div className="border-b bg-muted/20 px-5 py-4"><div className="mb-2 flex justify-between text-xs"><span className="text-muted-foreground">Fortschritt</span><strong>{current} / {detail.totalSteps} Schritte</strong></div><Progress value={percentage}/></div>
    {detail.error && <div className="p-5 pb-0"><Notice tone="danger" title="Der Lauf wartet auf deine Entscheidung">{detail.error} Das sichtbare Browserfenster bleibt für eine manuelle Korrektur geöffnet.</Notice></div>}
    <div className="grid gap-6 p-5"><section><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Protokoll</h3><div className="space-y-2">{detail.logs?.map((log) => <div className={cn('grid grid-cols-[64px_8px_1fr] items-start gap-2 rounded-lg border p-2.5 text-xs', log.level === 'error' && 'border-red-200 bg-red-50')} key={log.id}><span className="font-mono text-[10px] text-muted-foreground">{new Date(log.createdAt).toLocaleTimeString('de-DE')}</span><i className={cn('mt-1 size-1.5 rounded-full bg-zinc-400', log.level === 'success' && 'bg-emerald-500', log.level === 'warning' && 'bg-amber-500', log.level === 'error' && 'bg-red-500')}/><p className="leading-relaxed">{log.message}</p></div>)}{!detail.logs?.length && <p className="text-sm text-muted-foreground">Noch keine Meldungen.</p>}</div></section><section><h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Artefakte <Badge>{detail.artifacts?.length ?? 0}</Badge></h3><div className="space-y-2">{detail.artifacts?.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact}/>)}{!detail.artifacts?.length && <p className="text-sm text-muted-foreground">Downloads und Fehler-Screenshots erscheinen hier.</p>}</div></section></div>
  </>
}

function SaveGroupModal({ device, close, reload, notify }: { device: Device; close: () => void; reload: () => Promise<void>; notify: InventoryPageProps['notify'] }) {
  return <Modal title="Ablauf als Vorlage speichern" description="Die Reihenfolge der Automationen kann danach beliebig vielen Geräten zugewiesen werden." onClose={close}><form onSubmit={submitForm(async (values) => {
    try {
      await post('/api/pipeline-groups', { name: String(values.get('name') || ''), description: String(values.get('description') || ''), pipelineIds: device.pipelineIds })
      await reload()
      close()
      notify('Ablaufvorlage wurde gespeichert.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  })}><div className="grid gap-4 px-6 py-5"><Notice tone="info" title={`${device.pipelineIds.length} Automationen werden gruppiert`}>Spätere Änderungen an einem Gerät verändern die gespeicherte Vorlage nicht automatisch.</Notice><Field label="Name"><Input name="name" required autoFocus placeholder="z. B. Standard-Firewall"/></Field><Field label="Beschreibung"><Input name="description" placeholder="Wann soll diese Vorlage verwendet werden?"/></Field></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={close} submit="Vorlage speichern"/></div></form></Modal>
}

function BulkAutomationModal({ pipelines, devices, close, reload, notify, onAdded }: { pipelines: Pipeline[]; devices: Device[]; close: () => void; reload: () => Promise<void>; notify: InventoryPageProps['notify']; onAdded: () => void }) {
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  return <Modal title="Automation mehreren Geräten hinzufügen" description={`${devices.length} ${devices.length === 1 ? 'Gerät ist' : 'Geräte sind'} ausgewählt.`} onClose={close}>
    <form onSubmit={submitForm(async () => {
      if (!pipelineId) return
      setBusy(true)
      try {
        const result = await post<{ added: number; skipped: number }>('/api/devices/bulk-automation', { pipelineId, deviceIds: devices.map((device) => device.id) })
        await reload()
        onAdded()
        close()
        notify(`Automation bei ${result.added} ${result.added === 1 ? 'Gerät' : 'Geräten'} hinzugefügt${result.skipped ? ` · ${result.skipped} bereits vorhanden` : ''}.`)
      } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
      finally { setBusy(false) }
    })}>
      <div className="grid gap-4 px-6 py-5"><Field label="Automation"><Select value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>{pipelines.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.name} · {pipeline.steps.length} Schritte</option>)}</Select></Field><Notice tone="info" title="Bestehende Abläufe bleiben erhalten">Die Automation wird am Ende des Ablaufs angefügt. Geräte, die sie bereits haben, werden übersprungen.</Notice><div className="max-h-36 overflow-auto rounded-lg border p-3 text-xs text-muted-foreground">{devices.map((device) => <p key={device.id} className="py-1">{device.name}</p>)}</div></div>
      <div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={close} submit="Automation hinzufügen" busy={busy}/></div>
    </form>
  </Modal>
}

function BulkCredentialModal({ credentials, devices, close, reload, notify, onAssigned }: { credentials: Credential[]; devices: Device[]; close: () => void; reload: () => Promise<void>; notify: InventoryPageProps['notify']; onAssigned: () => void }) {
  const [credentialId, setCredentialId] = useState(() => credentials.find((credential) => devices.every((device) => device.credentialId === credential.id))?.id ?? credentials[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  return <Modal title="Zugangsdaten mehreren Geräten zuweisen" description={`${devices.length} ${devices.length === 1 ? 'Gerät ist' : 'Geräte sind'} ausgewählt.`} onClose={close}>
    <form onSubmit={submitForm(async () => {
      if (!credentialId || !devices.length) return
      setBusy(true)
      try {
        const result = await post<{ updated: number; unchanged: number }>('/api/devices/bulk-credentials', { credentialId, deviceIds: devices.map((device) => device.id) })
        await reload()
        onAssigned()
        close()
        notify(`Zugangsdatenprofil bei ${result.updated} ${result.updated === 1 ? 'Gerät' : 'Geräten'} zugewiesen${result.unchanged ? ` · ${result.unchanged} bereits zugeordnet` : ''}.`)
      } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
      finally { setBusy(false) }
    })}>
      <div className="grid gap-4 px-6 py-5">
        <Field label="Zugangsdatenprofil"><Select aria-label="Zugangsdatenprofil" value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.name}{credential.username ? ` · ${credential.username}` : ''}</option>)}</Select></Field>
        <Notice tone="info" title="Ein gemeinsames Profil">Die ausgewählten Geräte verwenden dasselbe Profil. Bestehende Zuordnungen werden ersetzt; spätere Änderungen am Profil gelten für alle verbundenen Geräte.</Notice>
        <div className="max-h-44 overflow-auto rounded-lg border p-3"><p className="mb-1 text-xs font-medium">Ausgewählte Geräte</p>{devices.map((device) => <div key={device.id} className="flex justify-between gap-2 py-1 text-xs"><span className="truncate">{device.name}</span><span className="shrink-0 text-muted-foreground">{device.credentialName || 'Ohne Profil'}</span></div>)}</div>
      </div>
      <div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={close} submit="Zugangsdaten zuweisen" busy={busy}/></div>
    </form>
  </Modal>
}

function ApplyGroupModal({ groups, devices, pipelines, initialDeviceIds, close, reload, notify, onApplied }: { groups: PipelineGroup[]; devices: Device[]; pipelines: Pipeline[]; initialDeviceIds: string[]; close: () => void; reload: () => Promise<void>; notify: InventoryPageProps['notify']; onApplied: () => void }) {
  const [candidate, setCandidate] = useState(groups[0]?.id ?? '')
  const [deviceIds, setDeviceIds] = useState<string[]>(initialDeviceIds)
  const selectedGroup = groups.find((group) => group.id === candidate) ?? groups[0]
  const pipelineNames = selectedGroup?.pipelineIds.map((id) => pipelines.find((pipeline) => pipeline.id === id)?.name).filter(Boolean) ?? []
  const toggleDevice = (deviceId: string) => setDeviceIds((current) => current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId])
  const deleteGroup = async () => {
    if (!selectedGroup) return
    try {
      await remove(`/api/pipeline-groups/${selectedGroup.id}`)
      await reload()
      notify('Ablaufvorlage wurde gelöscht.')
      if (groups.length === 1) close()
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  return <Modal title="Ablaufvorlage verteilen" description="Weise mehreren Geräten mit einem Schritt dieselbe Automationsreihenfolge zu." onClose={close} wide><form onSubmit={submitForm(async () => {
    if (!selectedGroup || !deviceIds.length) { notify('Wähle eine Vorlage und mindestens ein Gerät aus.', 'error'); return }
    try {
      await post(`/api/pipeline-groups/${selectedGroup.id}/apply`, { deviceIds })
      await reload()
      onApplied()
      close()
      notify(`Vorlage wurde ${deviceIds.length} ${deviceIds.length === 1 ? 'Gerät' : 'Geräten'} zugewiesen.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  })}><div className="grid gap-5 px-6 py-5 md:grid-cols-[.9fr_1.1fr]"><section><Field label="Ablaufvorlage"><div className="flex gap-2"><Select value={selectedGroup?.id ?? ''} onChange={(event) => setCandidate(event.target.value)}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</Select><ConfirmButton variant="ghost" size="icon" aria-label="Vorlage löschen" title="Vorlage löschen" description={`Die Vorlage „${selectedGroup?.name ?? ''}“ wird gelöscht. Bestehende Geräteabläufe bleiben erhalten.`} onConfirm={deleteGroup}><Trash2/></ConfirmButton></div></Field><div className="mt-4 rounded-lg border bg-muted/20 p-3"><p className="text-xs font-medium">Enthaltener Ablauf</p><ol className="mt-2 space-y-1.5">{pipelineNames.map((name, index) => <li className="flex items-center gap-2 text-xs" key={`${name}-${index}`}><span className="grid size-5 place-items-center rounded bg-background font-mono text-[10px] text-muted-foreground">{index + 1}</span><span className="truncate">{name}</span></li>)}</ol></div><Notice tone="warning" title="Bestehenden Ablauf ersetzen">Die aktuelle Automationsreihenfolge der ausgewählten Geräte wird vollständig durch diese Vorlage ersetzt.</Notice></section><section><div className="mb-2 flex items-center justify-between"><p className="text-sm font-medium">Zielgeräte</p><Button type="button" variant="ghost" size="sm" onClick={() => setDeviceIds(deviceIds.length === devices.length ? [] : devices.map((device) => device.id))}>{deviceIds.length === devices.length ? 'Auswahl leeren' : 'Alle auswählen'}</Button></div><div className="max-h-80 space-y-1 overflow-auto rounded-lg border p-2">{devices.map((device) => <label key={device.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted"><input type="checkbox" className="size-4 accent-blue-600" checked={deviceIds.includes(device.id)} onChange={() => toggleDevice(device.id)}/><span className="grid min-w-0"><strong className="truncate text-sm font-medium">{device.name}</strong><small className="text-xs text-muted-foreground">Aktuell {device.pipelineIds.length} Automationen</small></span></label>)}</div><p className="mt-2 text-xs text-muted-foreground">{deviceIds.length} von {devices.length} Geräten ausgewählt</p></section></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={close} submit="Vorlage zuweisen"/></div></form></Modal>
}

function DuplicateDeviceModal({ device, close, reload, notify, onCreated }: { device: Device; close: () => void; reload: () => Promise<void>; notify: InventoryPageProps['notify']; onCreated: (device: Device) => void }) {
  return <Modal title="Gerät duplizieren" description="Konfiguration und Reihenfolge der Automationen werden übernommen." onClose={close}><form className="grid gap-5 p-6" onSubmit={submitForm(async (values) => { try { const created = await post<Device>(`/api/devices/${device.id}/duplicate`, values); await reload(); onCreated(created); close(); notify(`„${created.name}“ wurde als leere Gerätekopie angelegt.`) } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } })}><div className="grid gap-4"><Field label="Name"><Input name="name" required defaultValue={`${device.name} Kopie`}/></Field><Field label="Start-URL"><Input name="baseUrl" type="url" required defaultValue={device.baseUrl}/></Field><Notice tone="info" title="Die Datentabelle startet leer">Zugangsdatenprofil, HTTPS-Einstellung und Automationsreihenfolge werden kopiert. Gerätewerte und Laufhistorie werden nicht übernommen.</Notice></div><FormActions onCancel={close} submit="Gerät anlegen"/></form></Modal>
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-lg border bg-white px-2 py-2.5 text-center"><strong className="block text-lg font-semibold tabular-nums">{value}</strong><span className="text-[10px] text-muted-foreground">{label}</span></div> }
function speedName(speed: Pipeline['speed']) { return speed === 'slow' ? 'Langsam' : speed === 'fast' ? 'Schnell' : 'Normal' }
function deviceName(run: Run, devices: Device[]) { if (run.currentDeviceName) return run.currentDeviceName; const names = run.deviceIds.map((id) => devices.find((device) => device.id === id)?.name).filter(Boolean); return names.length ? names.join(', ') : 'Unbekanntes Gerät' }
function ArtifactCard({ artifact }: { artifact: Artifact }) { const Icon = artifact.kind === 'screenshot' ? FileImage : Download; return <a href={artifact.downloadUrl} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted" download><span className="grid size-8 place-items-center rounded-md bg-muted"><Icon className="size-4"/></span><div className="grid min-w-0 flex-1"><strong className="truncate text-xs font-medium">{artifact.name}</strong><small className="text-[11px] text-muted-foreground">{artifact.kind === 'screenshot' ? 'Fehler-Screenshot' : 'Download'} · {formatBytes(artifact.size)}</small></div><Download className="size-4 text-muted-foreground"/></a> }
