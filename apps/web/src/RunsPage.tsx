import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CheckCircle2, CircleStop, Clock3, Copy, Download, FileImage, GripVertical, History, ListChecks, Pause, Play, Plus, RefreshCw, RotateCcw, Server, SkipForward, Trash2, Workflow, X } from 'lucide-react'
import type { Artifact, Device, Pipeline, Run, RunStatus } from '@autosecure/shared'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { api, patch, post, remove } from './api.ts'
import { Badge, Button, Empty, Field, FormActions, formatBytes, formatDate, Input, Modal, Notice, PageHeader, Select, submitForm } from './components.tsx'

const statusLabel: Record<RunStatus, string> = { queued: 'Warteschlange', running: 'Läuft', paused: 'Pausiert', completed: 'Erfolgreich', failed: 'Fehlgeschlagen', stopped: 'Gestoppt', interrupted: 'Unterbrochen' }
const statusTone: Record<RunStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { queued: 'neutral', running: 'info', paused: 'warning', completed: 'success', failed: 'danger', stopped: 'neutral', interrupted: 'danger' }

interface RunsPageProps {
  runs: Run[]
  devices: Device[]
  pipelines: Pipeline[]
  reload: () => Promise<void>
  notify: (message: string, tone?: 'success' | 'error') => void
}

export function RunsPage({ runs, devices, pipelines, reload, notify }: RunsPageProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(devices[0]?.id ?? null)
  const [detail, setDetail] = useState<Run | null>(null)
  const [duplicateDevice, setDuplicateDevice] = useState<Device | null>(null)
  const active = runs.find((run) => run.id === activeId)
  const selectedDevice = devices.find((device) => device.id === selectedDeviceId) ?? devices[0]
  const groups = useMemo(() => {
    const known = devices.map((device) => ({ device, runs: runs.filter((run) => run.deviceIds.includes(device.id)) }))
    const knownIds = new Set(devices.map((device) => device.id))
    const unmatched = runs.filter((run) => !run.deviceIds.some((id) => knownIds.has(id)))
    return unmatched.length ? [...known, { device: undefined, runs: unmatched }] : known
  }, [devices, runs])

  useEffect(() => {
    if (!selectedDeviceId && devices[0]) setSelectedDeviceId(devices[0].id)
  }, [devices, selectedDeviceId])
  useEffect(() => {
    if (!active) { setDetail(null); return }
    void api<Run>(`/api/runs/${active.id}`).then(setDetail)
  }, [active?.id, active?.status, active?.currentStep, runs.length])

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

  return <>
    <PageHeader eyebrow="Gerätebetrieb" title="Geräteabläufe" description="Starte ein Gerät und führe seine Pipelines in der festgelegten Reihenfolge aus." actions={<Button variant="secondary" icon={<RefreshCw/>} onClick={() => void reload()}>Aktualisieren</Button>}/>
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      <SummaryCard icon={<Server/>} label="Geräte" value={devices.length}/>
      <SummaryCard icon={<Play/>} label="Aktive Abläufe" value={runs.filter((run) => ['queued', 'running', 'paused'].includes(run.status)).length} tone="blue"/>
      <SummaryCard icon={<CheckCircle2/>} label="Erfolgreiche Abläufe" value={runs.filter((run) => run.status === 'completed').length} tone="green"/>
    </div>
    <div className="grid min-h-[calc(100vh-145px)] gap-4 md:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
      <Card className="self-start overflow-hidden shadow-none">
        <div className="flex items-center justify-between border-b px-4 py-3"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Geräte</h2><Badge>{devices.length}</Badge></div>
        <div className="max-h-[calc(100vh-245px)] overflow-auto p-2">
          {groups.map((group) => <section className="mb-3" key={group.device?.id ?? 'unbekannt'}>
            <button className={cn('flex w-full items-center gap-2 rounded-xl border border-transparent px-2.5 py-2.5 text-left hover:bg-muted', group.device?.id === selectedDevice?.id && !active && 'border-blue-100 bg-blue-50')} onClick={() => selectDevice(group.device)}>
              <span className="grid size-9 place-items-center rounded-lg bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-100"><Server className="size-4"/></span>
              <span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-semibold">{group.device?.name ?? 'Nicht mehr vorhandene Geräte'}</strong><small className="text-[11px] text-muted-foreground">Gerät · {group.device?.pipelineIds.length ?? 0} zugeordnete Pipelines</small></span>
            </button>
            {group.runs.length ? <div className="ms-4 mt-2 border-s ps-3">
              <div className="mb-1.5 flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><History className="size-3"/>Letzte Abläufe</div>
              {group.runs.map((run) => <button key={run.id} className={cn('mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted', run.id === active?.id && 'bg-blue-50 ring-1 ring-inset ring-blue-100')} onClick={() => selectRun(run)}>
                <span className="relative grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Workflow className="size-3.5"/><i className={cn('absolute -end-0.5 -bottom-0.5 size-2 rounded-full border border-background bg-zinc-400', run.status === 'running' && 'animate-pulse bg-blue-500', run.status === 'completed' && 'bg-emerald-500', run.status === 'paused' && 'bg-amber-500', ['failed', 'interrupted'].includes(run.status) && 'bg-red-500')}/></span>
                <span className="grid min-w-0 flex-1"><small className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{run.stages?.length ? 'Geräteablauf' : 'Pipeline-Lauf'}</small><strong className="truncate text-xs font-medium">{run.stages?.length ? `${run.stages.length} Pipelines` : run.pipelineName}</strong><small className="mt-0.5 text-[10px] text-muted-foreground">{formatDate(run.createdAt)}</small></span>
                <Badge tone={statusTone[run.status]} className="px-1.5 text-[9px]">{statusLabel[run.status]}</Badge>
              </button>)}
            </div> : <p className="ms-4 border-s px-5 py-2 text-[11px] text-muted-foreground">Noch keine Abläufe</p>}
          </section>)}
          {!devices.length && <Empty compact icon={<Server/>} title="Noch keine Geräte" text="Lege zuerst ein Gerät an."/>}
        </div>
      </Card>
      <Card className="min-w-0 overflow-hidden shadow-none">
        {active && detail ? <RunDetail detail={detail} devices={devices} command={command} reload={reload} clear={() => setActiveId(null)}/> : selectedDevice ? <DevicePlan device={selectedDevice} pipelines={pipelines} reload={reload} notify={notify} onRun={selectRun} onDuplicate={() => setDuplicateDevice(selectedDevice)}/> : <Empty icon={<ListChecks/>} title="Kein Gerät ausgewählt" text="Wähle links ein Gerät aus."/>}
      </Card>
    </div>
    {duplicateDevice && <DuplicateDeviceModal device={duplicateDevice} close={() => setDuplicateDevice(null)} reload={reload} notify={notify} onCreated={(device) => { setSelectedDeviceId(device.id); setActiveId(null) }}/>}
  </>
}

