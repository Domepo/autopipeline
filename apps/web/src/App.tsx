import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Database, ListChecks, Radio, Server, ShieldCheck, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import type { Credential, DataField, Device, Pipeline, RecordingStatus, Run, SocketEvent } from '@autosecure/shared'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import { api, socketUrl } from './api.ts'
import { DevicesPage } from './DevicesPage.tsx'
import { PipelinesPage } from './PipelinesPage.tsx'
import { DataPage } from './DataPage.tsx'
import { RunsPage } from './RunsPage.tsx'
import { Button } from './components.tsx'

type Section = 'pipelines' | 'devices' | 'data' | 'runs'

const navigation: { id: Section; label: string; hint: string; icon: typeof Workflow }[] = [
  { id: 'pipelines', label: 'Pipelines', hint: 'Abläufe bauen', icon: Workflow },
  { id: 'devices', label: 'Geräte', hint: 'Ziele verwalten', icon: Server },
  { id: 'data', label: 'Datentabelle', hint: 'Variablen & Werte', icon: Database },
  { id: 'runs', label: 'Läufe', hint: 'Ausführungen', icon: ListChecks },
]

export default function App() {
  const [section, setSection] = useState<Section>('pipelines')
  const [devices, setDevices] = useState<Device[]>([])
  const [dataFields, setDataFields] = useState<DataField[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [recording, setRecording] = useState<RecordingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('asc-sidebar-collapsed') === 'true')

  const toggleSidebar = () => setSidebarCollapsed((collapsed) => {
    localStorage.setItem('asc-sidebar-collapsed', String(!collapsed))
    return !collapsed
  })

  const reload = useCallback(async () => {
    const [deviceData, fieldData, credentialData, pipelineData, runData] = await Promise.all([
      api<Device[]>('/api/devices'), api<DataField[]>('/api/data-fields'), api<Credential[]>('/api/credentials'), api<Pipeline[]>('/api/pipelines'), api<Run[]>('/api/runs'),
    ])
    setDevices(deviceData); setDataFields(fieldData); setCredentials(credentialData); setPipelines(pipelineData); setRuns(runData); setLoading(false)
  }, [])

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    if (tone === 'error') toast.error(message)
    else toast.success(message)
  }, [])

  const mergeDevices = useCallback((updates: Device[]) => {
    const byId = new Map(updates.map((device) => [device.id, device]))
    setDevices((current) => current.map((device) => byId.get(device.id) ?? device))
  }, [])

  useEffect(() => { void reload().catch((error) => { setLoading(false); notify(error.message, 'error') }) }, [reload, notify])
  useEffect(() => {
    let retry: number | undefined
    let closed = false
    let socket: WebSocket | undefined
    const connect = () => {
      socket = new WebSocket(socketUrl())
      socket.onopen = () => setConnected(true)
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as SocketEvent
        if (event.type === 'snapshot' || event.type === 'recording.status') setRecording(event.recording)
        if (event.type === 'pipeline.updated') {
          setPipelines((items) => items.map((item) => item.id === event.pipeline.id ? event.pipeline : item))
          if (event.pipeline.steps.at(-1)?.type === 'extractText') void reload()
        }
        if (event.type === 'device.updated') mergeDevices([event.device])
        if (event.type === 'run.updated') setRuns((items) => [event.run, ...items.filter((item) => item.id !== event.run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
        if (event.type === 'run.log') void reload()
      }
      socket.onclose = () => { setConnected(false); if (!closed) retry = window.setTimeout(connect, 1400) }
    }
    connect()
    return () => { closed = true; window.clearTimeout(retry); socket?.close() }
  }, [reload, mergeDevices])

  if (loading) return <div className="grid min-h-screen place-items-center bg-muted/30"><div className="flex items-center gap-3 text-sm text-muted-foreground"><ShieldCheck className="size-5 text-primary"/><span>Arbeitsbereich wird geladen …</span></div></div>

  return <TooltipProvider>
    <div className={cn('min-h-screen bg-[#f7f8fa] text-foreground transition-[grid-template-columns] duration-200 lg:grid', sidebarCollapsed ? 'lg:grid-cols-[72px_minmax(0,1fr)]' : 'lg:grid-cols-[224px_minmax(0,1fr)]')}>
      <aside className="relative flex overflow-visible border-b bg-white lg:sticky lg:top-0 lg:h-screen lg:flex-col lg:border-b-0 lg:border-r">
        <div className={cn('flex h-16 items-center gap-2.5 border-r px-4 lg:border-r-0 lg:border-b', sidebarCollapsed && 'lg:justify-center lg:px-2')}>
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-200"><ShieldCheck className="size-5"/></span>
          <div className={cn('min-w-0 leading-tight', sidebarCollapsed && 'lg:hidden')}><p className="truncate text-sm font-semibold tracking-tight">AutoSecureCloud</p><p className="text-[11px] text-muted-foreground">Local automation</p></div>
          <Button className="absolute top-8 -right-3 z-20 hidden -translate-y-1/2 rounded-full border bg-white text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground lg:inline-flex" variant="ghost" size="icon-sm" aria-label={sidebarCollapsed ? 'Menü ausklappen' : 'Menü einklappen'} title={sidebarCollapsed ? 'Menü ausklappen' : 'Menü einklappen'} onClick={toggleSidebar}>{sidebarCollapsed ? <ChevronRight/> : <ChevronLeft/>}</Button>
        </div>
        <nav className={cn('flex flex-1 gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible lg:p-3', sidebarCollapsed && 'lg:px-2')}>
          {navigation.map((item) => { const Icon = item.icon; const active = section === item.id; return <button key={item.id} title={sidebarCollapsed ? item.label : undefined} aria-label={item.label} className={cn('flex min-w-max items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors lg:w-full', sidebarCollapsed && 'lg:justify-center lg:px-2', active ? 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200' : 'text-muted-foreground hover:bg-muted hover:text-foreground')} onClick={() => setSection(item.id)}>
            <Icon className="size-4"/><span className={cn('grid', sidebarCollapsed && 'lg:hidden')}><span className="text-sm font-medium">{item.label}</span><span className={cn('hidden text-[11px] lg:block', active ? 'text-blue-500' : 'text-muted-foreground')}>{item.hint}</span></span>
            {item.id === 'runs' && runs.some((run) => run.status === 'running' || run.status === 'paused') && <i className="ml-auto size-2 rounded-full bg-blue-500"/>}
          </button> })}
        </nav>
        <div className={cn('hidden border-t p-4 lg:block', sidebarCollapsed && 'lg:px-2')}>
          {recording && (sidebarCollapsed ? <div className="mb-3 grid place-items-center" title={recording.phase === 'replaying' ? 'Browser wird vorbereitet' : 'Aufnahme läuft'}><Radio className="size-4 text-red-600"/></div> : <div className={cn('mb-3 flex gap-2 rounded-lg border p-2.5 text-xs', recording.phase === 'replaying' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-800')}><Radio className="mt-0.5 size-3.5 shrink-0"/><span><strong className="block">{recording.phase === 'replaying' ? 'Browser wird vorbereitet' : 'Aufnahme läuft'}</strong>{recording.phase === 'replaying' ? `Schritt ${(recording.replayStep ?? 0) + 1} von ${recording.replayTotal}` : recording.mode === 'extract' ? 'Text im Browser wählen' : 'Du kannst jetzt selbst weiterklicken'}</span></div>)}
          <div className={cn('flex items-center gap-2 text-xs text-muted-foreground', sidebarCollapsed && 'justify-center')} title={connected ? 'Lokal verbunden' : 'Verbinde …'}><i className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-amber-500')}/><span className={cn(sidebarCollapsed && 'lg:hidden')}>{connected ? 'Lokal verbunden' : 'Verbinde …'}</span></div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-[1500px]">
          {section === 'pipelines' && <PipelinesPage pipelines={pipelines} devices={devices} dataFields={dataFields} credentials={credentials} recording={recording} reload={reload} notify={notify} openRuns={() => setSection('runs')}/>}
          {section === 'devices' && <DevicesPage devices={devices} credentials={credentials} reload={reload} notify={notify}/>}
          {section === 'data' && <DataPage devices={devices} dataFields={dataFields} credentials={credentials} reload={reload} notify={notify} onDevicesSaved={mergeDevices}/>}
          {section === 'runs' && <RunsPage runs={runs} devices={devices} pipelines={pipelines} reload={reload} notify={notify}/>}
        </div>
      </main>
      <Toaster position="bottom-right" richColors closeButton/>
    </div>
  </TooltipProvider>
}
