import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Braces, ChevronRight, CircleStop, Copy, Database, Eye, FileDown, FileUp, GitMerge, GripVertical, Hourglass, ListPlus, MousePointer2, Navigation, Play, Plus, Radio, ScanSearch, Trash2, Type, Workflow } from 'lucide-react'
import type { Artifact, Credential, DataField, Device, DiscoveryCollectionLevel, DiscoveryField, FileSource, LocatorSpec, Pipeline, PipelineStep, RecordingStatus, ValueSource } from '@autosecure/shared'
import { makeId, stepNames } from '@autosecure/shared'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { patch, post, remove } from './api.ts'
import { Badge, Button, ConfirmButton, Empty, Field, FormActions, Input, Modal, Notice, PageHeader, Select, submitForm } from './components.tsx'
import { inspectRun } from './run-preflight.ts'

type Props = {
  pipelines: Pipeline[]; devices: Device[]; dataFields: DataField[]; credentials: Credential[]; artifacts: Artifact[]; recording: RecordingStatus | null
  reload: () => Promise<void>; onPipelineSaved: (pipeline: Pipeline) => void; notify: (message: string, tone?: 'success' | 'error') => void; openRuns: () => void
}

type InputValueStep = Extract<PipelineStep, { type: 'fill' }> | Extract<PipelineStep, { type: 'select' }>

const stepIcon: Record<PipelineStep['type'], typeof MousePointer2> = {
  navigate: Navigation, click: MousePointer2, fill: Type, select: Type, toggle: Radio,
  press: Type, extractText: Eye, waitFor: Hourglass, download: FileDown, upload: FileUp, mergeAtv: GitMerge,
  runPipelines: Workflow, beginSubflow: Workflow, endSubflow: Workflow, discoverDevices: ScanSearch,
}

