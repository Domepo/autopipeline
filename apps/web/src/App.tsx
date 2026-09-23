import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Database, Radio, Server, Settings, ShieldCheck, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import type { AppSettings, Artifact, Credential, DataField, Device, Pipeline, PipelineGroup, RecordingStatus, Run, SocketEvent } from '@autosecure/shared'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import { api, socketUrl } from './api.ts'
import { PipelinesPage } from './PipelinesPage.tsx'
import { DataPage } from './DataPage.tsx'
import { InventoryPage } from './InventoryPage.tsx'
import { SettingsPage } from './SettingsPage.tsx'
import { Button } from './components.tsx'

type Section = 'devices' | 'pipelines' | 'data' | 'settings'

const navigation: { id: Section; label: string; hint: string; icon: typeof Workflow }[] = [
  { id: 'devices', label: 'Inventar', hint: 'Geräte & Abläufe', icon: Server },
  { id: 'pipelines', label: 'Automationen', hint: 'Abläufe bauen', icon: Workflow },
  { id: 'data', label: 'Daten', hint: 'Werte & Variablen', icon: Database },
  { id: 'settings', label: 'Einstellungen', hint: 'Logo & Name', icon: Settings },
]

export default function App() {
  const standaloneData = new URLSearchParams(window.location.search).get('view') === 'data'
  const [section, setSection] = useState<Section>(standaloneData ? 'data' : 'devices')
  const [pipelineVisited, setPipelineVisited] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [dataFields, setDataFields] = useState<DataField[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [pipelineGroups, setPipelineGroups] = useState<PipelineGroup[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [settings, setSettings] = useState<AppSettings>({ title: 'AutoSecureCloud', subtitle: 'Sicherheitsautomation', logoUrl: null, storagePath: '', actionTimeoutMs: 15_000, navigationTimeoutMs: 45_000, downloadTimeoutMs: 60_000, automaticBackupInterval: 'off', automaticBackupRetention: 7, lastAutomaticBackupAt: null, automaticBackupError: null, backupDirectory: '' })
  const [recording, setRecording] = useState<RecordingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('asc-sidebar-collapsed') === 'true')

  const toggleSidebar = () => setSidebarCollapsed((collapsed) => {
    localStorage.setItem('asc-sidebar-collapsed', String(!collapsed))
    return !collapsed
  })

  const reload = useCallback(async () => {
    const [deviceData, fieldData, credentialData, pipelineData, pipelineGroupData, runData, artifactData, settingsData] = await Promise.all([
      api<Device[]>('/api/devices'), api<DataField[]>('/api/data-fields'), api<Credential[]>('/api/credentials'), api<Pipeline[]>('/api/pipelines'), api<PipelineGroup[]>('/api/pipeline-groups'), api<Run[]>('/api/runs'), api<Artifact[]>('/api/artifacts'), api<AppSettings>('/api/settings'),
    ])
    setDevices(deviceData); setDataFields(fieldData); setCredentials(credentialData); setPipelines(pipelineData); setPipelineGroups(pipelineGroupData); setRuns(runData); setArtifacts(artifactData); setSettings(settingsData); setInitialLoadError(null); setLoading(false)
  }, [])

  const reloadData = useCallback(async () => {
    const [deviceData, fieldData, credentialData, artifactData] = await Promise.all([
      api<Device[]>('/api/devices'), api<DataField[]>('/api/data-fields'), api<Credential[]>('/api/credentials'), api<Artifact[]>('/api/artifacts'),
    ])
    setDevices(deviceData); setDataFields(fieldData); setCredentials(credentialData); setArtifacts(artifactData)
  }, [])

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    if (tone === 'error') toast.error(message)
    else toast.success(message)
  }, [])

  const mergeDevices = useCallback((updates: Device[]) => {
    const byId = new Map(updates.map((device) => [device.id, device]))
    setDevices((current) => current.map((device) => byId.get(device.id) ?? device))
  }, [])
  const mergePipeline = useCallback((update: Pipeline) => {
    setPipelines((current) => current.map((pipeline) => pipeline.id === update.id ? update : pipeline))
  }, [])

  useEffect(() => { void reload().catch((error) => { setLoading(false); setInitialLoadError(error instanceof Error ? error.message : String(error)) }) }, [reload])
  useEffect(() => { document.title = standaloneData ? `${settings.title} · Daten` : settings.title }, [settings.title, standaloneData])
  useEffect(() => {
    let retry: number | undefined
    let dataReload: number | undefined
    let closed = false
    let socket: WebSocket | undefined
    const scheduleDataReload = () => {
      window.clearTimeout(dataReload)
      dataReload = window.setTimeout(() => { void reloadData().catch((error) => notify(error instanceof Error ? error.message : String(error), 'error')) }, 150)
    }
    const connect = () => {
      socket = new WebSocket(socketUrl())
      socket.onopen = () => setConnected(true)
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as SocketEvent
        if (event.type === 'workspace.restored' || event.type === 'workspace.cleared') { void reload().catch((error) => notify(error instanceof Error ? error.message : String(error), 'error')); return }
        if (event.type === 'snapshot' || event.type === 'recording.status') setRecording(event.recording)
        if (event.type === 'pipeline.updated') {
          setPipelines((items) => items.map((item) => item.id === event.pipeline.id ? event.pipeline : item))
          if (event.pipeline.steps.at(-1)?.type === 'extractText') void reload()
        }
        if (event.type === 'device.updated') { mergeDevices([event.device]); scheduleDataReload() }
        if (event.type === 'data.changed') scheduleDataReload()
        if (event.type === 'run.updated') setRuns((items) => [event.run, ...items.filter((item) => item.id !== event.run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
        if (event.type === 'run.log') void reload()
      }
      socket.onclose = () => { setConnected(false); if (!closed) retry = window.setTimeout(connect, 1400) }
    }
    connect()
    return () => { closed = true; window.clearTimeout(retry); window.clearTimeout(dataReload); socket?.close() }
  }, [reload, reloadData, mergeDevices, notify])

  if (loading) return <div className="grid min-h-screen place-items-center bg-muted/30"><div className="flex items-center gap-3 text-sm text-muted-foreground"><ShieldCheck className="size-5 text-primary"/><span>Arbeitsbereich wird geladen …</span></div></div>

  if (initialLoadError) return <div className="grid min-h-screen place-items-center bg-muted/30 p-6"><div role="alert" className="w-full max-w-md rounded-xl border bg-white p-6 shadow-sm"><ShieldCheck className="mb-4 size-7 text-primary"/><h1 className="text-lg font-semibold">Arbeitsbereich konnte nicht geladen werden</h1><p className="mt-2 text-sm text-muted-foreground">Deine gespeicherten Daten wurden nicht verändert. Prüfe, ob der lokale Server läuft, und versuche es erneut.</p><p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{initialLoadError}</p><Button className="mt-5" onClick={() => { setLoading(true); void reload().catch((error) => { setLoading(false); setInitialLoadError(error instanceof Error ? error.message : String(error)) }) }}>Erneut laden</Button></div></div>

  if (standaloneData) return <TooltipProvider>
    <main className="h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
      <DataPage expanded devices={devices} dataFields={dataFields} credentials={credentials} artifacts={artifacts} reload={reload} notify={notify} onDevicesSaved={mergeDevices}/>
    </main>
    <Toaster position="bottom-right" richColors closeButton/>
  </TooltipProvider>

  return <TooltipProvider>
    <div className={cn('min-h-screen bg-[#f5f7fa] text-foreground transition-[grid-template-columns] duration-200 lg:grid', sidebarCollapsed ? 'lg:grid-cols-[68px_minmax(0,1fr)]' : 'lg:grid-cols-[248px_minmax(0,1fr)]')}>
      <aside className="relative flex overflow-visible border-b bg-white lg:sticky lg:top-0 lg:h-screen lg:flex-col lg:border-b-0 lg:border-r">
        <div className={cn('flex h-[72px] items-center gap-3 border-r px-4 lg:border-r-0 lg:border-b', sidebarCollapsed && 'lg:justify-center lg:px-2')}>
          <span className={cn('grid shrink-0 place-items-center overflow-hidden', settings.logoUrl ? sidebarCollapsed ? 'h-10 w-12 bg-transparent' : 'h-14 w-24 bg-transparent' : 'size-9 rounded-[11px] bg-blue-600 text-white')}>{settings.logoUrl ? <img src={settings.logoUrl} alt="Logo" className="size-full object-contain"/> : <ShieldCheck className="size-[19px]"/>}</span>
          <div className={cn('min-w-0 leading-tight', sidebarCollapsed && 'lg:hidden')}><p className="truncate text-[15px] font-semibold tracking-tight">{settings.title}</p><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{settings.subtitle}</p></div>
          <Button className="absolute top-8 -right-3 z-20 hidden -translate-y-1/2 rounded-full border bg-white text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground lg:inline-flex" variant="ghost" size="icon-sm" aria-label={sidebarCollapsed ? 'Menü ausklappen' : 'Menü einklappen'} title={sidebarCollapsed ? 'Menü ausklappen' : 'Menü einklappen'} onClick={toggleSidebar}>{sidebarCollapsed ? <ChevronRight/> : <ChevronLeft/>}</Button>
        </div>
        <nav className={cn('flex flex-1 gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible lg:p-3', sidebarCollapsed && 'lg:px-2')}>
          {navigation.map((item) => { const Icon = item.icon; const active = section === item.id; return <button key={item.id} title={sidebarCollapsed ? item.label : undefined} aria-label={item.label} className={cn('flex min-w-max items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors lg:w-full', sidebarCollapsed && 'lg:justify-center lg:px-2', active ? 'bg-blue-50 text-blue-700' : 'text-muted-foreground hover:bg-zinc-100 hover:text-foreground')} onClick={() => { setSection(item.id); if (item.id === 'pipelines') setPipelineVisited(true) }}>
            <Icon className="size-[18px]"/><span className={cn('grid', sidebarCollapsed && 'lg:hidden')}><span className="text-sm font-medium">{item.label}</span><span className={cn('hidden text-[11px] lg:block', active ? 'text-blue-600/70' : 'text-muted-foreground')}>{item.hint}</span></span>
            {item.id === 'devices' && runs.some((run) => run.status === 'running' || run.status === 'paused') && <i className="ml-auto size-2 rounded-full bg-blue-500"/>}
          </button> })}
        </nav>
        <div className={cn('hidden border-t p-4 lg:block', sidebarCollapsed && 'lg:px-2')}>
          {recording && (sidebarCollapsed ? <div className="mb-3 grid place-items-center" title={recording.phase === 'replaying' ? 'Browser wird vorbereitet' : 'Aufnahme läuft'}><Radio className="size-4 text-red-600"/></div> : <div className={cn('mb-3 flex gap-2 rounded-lg border p-2.5 text-xs', recording.phase === 'replaying' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800')}><Radio className="mt-0.5 size-3.5 shrink-0"/><span><strong className="block">{recording.phase === 'replaying' ? 'Browser wird vorbereitet' : 'Aufnahme läuft'}</strong>{recording.phase === 'replaying' ? `Schritt ${(recording.replayStep ?? 0) + 1} von ${recording.replayTotal}` : recording.mode === 'extract' ? 'Text im Browser wählen' : 'Du kannst jetzt selbst weiterklicken'}</span></div>)}
          <div className={cn('flex items-center gap-2 text-xs text-muted-foreground', sidebarCollapsed && 'justify-center')} title={connected ? 'Lokal verbunden' : 'Verbinde …'}><i className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')}/><span className={cn(sidebarCollapsed && 'lg:hidden')}>{connected ? 'Lokal verbunden' : 'Verbinde …'}</span></div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-7 lg:py-7">
        <div className="mx-auto max-w-[1680px]">
          {section === 'devices' && <InventoryPage runs={runs} devices={devices} credentials={credentials} pipelines={pipelines} pipelineGroups={pipelineGroups} artifacts={artifacts} reload={reload} notify={notify}/>}
          {pipelineVisited && <div hidden={section !== 'pipelines'}><PipelinesPage pipelines={pipelines} devices={devices} dataFields={dataFields} credentials={credentials} artifacts={artifacts} recording={recording} reload={reload} onPipelineSaved={mergePipeline} notify={notify} openRuns={() => setSection('devices')}/></div>}
          {section === 'data' && <DataPage devices={devices} dataFields={dataFields} credentials={credentials} artifacts={artifacts} reload={reload} notify={notify} onDevicesSaved={mergeDevices}/>}
          {section === 'settings' && <SettingsPage settings={settings} onSaved={setSettings} notify={notify}/>}
        </div>
      </main>
      <Toaster position="bottom-right" richColors closeButton/>
    </div>
  </TooltipProvider>
}