function DevicePlan({ device, pipelines, reload, notify, onRun, onDuplicate }: { device: Device; pipelines: Pipeline[]; reload: () => Promise<void>; notify: RunsPageProps['notify']; onRun: (run: Run) => void; onDuplicate: () => void }) {
  const [candidate, setCandidate] = useState('')
  const [busy, setBusy] = useState(false)
  const assigned = device.pipelineIds.map((id) => pipelines.find((pipeline) => pipeline.id === id)).filter((pipeline): pipeline is Pipeline => Boolean(pipeline))
  const available = pipelines.filter((pipeline) => !device.pipelineIds.includes(pipeline.id))
  const selectedCandidate = available.some((pipeline) => pipeline.id === candidate) ? candidate : available[0]?.id ?? ''
  const totalSteps = assigned.reduce((sum, pipeline) => sum + pipeline.steps.length, 0)
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
  const start = async () => {
    setBusy(true)
    try {
      const run = await post<Run>(`/api/devices/${device.id}/run`)
      await reload()
      onRun(run)
      notify(`Geräteablauf für „${device.name}“ wurde gestartet.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5">
      <div><p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-blue-700"><Server className="size-3.5"/>Geräteplan</p><h2 className="text-xl font-semibold">{device.name}</h2><p className="mt-1 text-xs text-muted-foreground">{device.baseUrl}</p></div>
      <div className="flex gap-2"><Button variant="secondary" icon={<Copy/>} onClick={onDuplicate}>Duplizieren</Button><Button icon={<Play/>} disabled={!assigned.length || busy} onClick={() => void start()}>{busy ? 'Wird gestartet …' : 'Gerät starten'}</Button></div>
    </div>
    <div className="grid gap-6 p-5 xl:grid-cols-[minmax(0,1fr)_280px]">
      <section>
        <div className="mb-3 flex items-end justify-between gap-3"><div><h3 className="text-sm font-semibold">Pipeline-Reihenfolge</h3><p className="mt-1 text-xs text-muted-foreground">Alle Pipelines laufen nacheinander im selben Gerätekontext.</p></div><Badge>{assigned.length}</Badge></div>
        <div className="space-y-2">
          {assigned.map((pipeline, index) => <div className="flex items-center gap-2 rounded-xl border bg-background p-3" key={pipeline.id}>
            <GripVertical className="size-4 shrink-0 text-muted-foreground/50"/><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-xs font-semibold text-blue-700">{index + 1}</span>
            <span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{pipeline.name}</strong><small className="text-xs text-muted-foreground">{pipeline.steps.length} Schritte · {speedName(pipeline.speed)}</small></span>
            <Button variant="ghost" size="icon" aria-label="Nach oben" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp/></Button>
            <Button variant="ghost" size="icon" aria-label="Nach unten" disabled={index === assigned.length - 1} onClick={() => move(index, 1)}><ArrowDown/></Button>
            <Button variant="ghost" size="icon" aria-label="Pipeline entfernen" onClick={() => void updateOrder(device.pipelineIds.filter((id) => id !== pipeline.id))}><X/></Button>
          </div>)}
          {!assigned.length && <Empty compact icon={<Workflow/>} title="Noch keine Pipeline zugeordnet" text="Füge unten die erste Pipeline hinzu."/>}
        </div>
        <div className="mt-4 flex gap-2 rounded-xl border border-dashed bg-muted/20 p-3"><Select className="flex-1" value={selectedCandidate} disabled={!available.length} onChange={(event) => setCandidate(event.target.value)}><option value="">{available.length ? 'Pipeline auswählen …' : 'Alle Pipelines sind zugeordnet'}</option>{available.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.name} · {pipeline.steps.length} Schritte</option>)}</Select><Button variant="secondary" icon={<Plus/>} disabled={!selectedCandidate} onClick={() => void updateOrder([...device.pipelineIds, selectedCandidate])}>Hinzufügen</Button></div>
      </section>
      <aside className="space-y-3">
        <Card className="p-4 shadow-none"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dieser Ablauf</h3><Metric label="Pipelines" value={assigned.length}/><Metric label="Schritte insgesamt" value={totalSteps}/><Metric label="Tabellenwerte" value={Object.keys(device.data).length}/></Card>
        <Notice tone="info" title="Werte und Dateien werden weitergereicht">Ein gelesener Tabellenwert steht allen folgenden Pipelines dieses Geräteablaufs zur Verfügung. Downloads können in späteren Upload-Schritten verwendet werden.</Notice>
      </aside>
    </div>
  </>
}

function RunDetail({ detail, devices, command, reload, clear }: { detail: Run; devices: Device[]; command: (name: string) => Promise<void>; reload: () => Promise<void>; clear: () => void }) {
  const current = detail.currentStep == null ? (detail.status === 'completed' ? detail.totalSteps : 0) : Math.min(detail.currentStep + 1, detail.totalSteps)
  const percentage = detail.totalSteps ? current / detail.totalSteps * 100 : 0
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5"><div><p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-blue-700"><Server className="size-3.5"/>{deviceName(detail, devices)}</p><div className="flex items-center gap-2"><h2 className="text-lg font-semibold">{detail.pipelineName}</h2><Badge tone={statusTone[detail.status]}>{statusLabel[detail.status]}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Gestartet {formatDate(detail.startedAt || detail.createdAt)}</p></div><div className="flex flex-wrap gap-2">{detail.status === 'running' && <Button variant="secondary" icon={<Pause/>} onClick={() => void command('pause')}>Pause</Button>}{detail.status === 'paused' && !detail.error && <Button variant="secondary" icon={<Play/>} onClick={() => void command('resume')}>Fortsetzen</Button>}{detail.status === 'paused' && detail.error && <><Button variant="secondary" icon={<RotateCcw/>} onClick={() => void command('retry')}>Erneut versuchen</Button><Button variant="secondary" icon={<SkipForward/>} onClick={() => void command('skip')}>Überspringen</Button></>}{['running', 'paused', 'queued'].includes(detail.status) && <Button variant="danger" icon={<CircleStop/>} onClick={() => void command('stop')}>Stoppen</Button>}{!['running', 'paused', 'queued'].includes(detail.status) && <Button variant="ghost" icon={<Trash2/>} onClick={async () => { if (!confirm('Lauf und alle Artefakte wirklich löschen?')) return; await remove(`/api/runs/${detail.id}`); clear(); await reload() }}>Löschen</Button>}</div></div>
    {detail.stages?.length ? <div className="flex flex-wrap gap-2 border-b bg-muted/20 px-5 py-3">{detail.stages.map((stage, index) => <Badge key={`${stage.pipelineId}-${index}`} tone="info">{index + 1}. {stage.name} · {stage.stepCount}</Badge>)}</div> : null}
    <div className="border-b bg-muted/20 px-5 py-4"><div className="mb-2 flex justify-between text-xs"><span className="text-muted-foreground">Fortschritt</span><strong>{current} / {detail.totalSteps} Schritte</strong></div><Progress value={percentage}/></div>
    {detail.error && <div className="p-5 pb-0"><Notice tone="danger" title="Der Lauf wartet auf deine Entscheidung">{detail.error} Das sichtbare Browserfenster bleibt für eine manuelle Korrektur geöffnet.</Notice></div>}
    <div className="grid gap-6 p-5 xl:grid-cols-[1.15fr_.85fr]"><section><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Protokoll</h3><div className="space-y-2">{detail.logs?.map((log) => <div className={cn('grid grid-cols-[64px_8px_1fr] items-start gap-2 rounded-lg border p-2.5 text-xs', log.level === 'error' && 'border-red-200 bg-red-50')} key={log.id}><span className="font-mono text-[10px] text-muted-foreground">{new Date(log.createdAt).toLocaleTimeString('de-DE')}</span><i className={cn('mt-1 size-1.5 rounded-full bg-zinc-400', log.level === 'success' && 'bg-emerald-500', log.level === 'warning' && 'bg-amber-500', log.level === 'error' && 'bg-red-500')}/><p className="leading-relaxed">{log.message}</p></div>)}{!detail.logs?.length && <p className="text-sm text-muted-foreground">Noch keine Meldungen.</p>}</div></section><section><h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Artefakte <Badge>{detail.artifacts?.length ?? 0}</Badge></h3><div className="space-y-2">{detail.artifacts?.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact}/>)}{!detail.artifacts?.length && <p className="text-sm text-muted-foreground">Downloads und Fehler-Screenshots erscheinen hier.</p>}</div></section></div>
  </>
}

function DuplicateDeviceModal({ device, close, reload, notify, onCreated }: { device: Device; close: () => void; reload: () => Promise<void>; notify: RunsPageProps['notify']; onCreated: (device: Device) => void }) {
  return <Modal title="Gerät duplizieren" description="Konfiguration und Pipeline-Reihenfolge werden übernommen." onClose={close}><form className="grid gap-5 p-6" onSubmit={submitForm(async (values) => { try { const created = await post<Device>(`/api/devices/${device.id}/duplicate`, values); await reload(); onCreated(created); close(); notify(`„${created.name}“ wurde als leere Gerätekopie angelegt.`) } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } })}><div className="grid gap-4"><Field label="Name"><Input name="name" required defaultValue={`${device.name} Kopie`}/></Field><Field label="Start-URL"><Input name="baseUrl" type="url" required defaultValue={device.baseUrl}/></Field><Notice tone="info" title="Die Datentabelle startet leer">Zugangsdatenprofil, HTTPS-Einstellung und Pipeline-Reihenfolge werden kopiert. Gerätewerte und Laufhistorie werden nicht übernommen.</Notice></div><FormActions onCancel={close} submit="Gerät anlegen"/></form></Modal>
}

function SummaryCard({ icon, label, value, tone = 'neutral' }: { icon: ReactNode; label: string; value: number; tone?: 'neutral' | 'blue' | 'green' }) { return <Card className="flex-row items-center gap-3 p-4 shadow-none"><span className={cn('grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground', tone === 'blue' && 'bg-blue-50 text-blue-700', tone === 'green' && 'bg-emerald-50 text-emerald-700')}>{icon}</span><span><strong className="block text-xl font-semibold leading-none">{value}</strong><small className="mt-1 block text-xs text-muted-foreground">{label}</small></span></Card> }
function Metric({ label, value }: { label: string; value: number }) { return <div className="flex items-center justify-between border-b py-2 text-xs last:border-0"><span className="text-muted-foreground">{label}</span><strong>{value}</strong></div> }
function speedName(speed: Pipeline['speed']) { return speed === 'slow' ? 'Langsam' : speed === 'fast' ? 'Schnell' : 'Normal' }
function deviceName(run: Run, devices: Device[]) { if (run.currentDeviceName) return run.currentDeviceName; const names = run.deviceIds.map((id) => devices.find((device) => device.id === id)?.name).filter(Boolean); return names.length ? names.join(', ') : 'Unbekanntes Gerät' }
function ArtifactCard({ artifact }: { artifact: Artifact }) { const Icon = artifact.kind === 'screenshot' ? FileImage : Download; return <a href={artifact.downloadUrl} className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted" download><span className="grid size-8 place-items-center rounded-md bg-muted"><Icon className="size-4"/></span><div className="grid min-w-0 flex-1"><strong className="truncate text-xs font-medium">{artifact.name}</strong><small className="text-[11px] text-muted-foreground">{artifact.kind === 'screenshot' ? 'Fehler-Screenshot' : 'Download'} · {formatBytes(artifact.size)}</small></div><Download className="size-4 text-muted-foreground"/></a> }