export function PipelinesPage({ pipelines, devices, dataFields, credentials, artifacts, recording, reload, onPipelineSaved, notify, openRuns }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [createModal, setCreateModal] = useState(false)
  const [recordModal, setRecordModal] = useState(false)
  const [recordDeviceId, setRecordDeviceId] = useState('')
  const [recordIgnoreHttps, setRecordIgnoreHttps] = useState(false)
  const [extractModal, setExtractModal] = useState(false)
  const [continueAfterStep, setContinueAfterStep] = useState<number | null>(null)
  const [runModal, setRunModal] = useState(false)
  const [fieldModal, setFieldModal] = useState(false)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Pipeline>>({})
  const draftsRef = useRef<Record<string, Pipeline>>({})
  const revisionsRef = useRef<Record<string, number>>({})
  const jobsRef = useRef(new Map<string, Promise<void>>())
  const [saveStatus, setSaveStatus] = useState<Record<string, 'saving' | 'saved' | 'error'>>({})
  const activeIdResolved = activeId ?? pipelines[0]?.id
  const active = ((activeIdResolved && drafts[activeIdResolved]) || pipelines.find((item) => item.id === activeIdResolved)) ?? pipelines[0]
  const discoveryStep = active?.steps.find((step): step is Extract<PipelineStep, { type: 'discoverDevices' }> => step.type === 'discoverDevices')
  const discoverySource = discoveryStep?.sourceDeviceId ? devices.find((device) => device.id === discoveryStep.sourceDeviceId) : undefined
  useEffect(() => { if (!activeId && pipelines[0]) setActiveId(pipelines[0].id) }, [activeId, pipelines])
  useEffect(() => { if (recording?.pipelineId) setActiveId(recording.pipelineId) }, [recording])
  useEffect(() => {
    if (!Object.keys(drafts).length) return
    const warnBeforeLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeLeave)
    return () => window.removeEventListener('beforeunload', warnBeforeLeave)
  }, [drafts])

  const createPipeline = async (data: FormData) => {
    try { const result = await post<Pipeline>('/api/pipelines', { name: String(data.get('name')), description: String(data.get('description')) }); setCreateModal(false); setActiveId(result.id); await reload(); notify('Automation wurde angelegt.') }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const saveDraft = (id: string): Promise<void> => {
    const running = jobsRef.current.get(id)
    if (running) return running
    setSaveStatus((current) => ({ ...current, [id]: 'saving' }))
    const job = (async () => {
      try {
        while (draftsRef.current[id]) {
          const snapshot = draftsRef.current[id]
          const revision = revisionsRef.current[id]
          const saved = await patch<Pipeline>(`/api/pipelines/${id}`, { name: snapshot.name, description: snapshot.description, speed: snapshot.speed, steps: snapshot.steps })
          onPipelineSaved(saved)
          if (revisionsRef.current[id] === revision) {
            const next = { ...draftsRef.current }
            delete next[id]
            draftsRef.current = next
            setDrafts(next)
            setSaveStatus((current) => ({ ...current, [id]: 'saved' }))
          }
        }
      } catch (error) {
        setSaveStatus((current) => ({ ...current, [id]: 'error' }))
        notify(error instanceof Error ? error.message : String(error), 'error')
      } finally { jobsRef.current.delete(id) }
    })()
    jobsRef.current.set(id, job)
    return job
  }
  const updatePipeline = (body: Partial<Pipeline>) => {
    if (!active) return
    const next = { ...(draftsRef.current[active.id] ?? active), ...body }
    draftsRef.current = { ...draftsRef.current, [active.id]: next }
    revisionsRef.current[active.id] = (revisionsRef.current[active.id] ?? 0) + 1
    setDrafts(draftsRef.current)
    setSaveStatus((current) => ({ ...current, [active.id]: 'saving' }))
    void saveDraft(active.id)
  }
  const updateStep = (index: number, step: PipelineStep) => { if (!active) return; const steps = [...active.steps]; steps[index] = step; void updatePipeline({ steps }) }
  const moveStep = (index: number, direction: -1 | 1) => { if (!active) return; const next = index + direction; if (next < 0 || next >= active.steps.length) return; const steps = [...active.steps]; [steps[index], steps[next]] = [steps[next], steps[index]]; setSelectedStep(next); void updatePipeline({ steps }) }
  const addStep = (type: 'navigate' | 'waitFor' | 'runPipelines' | 'discoverDevices' | 'mergeAtv') => {
    if (!active) return
    let step: PipelineStep
    if (type === 'navigate') step = { id: makeId('step'), type, label: 'Seite öffnen', url: { type: 'literal', value: '{{device.baseUrl}}' } }
    else if (type === 'waitFor') step = { id: makeId('step'), type, label: 'Kurz warten', milliseconds: 1000 }
    else if (type === 'runPipelines') step = { id: makeId('step'), type, label: 'Andere Automationen ausführen', pipelineIds: [] }
    else if (type === 'mergeAtv') step = { id: makeId('step'), type, label: 'ATV-Dateien zusammenführen', first: { type: 'dataFile', key: '' }, second: { type: 'dataFile', key: '' }, outputKey: 'atv-merge', outputName: 'zusammengefuehrt.atv' }
    else step = makeDiscoveryStep()
    const steps = [...active.steps, step]
    setSelectedStep(steps.length - 1)
    void updatePipeline({ steps })
  }
  const openRecordingModal = () => {
    const device = devices[0]
    setRecordDeviceId(device?.id ?? '')
    setRecordIgnoreHttps(Boolean(device?.ignoreHttpsErrors || (device && shouldSuggestHttpsBypass(device.baseUrl))))
    setRecordModal(true)
  }
  const startRecording = async (data: FormData) => {
    try {
      const deviceId = String(data.get('deviceId') || '') || undefined
      const ignoreHttpsErrors = data.get('ignoreHttpsErrors') === 'on'
      const device = deviceId ? devices.find((item) => item.id === deviceId) : undefined
      if (device && device.ignoreHttpsErrors !== ignoreHttpsErrors) await patch(`/api/devices/${device.id}`, { ignoreHttpsErrors })
      await post('/api/recordings/start', { pipelineId: active!.id, deviceId, url: String(data.get('url') || '') || undefined, ignoreHttpsErrors })
      setRecordModal(false)
      await reload()
      notify('Aufnahme läuft im sichtbaren Browserfenster.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const startExtract = async (data: FormData) => {
    try {
      await post('/api/recordings/extract', { key: String(data.get('key') || '') })
      setExtractModal(false)
      notify('Klicke jetzt im Browser den gewünschten Text an. Der Wert wird sofort in die Tabelle geschrieben.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const continueRecording = async (data: FormData) => {
    if (!active || continueAfterStep == null) return
    try {
      await post('/api/recordings/continue', { pipelineId: active.id, deviceId: String(data.get('deviceId') || ''), afterStepIndex: continueAfterStep })
      setContinueAfterStep(null)
      notify(`Schritte 1 bis ${continueAfterStep + 1} sind fertig. Du kannst jetzt selbst weiterklicken.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const startRun = async (deviceIds: string[]) => { try { await post('/api/runs', { pipelineId: active!.id, deviceIds }); setRunModal(false); notify('Der sichtbare Lauf wurde gestartet.'); openRuns() } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } }
  const duplicatePipeline = async () => {
    if (!active) return
    try {
      const copy = await post<Pipeline>(`/api/pipelines/${active.id}/duplicate`, {})
      setActiveId(copy.id)
      setSelectedStep(null)
      await reload()
      notify(`„${active.name}“ wurde als „${copy.name}“ kopiert.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const createField = async (data: FormData) => { const field = await post<DataField>('/api/data-fields', { label: String(data.get('label') || ''), type: String(data.get('type') || 'text') }); const selected = active && selectedStep != null ? active.steps[selectedStep] : undefined; if (active && selectedStep != null && selected?.type === 'extractText' && field.type !== 'file') { const steps = [...active.steps]; steps[selectedStep] = { ...selected, key: field.key, persist: true }; await patch(`/api/pipelines/${active.id}`, { steps }) } setFieldModal(false); await reload(); notify(`Variable {{data.${field.key}}} wurde angelegt.`) }

  const earlierResults = useMemo(() => active?.steps.flatMap((step, index) => {
    if (index >= (selectedStep ?? active.steps.length)) return []
    if (step.type === 'extractText') return [step.key]
    if (step.type === 'discoverDevices') return step.record.fields.map((field) => field.key)
    return []
  }) ?? [], [active, selectedStep])
  const earlierFiles = useMemo(() => active?.steps.flatMap((step, index) => {
    if (index >= (selectedStep ?? active.steps.length)) return []
    if (step.type === 'download') return [step.artifactKey]
    if (step.type === 'mergeAtv') return [step.outputKey]
    return []
  }).filter(Boolean) ?? [], [active, selectedStep])

  return <>
    <PageHeader eyebrow="Automationstudio" title="Automationen" description="Browserabläufe als klare Schrittfolge aufnehmen, prüfen und wiederverwenden." actions={<Button icon={<Plus/>} onClick={() => setCreateModal(true)}>Neue Automation</Button>}/>
    <div className="grid min-h-[calc(100vh-140px)] gap-4 md:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(520px,1fr)_320px] 2xl:grid-cols-[230px_minmax(620px,1fr)_380px]">
      <Card className="self-start overflow-hidden shadow-none md:sticky md:top-6 xl:top-8">
        <div className="flex items-center justify-between border-b px-4 py-3"><div><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Automationen</h2><p className="mt-0.5 text-[11px] text-muted-foreground">Wiederverwendbare Bausteine</p></div><Badge>{pipelines.length}</Badge></div>
        <div className="p-2">{pipelines.map((pipeline) => <button className={cn('mb-1 flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-3 text-left hover:bg-muted', pipeline.id === active?.id && 'border-blue-100 bg-blue-50 text-blue-800 hover:bg-blue-50')} key={pipeline.id} onClick={() => { setActiveId(pipeline.id); setSelectedStep(null) }}><span className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600', pipeline.id === active?.id && 'bg-white text-blue-700')}><Workflow className="size-4"/></span><span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{pipeline.name}</strong><small className="text-[11px] text-muted-foreground">{pipeline.steps.length} Schritte · {speedLabel(pipeline.speed)}</small></span></button>)}{!pipelines.length && <Empty compact icon={<Workflow/>} title="Keine Automation" text="Lege deinen ersten Ablauf an."/>}</div>
      </Card>

      <Card className="min-w-0 overflow-hidden shadow-none">
        {!active ? <Empty icon={<Workflow/>} title="Deine erste Automation" text="Lege einen Ablauf an und starte anschließend die Browseraufnahme." action={<Button onClick={() => setCreateModal(true)}>Automation anlegen</Button>}/>
        : <>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5">
            <div><div className="flex items-center gap-2"><h2 className="text-xl font-semibold">{active.name}</h2>{recording?.pipelineId === active.id && <Badge tone={recording.phase === 'recording' ? 'danger' : 'warning'}>{recording.phase === 'replaying' ? `Vorbereitung ${(recording.replayStep ?? 0) + 1}/${recording.replayTotal}` : recording.phase === 'opening' ? 'Browser wird geöffnet …' : '● Aufnahme läuft'}</Badge>}</div><p className="mt-1 max-w-2xl text-sm text-muted-foreground">{active.description || 'Noch keine Beschreibung'}</p></div>
            <div className="flex flex-wrap gap-2"><Button variant="ghost" icon={<Copy/>} onClick={() => void duplicatePipeline()}>Kopieren</Button>{recording?.pipelineId === active.id ? <><Button variant="secondary" icon={<Eye/>} disabled={recording.mode === 'extract' || recording.phase !== 'recording'} title={recording.phase !== 'recording' ? 'Verfügbar, sobald die Seite vollständig geöffnet ist.' : undefined} onClick={() => setExtractModal(true)}>Wert erfassen</Button><Button variant="danger" icon={<CircleStop/>} onClick={async () => { await post('/api/recordings/stop'); notify('Aufnahme beendet.') }}>Aufnahme beenden</Button></> : <Button variant="secondary" icon={<Radio/>} onClick={openRecordingModal}>Im Browser aufnehmen</Button>}<Button icon={<Play/>} onClick={() => setRunModal(true)} disabled={!active.steps.length}>Testlauf</Button></div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-zinc-50/70 px-5 py-3"><div><p className="text-sm font-semibold">Schrittfolge</p><p className="text-xs text-muted-foreground">Wird von oben nach unten ausgeführt.</p></div><div className="flex flex-wrap items-center gap-2"><Select className="w-36" aria-label="Wiedergabetempo" value={active.speed} onChange={(event) => void updatePipeline({ speed: event.target.value as Pipeline['speed'] })}><option value="slow">Langsam</option><option value="normal">Normal</option><option value="fast">Schnell</option></Select><Button variant="ghost" size="sm" icon={<Navigation/>} onClick={() => addStep('navigate')}>Seite öffnen</Button><Button variant="ghost" size="sm" icon={<Hourglass/>} onClick={() => addStep('waitFor')}>Warten</Button><Button variant="ghost" size="sm" icon={<Workflow/>} onClick={() => addStep('runPipelines')}>Zwischenablauf</Button><Button variant="ghost" size="sm" icon={<ScanSearch/>} onClick={() => addStep('discoverDevices')}>Geräte finden</Button><Button variant="ghost" size="sm" icon={<GitMerge/>} onClick={() => addStep('mergeAtv')}>ATV-Merger</Button></div></div>
          <div className="min-h-96 space-y-2.5 p-5">{!active.steps.length ? <Empty icon={<MousePointer2/>} title="Noch keine Schritte" text="Starte die Browseraufnahme. Deine Klicks und Eingaben erscheinen danach automatisch in dieser Reihenfolge." action={<Button variant="secondary" icon={<Radio/>} onClick={openRecordingModal}>Aufnahme starten</Button>}/> : active.steps.map((step, index) => { const Icon = stepIcon[step.type]; const selected = selectedStep === index; return <div className={cn('rounded-xl border bg-white transition', selected && 'border-blue-300 bg-blue-50/20 ring-2 ring-blue-100')} key={step.id}>
            <div className="flex items-center"><button className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left" onClick={() => setSelectedStep(selected ? null : index)}><GripVertical className="size-4 text-muted-foreground/40"/><span className={cn('grid size-8 shrink-0 place-items-center rounded-full border bg-white text-xs font-semibold text-muted-foreground', selected && 'border-blue-600 bg-blue-600 text-white')}>{index + 1}</span><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600"><Icon className="size-4"/></span><span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{step.label || stepNames[step.type]}</strong><small className="truncate text-xs text-muted-foreground">{stepSummary(step, dataFields, pipelines)}</small></span><Badge className="hidden sm:inline-flex">{friendlyStepName(step.type)}</Badge></button><div className="flex pr-2"><Button variant="ghost" size="icon-sm" aria-label="Nach oben" disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp/></Button><Button variant="ghost" size="icon-sm" aria-label="Nach unten" disabled={index === active.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown/></Button><Button variant="ghost" size="icon-sm" aria-label="Schritt löschen" onClick={() => { setSelectedStep(null); void updatePipeline({ steps: active.steps.filter((_, i) => i !== index) }) }}><Trash2/></Button></div></div>
            {selected && <><StepEditor step={step} pipelines={pipelines} activePipelineId={active.id} devices={devices} dataFields={dataFields} credentials={credentials} artifacts={artifacts} earlierResults={earlierResults} earlierFiles={earlierFiles} earlierInputs={active.steps.slice(0, index).filter((candidate): candidate is InputValueStep => candidate.type === 'fill' || candidate.type === 'select')} onCreateField={() => setFieldModal(true)} onChange={(next) => updateStep(index, next)}/>{step.type !== 'discoverDevices' && <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-blue-50/60 px-4 py-3"><div><p className="text-sm font-medium text-blue-950">Ab hier manuell weiterbauen</p><p className="text-xs text-blue-700">Schritte 1–{index + 1} sichtbar abspielen, danach deine Klicks direkt hier einfügen.</p></div><Button variant="secondary" icon={<ListPlus/>} disabled={Boolean(recording)} onClick={() => setContinueAfterStep(index)}>Bis hier ausführen & weiter aufnehmen</Button></div>}</>}
          </div>})}</div>
          <div className="flex items-center justify-between border-t bg-muted/20 px-5 py-3 text-xs text-muted-foreground"><span role={saveStatus[active.id] === 'error' ? 'alert' : undefined}>{saveStatus[active.id] === 'saving' ? 'Änderungen werden gespeichert …' : saveStatus[active.id] === 'error' ? 'Speichern fehlgeschlagen.' : saveStatus[active.id] === 'saved' ? 'Alle Änderungen gespeichert.' : 'Änderungen werden automatisch gespeichert.'}{saveStatus[active.id] === 'error' && <Button variant="ghost" size="sm" onClick={() => void saveDraft(active.id)}>Erneut versuchen</Button>}</span><ConfirmButton variant="ghost" icon={<Trash2/>} title="Automation löschen" description={`„${active.name}“ und alle Schritte werden gelöscht.`} onConfirm={async () => { await jobsRef.current.get(active.id); await remove(`/api/pipelines/${active.id}`); setActiveId(null); await reload() }}>Automation löschen</ConfirmButton></div>
        </>}
      </Card>

      <Card className="self-start overflow-hidden shadow-none md:col-span-2 xl:sticky xl:top-7 xl:col-span-1">
        <div className="border-b px-4 py-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><Braces className="size-4"/>Werte weiterreichen</h2><p className="mt-1 text-xs text-muted-foreground">Klicken kopiert die Variable für Eingaben und URLs.</p></div>
        <div className="space-y-4 p-4"><VariableGroup title="Aktuelles Gerät" items={[['Start-URL', '{{device.baseUrl}}'], ['Gerätename', '{{device.name}}']]}/><VariableGroup title="Datentabelle" items={dataFields.map((field) => [field.label, `{{data.${field.key}}}`])}/>{earlierResults.length > 0 && <VariableGroup title="Frühere Ergebnisse" items={earlierResults.map((key) => [key, `{{result.${key}}}`])}/>}<Button className="w-full" variant="secondary" icon={<Plus/>} onClick={() => setFieldModal(true)}>Datenvariable anlegen</Button></div>
      </Card>
    </div>

    {createModal && <Modal title="Neue Automation" description="Ein wiederverwendbarer Ablauf, den du später Geräten zuordnen kannst." onClose={() => setCreateModal(false)}><form onSubmit={submitForm(createPipeline)}><div className="grid gap-5 px-6 py-5"><Field label="Name"><Input name="name" placeholder="z. B. Lizenz aktualisieren" required autoFocus/></Field><Field label="Ziel des Ablaufs"><Input name="description" placeholder="Was erledigt diese Automation?"/></Field></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setCreateModal(false)} submit="Automation anlegen"/></div></form></Modal>}
    {fieldModal && <Modal title="Neue Datenvariable" description="Dafür wird eine neue Spalte in der Datentabelle angelegt." onClose={() => setFieldModal(false)}><form onSubmit={submitForm(createField)}><div className="grid gap-5 px-6 py-5"><Field label="Bezeichnung"><Input name="label" placeholder="z. B. Seriennummer" required autoFocus/></Field><Field label="Datentyp"><Select name="type" defaultValue={active && selectedStep != null && ['download', 'mergeAtv', 'upload'].includes(active.steps[selectedStep]?.type) ? 'file' : 'text'}><option value="text">Text</option><option value="number">Zahl</option><option value="date">Datum</option><option value="url">URL</option><option value="file">Datei</option></Select></Field></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setFieldModal(false)} submit="Variable anlegen"/></div></form></Modal>}
    {recordModal && active && <Modal title="Aufnahme starten" description="Ein sichtbares Chromium-Fenster öffnet sich und übernimmt deine Aktionen live." onClose={() => setRecordModal(false)}><form onSubmit={submitForm(startRecording)}><div className="grid gap-5 px-6 py-5"><Notice title="Sichtbare Aufnahme">Bediene die Webseite normal. Sobald die Startseite geladen ist, wird „Wert erfassen“ automatisch freigeschaltet.</Notice><Field label="Gerät"><Select name="deviceId" value={recordDeviceId} onChange={(event) => { const id = event.target.value; const device = devices.find((item) => item.id === id); setRecordDeviceId(id); setRecordIgnoreHttps(Boolean(device?.ignoreHttpsErrors || (device && shouldSuggestHttpsBypass(device.baseUrl)))) }}><option value="">Start-URL selbst eingeben</option>{devices.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</Select></Field><Field label="Alternative Start-URL" hint="Bleibt leer, wenn ein Gerät ausgewählt ist."><Input name="url" type="url" placeholder={`${location.origin}/fixture/firewall`}/></Field><label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"><input name="ignoreHttpsErrors" type="checkbox" className="mt-0.5 size-4 accent-blue-600" checked={recordIgnoreHttps} onChange={(event) => setRecordIgnoreHttps(event.target.checked)}/><span><strong className="block text-sm font-medium">Selbstsigniertes Zertifikat zulassen</strong><small className="text-xs leading-relaxed text-muted-foreground">Für interne Firewall-Adressen. Die Einstellung wird beim ausgewählten Gerät gespeichert.</small></span></label></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setRecordModal(false)} submit="Browser öffnen"/></div></form></Modal>}
    {extractModal && <Modal title="Text in die Tabelle übernehmen" description="Wähle zuerst, in welche Spalte der angeklickte Text geschrieben werden soll." onClose={() => setExtractModal(false)}><form onSubmit={submitForm(startExtract)}><div className="grid gap-5 px-6 py-5"><Notice title="Wert und Variable gemeinsam erfassen">Nach der Auswahl klickst du den Text im sichtbaren Browser an. Der aktuelle Wert erscheint sofort beim aufgenommenen Gerät in der Tabelle.</Notice>{dataFields.length ? <Field label="Zielspalte"><Select name="key" defaultValue={dataFields.find((field) => field.key === 'seriennummer')?.key || dataFields[0]?.key} required>{dataFields.map((field) => <option value={field.key} key={field.id}>{field.label} · {`{{data.${field.key}}}`}</option>)}</Select></Field> : <Notice tone="warning" title="Noch keine Tabellenspalte">Lege zuerst eine Datenvariable an.</Notice>}</div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setExtractModal(false)} submit="Text im Browser auswählen"/></div></form></Modal>}
    {continueAfterStep != null && active && <Modal title={`Nach Schritt ${continueAfterStep + 1} weiter aufnehmen`} description="Die Automation bringt den Browser zuerst automatisch an die richtige Stelle." onClose={() => setContinueAfterStep(null)}><form onSubmit={submitForm(continueRecording)}><div className="grid gap-5 px-6 py-5"><Notice title="Automatisch bis zum Übergabepunkt">Du siehst jeden bisherigen Schritt im Browser. Danach stoppt die Automatik, das Fenster bleibt offen und alle deine folgenden Aktionen werden direkt nach Schritt {continueAfterStep + 1} eingefügt.</Notice><Field label="Gerät" hint="Variablen und Zugangsdaten werden von diesem Gerät verwendet."><Select name="deviceId" defaultValue={devices[0]?.id || ''} required><option value="" disabled>Gerät auswählen …</option>{devices.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</Select></Field>{!devices.length && <p className="text-sm text-destructive">Lege zuerst ein Gerät an.</p>}</div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setContinueAfterStep(null)} submit={`Bis Schritt ${continueAfterStep + 1} ausführen`}/></div></form></Modal>}
    {runModal && active && <RunStartModal pipeline={active} devices={devices} pipelines={pipelines} credentials={credentials} artifacts={artifacts} discoverySource={discoverySource} onClose={() => setRunModal(false)} onStart={startRun}/>}
  </>
}

function RunStartModal({ pipeline, devices, pipelines, credentials, artifacts, discoverySource, onClose, onStart }: { pipeline: Pipeline; devices: Device[]; pipelines: Pipeline[]; credentials: Credential[]; artifacts: Artifact[]; discoverySource?: Device; onClose: () => void; onStart: (deviceIds: string[]) => Promise<void> }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const isDiscovery = pipeline.steps.some((step) => step.type === 'discoverDevices')
  const targets = isDiscovery ? discoverySource ? [discoverySource] : [] : devices.filter((device) => selectedIds.includes(device.id))
  const warnings = [...new Set(targets.flatMap((device) => inspectRun(pipeline, device, pipelines, credentials, artifacts).map((warning) => `${device.name}: ${warning}`)))]
  return <Modal title="Automation sichtbar ausführen" description={isDiscovery ? 'Das Portal wird durchsucht; gefundene Geräte können angelegt werden.' : 'Die ausgewählten Geräte werden nacheinander verarbeitet.'} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); if (!targets.length || busy) return; setBusy(true); void onStart(selectedIds).finally(() => setBusy(false)) }}>
      <div className="grid gap-4 px-6 py-5">
        <Notice tone="info" title="Live im Browser">Ziele werden markiert, Klicks animiert und der aktuelle Schritt eingeblendet. Die Automation führt echte Aktionen am Gerät aus.</Notice>
        {isDiscovery ? <div className="rounded-lg border bg-muted/25 p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quellgerät</p><p className="mt-1 text-sm font-semibold">{discoverySource?.name ?? 'Noch nicht ausgewählt'}</p><p className="mt-0.5 text-xs text-muted-foreground">{discoverySource ? discoverySource.baseUrl : 'Öffne den Suchschritt und wähle zuerst ein Portal als Quelle.'}</p></div> : <><div className="flex items-center justify-between text-sm"><strong>Zielgeräte</strong><span>{selectedIds.length} ausgewählt</span></div><div className="max-h-56 space-y-2 overflow-auto">{devices.map((device) => <label key={device.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-muted"><input type="checkbox" value={device.id} checked={selectedIds.includes(device.id)} onChange={() => setSelectedIds((current) => current.includes(device.id) ? current.filter((id) => id !== device.id) : [...current, device.id])} className="size-4 accent-blue-600"/><span className="grid min-w-0"><strong className="truncate text-sm font-medium">{device.name}</strong><small className="truncate text-xs text-muted-foreground">{device.baseUrl}</small></span></label>)}{!devices.length && <p className="text-sm text-muted-foreground">Lege zuerst ein Gerät an.</p>}</div></>}
        {warnings.length > 0 && <Notice tone="warning" title={`${warnings.length} Hinweise vor dem Start`}>{warnings.map((warning) => <span key={warning} className="block">{warning}</span>)}</Notice>}
      </div>
      <div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={onClose} busy={busy} submitDisabled={!targets.length} submit={warnings.length ? 'Trotzdem ausführen' : isDiscovery ? 'Geräte suchen' : 'Lauf starten'}/></div>
    </form>
  </Modal>
}

function VariableGroup({ title, items }: { title: string; items: string[][] }) {
  return <div><p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p><div className="space-y-1">{items.length ? items.map(([label, value]) => <button key={value} className="group block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted" title="In Zwischenablage kopieren" onClick={() => void navigator.clipboard.writeText(value)}><span className="block truncate text-xs font-medium">{label}</span><code className="block truncate font-mono text-[10px] text-muted-foreground group-hover:text-foreground">{value}</code></button>) : <p className="px-2 text-xs text-muted-foreground">Noch keine Felder</p>}</div></div>
}

function StepEditor({ step, pipelines, activePipelineId, devices, dataFields, credentials, artifacts, earlierResults, earlierFiles, earlierInputs, onCreateField, onChange }: { step: PipelineStep; pipelines: Pipeline[]; activePipelineId: string; devices: Device[]; dataFields: DataField[]; credentials: Credential[]; artifacts: Artifact[]; earlierResults: string[]; earlierFiles: string[]; earlierInputs: InputValueStep[]; onCreateField: () => void; onChange: (step: PipelineStep) => void }) {
  return <div className="grid gap-4 border-t bg-zinc-50/70 p-4 md:grid-cols-2">
    <Field className="md:col-span-2" label="Was passiert in diesem Schritt?"><Input value={step.label ?? ''} onChange={(event) => onChange({ ...step, label: event.target.value })}/></Field>
    {step.type === 'discoverDevices' && <DiscoveryEditor step={step} devices={devices} onChange={onChange}/>}
    {step.type === 'runPipelines' && <NestedPipelinesEditor step={step} pipelines={pipelines} activePipelineId={activePipelineId} onChange={onChange}/>}
    {'value' in step && <ValueEditor value={step.value} dataFields={dataFields} credentials={credentials} earlierResults={earlierResults} onChange={(value) => onChange({ ...step, value })}/>}
    {step.type === 'navigate' && <ValueEditor value={step.url} label="URL-Quelle" dataFields={dataFields} credentials={credentials} earlierResults={earlierResults} onChange={(url) => onChange({ ...step, url })}/>}
    {step.type === 'extractText' && <><Field label="Ziel in der Datentabelle" hint="Der gelesene Text wird für das aktuelle Gerät in diese Spalte geschrieben."><Select value={step.key} onChange={(event) => onChange({ ...step, key: event.target.value, persist: true })}>{!dataFields.some((field) => field.key === step.key) && <option value={step.key}>{step.key} (aufgenommen)</option>}{dataFields.map((field) => <option value={field.key} key={field.id}>{field.label}</option>)}</Select></Field><div className="flex items-end"><Button variant="secondary" icon={<Database/>} onClick={onCreateField}>Neue Tabellenspalte</Button></div></>}
    {step.type === 'download' && <><Field label="In Dateivariable speichern" hint="Der Download erscheint beim aktuellen Gerät als Datei in der Datentabelle. Eine fehlende Dateispalte wird beim Lauf angelegt."><Input value={step.artifactKey} list={`file-fields-${step.id}`} onChange={(event) => onChange({ ...step, artifactKey: event.target.value })}/><datalist id={`file-fields-${step.id}`}>{dataFields.filter((field) => field.type === 'file').map((field) => <option key={field.id} value={field.key}>{field.label}</option>)}</datalist></Field><Field label="Den richtigen Eintrag finden" hint="Sucht zuerst die Tabellenzeile mit dem tatsächlich eingegebenen Profilnamen und lädt nur dort herunter."><Select value={step.match?.source.type === 'stepValue' ? step.match.source.stepId : ''} onChange={(event) => onChange({ ...step, match: event.target.value ? { source: { type: 'stepValue', stepId: event.target.value }, containerSelector: 'tr' } : undefined })}><option value="">Aufgenommenen Download direkt verwenden</option>{earlierInputs.filter((input) => input.value.type !== 'credentialField').map((input) => <option value={input.id} key={input.id}>Eingabe „{input.label || sourceSummary(input.value, dataFields)}“ verwenden</option>)}</Select></Field></>}
    {step.type === 'upload' && <FileEditor file={step.file} dataFields={dataFields} earlierFiles={earlierFiles} artifacts={artifacts} onChange={(file) => onChange({ ...step, file })}/>}
    {step.type === 'mergeAtv' && <>
      <div className="md:col-span-2"><Notice tone="warning" title="Vorläufiger ATV-Merge">Datei A ist die Basis. Gleichnamige Hauptabschnitte aus Datei B ersetzen die aus A; neue Abschnitte werden angefügt. Prüfe die Ergebnisdatei vor einem Upload auf ein Gerät.</Notice></div>
      <div className="grid gap-4 rounded-lg border bg-white p-4 md:col-span-2 md:grid-cols-2">
        <div className="grid content-start gap-3"><h4 className="text-sm font-semibold">Datei A · Basis</h4><FileEditor file={step.first} dataFields={dataFields} earlierFiles={earlierFiles} artifacts={artifacts} label="Datei A" onlyAtv onChange={(first) => onChange({ ...step, first })}/></div>
        <div className="grid content-start gap-3"><h4 className="text-sm font-semibold">Datei B · Ergänzungen und Vorrang</h4><FileEditor file={step.second} dataFields={dataFields} earlierFiles={earlierFiles} artifacts={artifacts} label="Datei B" onlyAtv onChange={(second) => onChange({ ...step, second })}/></div>
      </div>
      <Field label="Ergebnis in Dateivariable" hint="Die Ergebnisdatei wird in der Datentabelle beim aktuellen Gerät gespeichert. Eine fehlende Dateispalte wird angelegt."><Input value={step.outputKey} list={`file-fields-${step.id}`} placeholder="z. B. atv-merge" onChange={(event) => onChange({ ...step, outputKey: event.target.value })}/><datalist id={`file-fields-${step.id}`}>{dataFields.filter((field) => field.type === 'file').map((field) => <option key={field.id} value={field.key}>{field.label}</option>)}</datalist></Field>
      <Field label="Name der Ergebnisdatei"><Input value={step.outputName} placeholder="zusammengefuehrt.atv" onChange={(event) => onChange({ ...step, outputName: event.target.value })}/></Field>
    </>}
    {step.type === 'waitFor' && !step.locator && <Field label="Wartezeit in Sekunden"><Input type="number" min="0" step="0.1" value={(step.milliseconds ?? 1000) / 1000} onChange={(event) => onChange({ ...step, milliseconds: Number(event.target.value) * 1000 })}/></Field>}
    {step.type !== 'runPipelines' && <details className="rounded-lg border bg-white md:col-span-2"><summary className="cursor-pointer px-3 py-2.5 text-xs font-medium">Technische Details</summary><div className="grid gap-4 border-t p-3">{'locator' in step && step.locator && <LocatorEditor locator={step.locator} onChange={(locator) => onChange({ ...step, locator } as PipelineStep)}/>}<Field label="Zeitlimit in Millisekunden" hint="Leer verwendet den Standardwert."><Input type="number" min="100" value={step.timeoutMs ?? ''} onChange={(event) => onChange({ ...step, timeoutMs: event.target.value ? Number(event.target.value) : undefined })}/></Field></div></details>}
  </div>
}

type NestedPipelinesStep = Extract<PipelineStep, { type: 'runPipelines' }>

function NestedPipelinesEditor({ step, pipelines, activePipelineId, onChange }: { step: NestedPipelinesStep; pipelines: Pipeline[]; activePipelineId: string; onChange: (step: PipelineStep) => void }) {
  const selected = step.pipelineIds.map((id) => pipelines.find((pipeline) => pipeline.id === id)).filter((pipeline): pipeline is Pipeline => Boolean(pipeline))
  const available = pipelines.filter((pipeline) => pipeline.id !== activePipelineId && !step.pipelineIds.includes(pipeline.id))
  const move = (index: number, direction: -1 | 1) => {
    const next = index + direction
    if (next < 0 || next >= step.pipelineIds.length) return
    const pipelineIds = [...step.pipelineIds]
    ;[pipelineIds[index], pipelineIds[next]] = [pipelineIds[next], pipelineIds[index]]
    onChange({ ...step, pipelineIds })
  }

  return <div className="space-y-3 md:col-span-2">
    <Notice tone="success" title="Eine Anmeldung, mehrere Abläufe">Diese Automation wartet hier. Die ausgewählten Automationen laufen im selben Browserfenster vollständig durch; anschließend geht es mit dem nächsten Schritt weiter.</Notice>
    <Field label="Automation an dieser Stelle einfügen" hint="Mehrere Einträge werden in der unten gezeigten Reihenfolge ausgeführt."><Select value="" disabled={!available.length} onChange={(event) => { if (event.target.value) onChange({ ...step, pipelineIds: [...step.pipelineIds, event.target.value] }) }}><option value="">{available.length ? 'Automation auswählen …' : 'Keine weitere Automation verfügbar'}</option>{available.map((pipeline) => <option value={pipeline.id} key={pipeline.id}>{pipeline.name} · {pipeline.steps.length} Schritte</option>)}</Select></Field>
    <div className="space-y-2">{selected.map((pipeline, index) => <div className="flex items-center gap-3 rounded-lg border bg-white p-3" key={pipeline.id}><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700"><Workflow className="size-4"/></span><span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{pipeline.name}</strong><small className="text-xs text-muted-foreground">{pipeline.steps.length} Schritte · gleiche Browsersitzung</small></span><Button variant="ghost" size="icon-sm" aria-label={`${pipeline.name} nach oben`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp/></Button><Button variant="ghost" size="icon-sm" aria-label={`${pipeline.name} nach unten`} disabled={index === selected.length - 1} onClick={() => move(index, 1)}><ArrowDown/></Button><Button variant="ghost" size="icon-sm" aria-label={`${pipeline.name} entfernen`} onClick={() => onChange({ ...step, pipelineIds: step.pipelineIds.filter((id) => id !== pipeline.id) })}><Trash2/></Button></div>)}{!selected.length && <div className="rounded-lg border border-dashed bg-white px-4 py-6 text-center"><p className="text-sm font-medium">Noch kein Zwischenablauf ausgewählt</p><p className="mt-1 text-xs text-muted-foreground">Wähle oben die Automation, die ohne neue Anmeldung dazwischen laufen soll.</p></div>}</div>
  </div>
}

function LocatorEditor({ locator, onChange }: { locator: LocatorSpec; onChange: (locator: LocatorSpec) => void }) {
  const first = locator.candidates[0]
  const value = first?.kind === 'role' ? first.name ?? '' : first?.value ?? ''
  return <Field label="Ziel des Schritts" hint="Variablen sind möglich, z. B. {{device.name}} oder {{data.bereich}}."><Input value={value} onChange={(event) => {
    if (!first) return
    const candidate = first.kind === 'role' ? { ...first, name: event.target.value } : { ...first, value: event.target.value }
    onChange({ ...locator, description: event.target.value, candidates: [candidate] })
  }}/></Field>
}

type DiscoveryStep = Extract<PipelineStep, { type: 'discoverDevices' }>

const cssSpec = (value: string, description: string): LocatorSpec => ({ description, candidates: [{ kind: 'css', value }] })
const textSpec = (value: string): LocatorSpec => ({ description: value, candidates: [{ kind: 'text', value, exact: true }] })
const locatorValue = (spec?: LocatorSpec) => spec?.candidates[0]?.value ?? ''

function makeDiscoveryStep(): DiscoveryStep {
  return {
    id: makeId('step'),
    type: 'discoverDevices',
    label: 'Geräte aus Kacheln übernehmen',
    collections: [{
      id: 'bereich', label: 'Bereiche', items: cssSpec('', 'Bereichskarten'), itemLabel: cssSpec('', 'Bereichsname'),
      leave: { type: 'back' },
    }],
    record: {
      items: cssSpec('', 'Maschinenkarten'),
      name: cssSpec('', 'Maschinenname'),
      open: cssSpec('', 'Maschinendetails öffnen'),
      afterOpen: [textSpec('VPN client information')],
      fields: [
        { key: 'router_typ', label: 'Router-Typ', locator: cssSpec('', 'Router-Typ') },
        { key: 'ip_adresse', label: 'IP-Adresse', locator: cssSpec('', 'IP-Adresse') },
      ],
      close: cssSpec('', 'Details schließen'),
    },
    addressKey: 'ip_adresse',
    requiredTypeKey: 'router_typ',
    requiredTypeValue: 'mGuard (router mode)',
    baseUrlTemplate: 'https://{{result.ip_adresse}}',
    duplicatePolicy: 'lastWins',
    apply: true,
  }
}

function DiscoveryEditor({ step, devices, onChange }: { step: DiscoveryStep; devices: Device[]; onChange: (step: PipelineStep) => void }) {
  const updateCollection = (index: number, next: DiscoveryCollectionLevel) => {
    const collections = [...step.collections]
    collections[index] = next
    onChange({ ...step, collections })
  }
  const updateField = (index: number, next: DiscoveryField) => {
    const fields = [...step.record.fields]
    fields[index] = next
    onChange({ ...step, record: { ...step.record, fields } })
  }

  return <div className="space-y-4 md:col-span-2">
    <Notice title="Sequenziell und sichtbar">Jede äußere Kachel wird vollständig abgearbeitet. Darin werden alle Maschinen nacheinander geöffnet, gelesen und wieder geschlossen.</Notice>

    <section className="rounded-lg border bg-white p-4">
      <Field label="Quellgerät / Portal" hint="Dieses Gerät öffnet das Portal. Die gefundenen Maschinen werden anschließend als eigene Geräte angelegt."><Select value={step.sourceDeviceId ?? ''} onChange={(event) => onChange({ ...step, sourceDeviceId: event.target.value || undefined })}><option value="">Quellgerät auswählen …</option>{devices.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</Select></Field>
    </section>

    <details className="group rounded-lg border bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">1</span><span className="grid flex-1"><strong className="text-sm font-semibold">Bereiche durchlaufen</strong><small className="text-xs text-muted-foreground">{step.collections.length} {step.collections.length === 1 ? 'Ebene' : 'Ebenen'} · etwa Standort, Halle oder Ordner</small></span><ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90"/></summary>
      <div className="border-t p-4"><div className="mb-3 flex justify-end"><Button variant="secondary" size="sm" icon={<Plus/>} onClick={() => onChange({ ...step, collections: [...step.collections, { id: `ebene_${step.collections.length + 1}`, label: `Ebene ${step.collections.length + 1}`, items: cssSpec('', 'Kacheln'), itemLabel: cssSpec('', 'Bezeichnung'), leave: { type: 'back' } }] })}>Ebene hinzufügen</Button></div><div className="space-y-3">{step.collections.map((level, index) => <div className="grid gap-3 rounded-lg bg-muted/35 p-3 md:grid-cols-2" key={index}>
        <div className="flex items-center justify-between md:col-span-2"><strong className="text-xs uppercase tracking-wide text-muted-foreground">Ebene {index + 1}</strong>{step.collections.length > 1 && <Button variant="ghost" size="icon-sm" aria-label="Ebene entfernen" onClick={() => onChange({ ...step, collections: step.collections.filter((_, current) => current !== index) })}><Trash2/></Button>}</div>
        <Field label="Bezeichnung"><Input value={level.label} onChange={(event) => updateCollection(index, { ...level, label: event.target.value })}/></Field>
        <Field label="Variablenname"><Input value={level.id} onChange={(event) => updateCollection(index, { ...level, id: event.target.value })}/></Field>
        <Field label="Kacheln finden (CSS)" hint="Dieser Selektor muss alle Kacheln dieser Ebene treffen."><Input className="font-mono" value={locatorValue(level.items)} placeholder=".location-card" onChange={(event) => updateCollection(index, { ...level, items: cssSpec(event.target.value, level.label) })}/></Field>
        <Field label="Name in der Kachel (CSS)"><Input className="font-mono" value={locatorValue(level.itemLabel)} placeholder=".card-title" onChange={(event) => updateCollection(index, { ...level, itemLabel: event.target.value ? cssSpec(event.target.value, `${level.label}-Name`) : undefined })}/></Field>
        <Field label="Öffnen innerhalb der Kachel (CSS)" hint="Leer bedeutet: die ganze Kachel anklicken."><Input className="font-mono" value={locatorValue(level.open)} placeholder="Leer = Kachel" onChange={(event) => updateCollection(index, { ...level, open: event.target.value ? cssSpec(event.target.value, `${level.label} öffnen`) : undefined })}/></Field>
        <Field label="Nach der Ebene zurück"><Select value={level.leave.type} onChange={(event) => updateCollection(index, event.target.value === 'back' ? { ...level, leave: { type: 'back' } } : { ...level, leave: { type: 'click', locator: cssSpec('', `${level.label} verlassen`) } })}><option value="back">Browser zurück</option><option value="click">Element anklicken</option></Select></Field>
        {level.leave.type === 'click' && <Field label="Zurück-/Schließen-Element (CSS)"><Input className="font-mono" value={locatorValue(level.leave.locator)} onChange={(event) => updateCollection(index, { ...level, leave: { type: 'click', locator: cssSpec(event.target.value, `${level.label} verlassen`) } })}/></Field>}
      </div>)}</div></div>
    </details>

    <details className="group rounded-lg border bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">2</span><span className="grid flex-1"><strong className="text-sm font-semibold">Einträge öffnen</strong><small className="text-xs text-muted-foreground">Maschinenkarten finden und Detailansicht öffnen</small></span><ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90"/></summary>
      <div className="grid gap-3 border-t p-4 md:grid-cols-2">
        <Field label="Eintragskacheln (CSS)"><Input className="font-mono" value={locatorValue(step.record.items)} placeholder=".machine-card" onChange={(event) => onChange({ ...step, record: { ...step.record, items: cssSpec(event.target.value, 'Eintragskacheln') } })}/></Field>
        <Field label="Name innerhalb der Kachel (CSS)"><Input className="font-mono" value={locatorValue(step.record.name)} placeholder=".machine-name" onChange={(event) => onChange({ ...step, record: { ...step.record, name: cssSpec(event.target.value, 'Gerätename') } })}/></Field>
        <Field label="Details öffnen, relativ zur Kachel (CSS)"><Input className="font-mono" value={locatorValue(step.record.open)} placeholder="button.more" onChange={(event) => onChange({ ...step, record: { ...step.record, open: cssSpec(event.target.value, 'Details öffnen') } })}/></Field>
        <Field label="Details schließen (CSS)" hint="Leer lassen, wenn die Seite selbst zurücknavigiert."><Input className="font-mono" value={locatorValue(step.record.close)} placeholder="button.close" onChange={(event) => onChange({ ...step, record: { ...step.record, close: event.target.value ? cssSpec(event.target.value, 'Details schließen') : undefined } })}/></Field>
      </div>
      <div className="border-t px-4 py-3"><div className="mb-2 flex items-center justify-between"><div><h4 className="text-sm font-medium">Nach dem Öffnen anklicken</h4><p className="text-xs text-muted-foreground">Diese Texte werden der Reihe nach geöffnet, etwa „VPN client information“.</p></div><Button variant="secondary" size="sm" icon={<Plus/>} onClick={() => onChange({ ...step, record: { ...step.record, afterOpen: [...step.record.afterOpen, textSpec('')] } })}>Aktion</Button></div><div className="space-y-2">{step.record.afterOpen.map((action, index) => <div className="flex gap-2" key={index}><Input value={locatorValue(action)} placeholder="Sichtbarer Text" onChange={(event) => { const afterOpen = [...step.record.afterOpen]; afterOpen[index] = textSpec(event.target.value); onChange({ ...step, record: { ...step.record, afterOpen } }) }}/><Button variant="ghost" size="icon-sm" aria-label="Aktion entfernen" onClick={() => onChange({ ...step, record: { ...step.record, afterOpen: step.record.afterOpen.filter((_, current) => current !== index) } })}><Trash2/></Button></div>)}</div></div>
    </details>

    <details className="group rounded-lg border bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">3</span><span className="grid flex-1"><strong className="text-sm font-semibold">Werte auslesen</strong><small className="text-xs text-muted-foreground">{step.record.fields.length} {step.record.fields.length === 1 ? 'Wert' : 'Werte'} · fehlende optionale Werte werden übersprungen</small></span><ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90"/></summary>
      <div className="border-t p-4"><div className="mb-3 flex justify-end"><Button variant="secondary" size="sm" icon={<Plus/>} onClick={() => onChange({ ...step, record: { ...step.record, fields: [...step.record.fields, { key: `feld_${step.record.fields.length + 1}`, label: 'Neues Feld', locator: cssSpec('', 'Neues Feld') }] } })}>Wert hinzufügen</Button></div><div className="space-y-3">{step.record.fields.map((field, index) => <div className="grid gap-3 rounded-lg bg-muted/35 p-3 md:grid-cols-[1fr_1fr_2fr_auto]" key={index}>
        <Field label="Bezeichnung"><Input value={field.label} onChange={(event) => updateField(index, { ...field, label: event.target.value })}/></Field>
        <Field label="Variablenname"><Input value={field.key} onChange={(event) => updateField(index, { ...field, key: event.target.value })}/></Field>
        <Field label="Wert finden (CSS)"><Input className="font-mono" value={locatorValue(field.locator)} placeholder=".ip-address" onChange={(event) => updateField(index, { ...field, locator: cssSpec(event.target.value, field.label) })}/></Field>
        <div className="flex items-end"><Button variant="ghost" size="icon-sm" aria-label="Feld entfernen" onClick={() => onChange({ ...step, record: { ...step.record, fields: step.record.fields.filter((_, current) => current !== index) } })}><Trash2/></Button></div>
      </div>)}</div></div>
    </details>

    <details className="group rounded-lg border bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">4</span><span className="grid flex-1"><strong className="text-sm font-semibold">Ergebnis übernehmen</strong><small className="text-xs text-muted-foreground">{step.apply ? 'Gefundene Einträge werden als Geräte gespeichert' : 'Nur Vorschau im Laufprotokoll'}</small></span><ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90"/></summary>
      <div className="grid gap-3 border-t p-4 md:grid-cols-2">
        <Field label="IP-/Adressvariable"><Select value={step.addressKey} onChange={(event) => onChange({ ...step, addressKey: event.target.value })}>{step.record.fields.map((field) => <option value={field.key} key={field.key}>{field.label} · {field.key}</option>)}</Select></Field>
        <Field label="Start-URL"><Input className="font-mono" value={step.baseUrlTemplate} onChange={(event) => onChange({ ...step, baseUrlTemplate: event.target.value })}/></Field>
        <Field label="Typvariable"><Select value={step.requiredTypeKey ?? ''} onChange={(event) => onChange({ ...step, requiredTypeKey: event.target.value || undefined })}><option value="">Keine Typprüfung</option>{step.record.fields.map((field) => <option value={field.key} key={field.key}>{field.label} · {field.key}</option>)}</Select></Field>
        <Field label="Erforderlicher Typ"><Input value={step.requiredTypeValue ?? ''} disabled={!step.requiredTypeKey} onChange={(event) => onChange({ ...step, requiredTypeValue: event.target.value })}/></Field>
        <Field label="Bei gleicher Start-URL"><Select value={step.duplicatePolicy} onChange={(event) => onChange({ ...step, duplicatePolicy: event.target.value as DiscoveryStep['duplicatePolicy'] })}><option value="lastWins">Letzter Fund gewinnt</option><option value="firstWins">Erster Fund gewinnt</option></Select></Field>
        <label className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm"><input type="checkbox" checked={step.apply} onChange={(event) => onChange({ ...step, apply: event.target.checked })}/><span><strong className="block font-medium">In die Gerätetabelle schreiben</strong><small className="text-muted-foreground">Aus = nur Vorschau im Laufprotokoll</small></span></label>
      </div>
    </details>
  </div>
}

function ValueEditor({ value, onChange, dataFields, credentials, earlierResults, label = 'Wertquelle' }: { value: ValueSource; onChange: (value: ValueSource) => void; dataFields: DataField[]; credentials: Credential[]; earlierResults: string[]; label?: string }) {
  return <><Field label={label}><Select value={value.type} onChange={(event) => { const type = event.target.value as ValueSource['type']; if (type === 'literal') onChange({ type, value: '' }); if (type === 'deviceField') onChange({ type, key: 'baseUrl' }); if (type === 'runValue') onChange({ type, key: earlierResults[0] ?? '' }); if (type === 'credentialField') onChange({ type, field: 'username' }) }}><option value="literal">Fester Wert</option><option value="deviceField">Gerät oder Datentabelle</option><option value="credentialField">Zugangsdaten</option><option value="runValue">Ergebnis eines früheren Schritts</option></Select></Field>
    {value.type === 'literal' && <Field label="Fester Wert"><Input value={value.value} onChange={(event) => onChange({ ...value, value: event.target.value })}/></Field>}
    {value.type === 'deviceField' && <Field label="Variable"><Select value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })}><option value="baseUrl">Start-URL · device.baseUrl</option><option value="name">Gerätename · device.name</option>{dataFields.map((field) => <option value={field.key} key={field.id}>{field.label} · data.{field.key}</option>)}</Select></Field>}
    {value.type === 'runValue' && <Field label="Früheres Ergebnis"><Select value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })}><option value="">Ergebnis wählen …</option>{earlierResults.map((key) => <option value={key} key={key}>{key}</option>)}</Select></Field>}
    {value.type === 'credentialField' && <><Field label="Feld"><Select value={value.field} onChange={(event) => onChange({ ...value, field: event.target.value as 'username' | 'password' })}><option value="username">Benutzername</option><option value="password">Passwort</option></Select></Field><Field label="Profil"><Select value={value.credentialId || ''} onChange={(event) => onChange({ ...value, credentialId: event.target.value || undefined })}><option value="">Vom Gerät übernehmen</option>{credentials.map((credential) => <option value={credential.id} key={credential.id}>{credential.name}</option>)}</Select></Field></>}
  </>
}

function FileEditor({ file, dataFields, earlierFiles, artifacts, onChange, label = 'Upload', onlyAtv = false }: { file: FileSource; dataFields: DataField[]; earlierFiles: string[]; artifacts: Artifact[]; onChange: (file: FileSource) => void; label?: string; onlyAtv?: boolean }) {
  const fields = dataFields.filter((field) => field.type === 'file')
  const pending = [...new Set(earlierFiles)].filter((key) => !fields.some((field) => field.key === key) && !(file.type === 'retainedArtifact' && file.key === key))
  const legacy = file.type === 'retainedArtifact' && Boolean(file.key) && !fields.some((field) => field.key === file.key)
  const missing = file.type !== 'localFile' && file.key && !fields.some((field) => field.key === file.key) && !pending.includes(file.key) && !legacy
  return file.type === 'localFile' ? <>
    <Field label={`${label} · lokaler Dateipfad`}><Input value={file.path} placeholder={onlyAtv ? '/Users/.../datei.atv' : '/Users/.../datei.txt'} onChange={(event) => onChange({ ...file, path: event.target.value })}/></Field>
    <Button variant="ghost" size="sm" onClick={() => onChange({ type: 'dataFile', key: '' })}>Dateivariable verwenden</Button>
  </> : <>
    <Field label={`${label} · Dateivariable`} hint="Die Datei wird aus der Tabellenzeile des aktuellen Geräts gelesen.">
      <Select value={file.key} onChange={(event) => onChange({ type: 'dataFile', key: event.target.value })}>
        <option value="">Dateivariable auswählen …</option>
        {legacy && <option value={file.key}>{file.key} · bisheriger Dateischlüssel</option>}
        {missing && <option value={file.key}>{file.key} · derzeit nicht verfügbar</option>}
        {pending.map((key) => <option value={key} key={key}>{key} · aus einem früheren Schritt</option>)}
        {fields.map((field) => <option value={field.key} key={field.id}>{field.label} · {field.key}</option>)}
      </Select>
    </Field>
    <Button variant="ghost" size="sm" onClick={() => onChange({ type: 'localFile', path: '' })}>Lokalen Dateipfad verwenden</Button>
  </>
}

function stepSummary(step: PipelineStep, fields: DataField[], pipelines: Pipeline[]) {
  switch (step.type) {
    case 'navigate': return sourceSummary(step.url, fields)
    case 'fill': case 'select': return sourceSummary(step.value, fields)
    case 'extractText': return `→ ${fields.find((field) => field.key === step.key)?.label ?? step.key}`
    case 'download': return `Dateivariable: ${step.artifactKey}`
    case 'upload': return step.file.type === 'localFile' ? step.file.path || 'Datei noch wählen' : `Dateivariable: ${step.file.key || 'noch wählen'}`
    case 'mergeAtv': return `${step.first.type === 'localFile' ? step.first.path || 'Datei A wählen' : step.first.key || 'Datei A wählen'} + ${step.second.type === 'localFile' ? step.second.path || 'Datei B wählen' : step.second.key || 'Datei B wählen'} → ${step.outputKey || 'Ergebnisvariable'}`
    case 'runPipelines': return step.pipelineIds.length ? step.pipelineIds.map((id) => pipelines.find((pipeline) => pipeline.id === id)?.name || 'Fehlende Automation').join(' → ') : 'Noch keine Automation ausgewählt'
    case 'beginSubflow': return `${step.pipelineName} im gleichen Browser starten`
    case 'endSubflow': return `Zum pausierten Ablauf zurückkehren`
    case 'waitFor': return step.locator ? `Warten auf ${step.locator.description || 'Element'}` : `${step.milliseconds ?? 1000} ms`
    case 'press': return `Taste ${step.key}`
    case 'toggle': return step.checked ? 'Aktivieren' : 'Deaktivieren'
    case 'discoverDevices': return `${step.collections.length} Ebenen · ${step.apply ? 'in Gerätetabelle übernehmen' : 'nur Vorschau'}`
    default: return 'locator' in step ? step.locator.description || step.locator.candidates[0]?.value || 'Aufgenommenes Element' : ''
  }
}
function sourceSummary(source: ValueSource, fields: DataField[]) { if (source.type === 'literal') return source.value || 'Fester Wert ist leer'; if (source.type === 'deviceField') return fields.find((field) => field.key === source.key)?.label ?? source.key; if (source.type === 'runValue') return `Ergebnis: ${source.key}`; return `Zugangsdaten: ${source.field === 'username' ? 'Benutzername' : 'Passwort'}` }
function friendlyStepName(type: PipelineStep['type']) {
  const names: Record<PipelineStep['type'], string> = {
    navigate: 'Seite öffnen', click: 'Klick', fill: 'Eingabe', select: 'Auswahl', toggle: 'Schalter', press: 'Taste',
    extractText: 'Wert lesen', waitFor: 'Warten', download: 'Download', upload: 'Upload', mergeAtv: 'ATV-Merger', runPipelines: 'Zwischenablauf', beginSubflow: 'Übergabe', endSubflow: 'Fortsetzen', discoverDevices: 'Geräte finden',
  }
  return names[type]
}
function speedLabel(speed: Pipeline['speed']) { return speed === 'slow' ? 'Langsam' : speed === 'fast' ? 'Schnell' : 'Normal' }
function shouldSuggestHttpsBypass(value: string) {
  try {
    const url = new URL(value)
    const parts = url.hostname.split('.').map(Number)
    const privateAddress = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    )
    return url.protocol === 'https:' && privateAddress
  } catch { return false }
}
