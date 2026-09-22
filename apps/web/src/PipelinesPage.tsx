import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Braces, CircleStop, Database, Eye, FileDown, FileUp, GripVertical, Hourglass, ListPlus, MousePointer2, Navigation, Play, Plus, Radio, Trash2, Type, Workflow } from 'lucide-react'
import type { Credential, DataField, Device, FileSource, Pipeline, PipelineStep, RecordingStatus, ValueSource } from '@autosecure/shared'
import { makeId, stepNames } from '@autosecure/shared'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { patch, post, remove } from './api.ts'
import { Badge, Button, Empty, Field, FormActions, Input, Modal, Notice, PageHeader, Select, submitForm } from './components.tsx'

type Props = {
  pipelines: Pipeline[]; devices: Device[]; dataFields: DataField[]; credentials: Credential[]; recording: RecordingStatus | null
  reload: () => Promise<void>; notify: (message: string, tone?: 'success' | 'error') => void; openRuns: () => void
}

const stepIcon: Record<PipelineStep['type'], typeof MousePointer2> = {
  navigate: Navigation, click: MousePointer2, fill: Type, select: Type, toggle: Radio,
  press: Type, extractText: Eye, waitFor: Hourglass, download: FileDown, upload: FileUp,
}

export function PipelinesPage({ pipelines, devices, dataFields, credentials, recording, reload, notify, openRuns }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [createModal, setCreateModal] = useState(false)
  const [recordModal, setRecordModal] = useState(false)
  const [extractModal, setExtractModal] = useState(false)
  const [continueAfterStep, setContinueAfterStep] = useState<number | null>(null)
  const [runModal, setRunModal] = useState(false)
  const [fieldModal, setFieldModal] = useState(false)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const active = pipelines.find((item) => item.id === activeId) ?? pipelines[0]
  useEffect(() => { if (!activeId && pipelines[0]) setActiveId(pipelines[0].id) }, [activeId, pipelines])
  useEffect(() => { if (recording?.pipelineId) setActiveId(recording.pipelineId) }, [recording])

  const createPipeline = async (data: FormData) => {
    try { const result = await post<Pipeline>('/api/pipelines', { name: String(data.get('name')), description: String(data.get('description')) }); setCreateModal(false); setActiveId(result.id); await reload(); notify('Pipeline wurde angelegt.') }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const updatePipeline = async (body: Partial<Pipeline>) => {
    if (!active) return
    try { await patch(`/api/pipelines/${active.id}`, body); await reload() }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const updateStep = (index: number, step: PipelineStep) => { if (!active) return; const steps = [...active.steps]; steps[index] = step; void updatePipeline({ steps }) }
  const moveStep = (index: number, direction: -1 | 1) => { if (!active) return; const next = index + direction; if (next < 0 || next >= active.steps.length) return; const steps = [...active.steps]; [steps[index], steps[next]] = [steps[next], steps[index]]; setSelectedStep(next); void updatePipeline({ steps }) }
  const addStep = (type: 'navigate' | 'waitFor') => { if (!active) return; const step: PipelineStep = type === 'navigate' ? { id: makeId('step'), type, label: 'Seite öffnen', url: { type: 'literal', value: '{{device.baseUrl}}' } } : { id: makeId('step'), type, label: 'Kurz warten', milliseconds: 1000 }; const steps = [...active.steps, step]; setSelectedStep(steps.length - 1); void updatePipeline({ steps }) }
  const startRecording = async (data: FormData) => { try { await post('/api/recordings/start', { pipelineId: active!.id, deviceId: String(data.get('deviceId') || '') || undefined, url: String(data.get('url') || '') || undefined }); setRecordModal(false); notify('Aufnahme läuft im sichtbaren Browserfenster.') } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } }
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
  const startRun = async (data: FormData) => { try { await post('/api/runs', { pipelineId: active!.id, deviceIds: data.getAll('deviceIds').map(String) }); setRunModal(false); notify('Der sichtbare Lauf wurde gestartet.'); openRuns() } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') } }
  const createField = async (data: FormData) => { const field = await post<DataField>('/api/data-fields', { label: String(data.get('label') || ''), type: String(data.get('type') || 'text') }); const selected = active && selectedStep != null ? active.steps[selectedStep] : undefined; if (active && selectedStep != null && selected?.type === 'extractText') { const steps = [...active.steps]; steps[selectedStep] = { ...selected, key: field.key, persist: true }; await patch(`/api/pipelines/${active.id}`, { steps }) } setFieldModal(false); await reload(); notify(`Variable {{data.${field.key}}} wurde angelegt.`) }

  const earlierResults = useMemo(() => active?.steps.flatMap((step, index) => index < (selectedStep ?? active.steps.length) && step.type === 'extractText' ? [step.key] : []) ?? [], [active, selectedStep])

  return <>
    <PageHeader eyebrow="Workflow Builder" title="Pipelines" description="Browserabläufe aufnehmen, Daten zuordnen und sichtbar ausführen." actions={<Button icon={<Plus/>} onClick={() => setCreateModal(true)}>Neue Pipeline</Button>}/>
    <div className="grid min-h-[calc(100vh-145px)] gap-4 md:grid-cols-[190px_minmax(0,1fr)] xl:grid-cols-[230px_minmax(480px,1fr)_260px]">
      <Card className="self-start overflow-hidden shadow-none md:sticky md:top-6 xl:top-8">
        <div className="flex items-center justify-between border-b px-4 py-3"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bibliothek</h2><Badge>{pipelines.length}</Badge></div>
        <div className="p-2">{pipelines.map((pipeline) => <button className={cn('mb-1 flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left hover:bg-muted', pipeline.id === active?.id && 'border-blue-200 bg-blue-50 text-blue-800 shadow-sm hover:bg-blue-100')} key={pipeline.id} onClick={() => { setActiveId(pipeline.id); setSelectedStep(null) }}><Workflow className="size-4 shrink-0"/><span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{pipeline.name}</strong><small className={cn('text-[11px]', pipeline.id === active?.id ? 'text-blue-500' : 'text-muted-foreground')}>{pipeline.steps.length} Schritte · {speedLabel(pipeline.speed)}</small></span></button>)}{!pipelines.length && <Empty compact icon={<Workflow/>} title="Keine Pipeline" text="Lege deinen ersten Ablauf an."/>}</div>
      </Card>

      <Card className="min-w-0 overflow-hidden shadow-none">
        {!active ? <Empty icon={<Workflow/>} title="Dein erster Ablauf" text="Lege eine Pipeline an und starte anschließend die Browseraufnahme." action={<Button onClick={() => setCreateModal(true)}>Pipeline anlegen</Button>}/>
        : <>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b p-4">
            <div><div className="flex items-center gap-2"><h2 className="text-lg font-semibold">{active.name}</h2>{recording?.pipelineId === active.id && <Badge tone={recording.phase === 'replaying' ? 'warning' : 'danger'}>{recording.phase === 'replaying' ? `Schritt ${(recording.replayStep ?? 0) + 1}/${recording.replayTotal}` : '● Aufnahme'}</Badge>}</div><p className="mt-1 text-xs text-muted-foreground">{active.description || 'Keine Beschreibung'}</p></div>
            <div className="flex flex-wrap gap-2">{recording?.pipelineId === active.id ? <><Button variant="secondary" icon={<Eye/>} disabled={recording.mode === 'extract' || recording.phase !== 'recording'} onClick={() => setExtractModal(true)}>Text erfassen</Button><Button variant="danger" icon={<CircleStop/>} onClick={async () => { await post('/api/recordings/stop'); notify('Aufnahme beendet.') }}>Beenden</Button></> : <Button variant="secondary" icon={<Radio/>} onClick={() => setRecordModal(true)}>Aufnehmen</Button>}<Button icon={<Play/>} onClick={() => setRunModal(true)} disabled={!active.steps.length}>Ausführen</Button></div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/25 px-4 py-2.5"><span className="text-xs text-muted-foreground">Tempo</span><Select className="w-40" value={active.speed} onChange={(event) => void updatePipeline({ speed: event.target.value as Pipeline['speed'] })}><option value="slow">Langsam · 950 ms</option><option value="normal">Normal · 500 ms</option><option value="fast">Schnell · 180 ms</option></Select><Separator orientation="vertical" className="mx-1 h-5"/><Button variant="ghost" icon={<Navigation/>} onClick={() => addStep('navigate')}>Navigation</Button><Button variant="ghost" icon={<Hourglass/>} onClick={() => addStep('waitFor')}>Wartezeit</Button></div>
          <div className="min-h-96 space-y-2 p-4">{!active.steps.length ? <Empty icon={<MousePointer2/>} title="Noch keine Schritte" text="Klicke auf „Aufnehmen“ und bediene die Zielseite. Jeder Klick erscheint hier live."/> : active.steps.map((step, index) => { const Icon = stepIcon[step.type]; const selected = selectedStep === index; return <div className={cn('rounded-lg border bg-white transition', selected && 'border-blue-300 ring-3 ring-blue-100')} key={step.id}>
            <div className="flex items-center"><button className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left" onClick={() => setSelectedStep(selected ? null : index)}><GripVertical className="size-4 text-muted-foreground/50"/><span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-xs font-medium">{index + 1}</span><Icon className="size-4 shrink-0 text-blue-700"/><span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{step.label || stepNames[step.type]}</strong><small className="truncate text-xs text-muted-foreground">{stepSummary(step, dataFields)}</small></span><Badge>{stepNames[step.type]}</Badge></button><div className="flex pr-2"><Button variant="ghost" size="icon-sm" aria-label="Nach oben" disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp/></Button><Button variant="ghost" size="icon-sm" aria-label="Nach unten" disabled={index === active.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown/></Button><Button variant="ghost" size="icon-sm" aria-label="Löschen" onClick={() => { setSelectedStep(null); void updatePipeline({ steps: active.steps.filter((_, i) => i !== index) }) }}><Trash2/></Button></div></div>
            {selected && <><StepEditor step={step} dataFields={dataFields} credentials={credentials} earlierResults={earlierResults} onCreateField={() => setFieldModal(true)} onChange={(next) => updateStep(index, next)}/><div className="flex flex-wrap items-center justify-between gap-3 border-t bg-blue-50/60 px-4 py-3"><div><p className="text-sm font-medium text-blue-950">Ab hier manuell weiterbauen</p><p className="text-xs text-blue-700">Schritte 1–{index + 1} sichtbar abspielen, danach deine Klicks direkt hier einfügen.</p></div><Button variant="secondary" icon={<ListPlus/>} disabled={Boolean(recording)} onClick={() => setContinueAfterStep(index)}>Bis hier ausführen & weiter aufnehmen</Button></div></>}
          </div>})}</div>
          <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground"><span>Änderungen werden automatisch gespeichert.</span><Button variant="ghost" icon={<Trash2/>} onClick={async () => { if (!confirm('Pipeline wirklich löschen?')) return; await remove(`/api/pipelines/${active.id}`); setActiveId(null); await reload() }}>Pipeline löschen</Button></div>
        </>}
      </Card>

      <Card className="self-start overflow-hidden shadow-none md:col-span-2 xl:sticky xl:top-8 xl:col-span-1">
        <div className="border-b px-4 py-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><Braces className="size-4"/>Variablen</h2><p className="mt-1 text-xs text-muted-foreground">Werte zwischen Schritten weiterreichen.</p></div>
        <div className="space-y-5 p-4"><VariableGroup title="Gerät" items={[['Start-URL', '{{device.baseUrl}}'], ['Gerätename', '{{device.name}}']]}/><VariableGroup title="Datentabelle" items={dataFields.map((field) => [field.label, `{{data.${field.key}}}`])}/>{earlierResults.length > 0 && <VariableGroup title="Laufergebnisse" items={earlierResults.map((key) => [key, `{{result.${key}}}`])}/>}<Button className="w-full" variant="secondary" icon={<Plus/>} onClick={() => setFieldModal(true)}>Neue Datenvariable</Button></div>
      </Card>
    </div>

    {createModal && <Modal title="Neue Pipeline" description="Schritte kannst du anschließend aufnehmen oder manuell ergänzen." onClose={() => setCreateModal(false)}><form onSubmit={submitForm(createPipeline)}><div className="grid gap-5 px-6 py-5"><Field label="Name"><Input name="name" placeholder="z. B. Zertifikat erneuern" required autoFocus/></Field><Field label="Beschreibung"><Input name="description" placeholder="Optional"/></Field></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setCreateModal(false)} submit="Pipeline anlegen"/></div></form></Modal>}
    {fieldModal && <Modal title="Neue Datenvariable" description="Dafür wird eine neue Spalte in der Datentabelle angelegt." onClose={() => setFieldModal(false)}><form onSubmit={submitForm(createField)}><div className="grid gap-5 px-6 py-5"><Field label="Bezeichnung"><Input name="label" placeholder="z. B. Seriennummer" required autoFocus/></Field><Field label="Datentyp"><Select name="type"><option value="text">Text</option><option value="number">Zahl</option><option value="date">Datum</option><option value="url">URL</option></Select></Field></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setFieldModal(false)} submit="Variable anlegen"/></div></form></Modal>}
    {recordModal && active && <Modal title="Aufnahme starten" description="Ein sichtbares Chromium-Fenster öffnet sich und übernimmt deine Aktionen live." onClose={() => setRecordModal(false)}><form onSubmit={submitForm(startRecording)}><div className="grid gap-5 px-6 py-5"><Notice title="Sichtbare Aufnahme">Bediene die Webseite normal. Über „Text erfassen“ ordnest du Inhalte anschließend einer Tabellenspalte zu.</Notice><Field label="Gerät"><Select name="deviceId" defaultValue={devices[0]?.id || ''}><option value="">Start-URL selbst eingeben</option>{devices.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</Select></Field><Field label="Alternative Start-URL" hint="Bleibt leer, wenn ein Gerät ausgewählt ist."><Input name="url" type="url" placeholder={`${location.origin}/fixture/firewall`}/></Field></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setRecordModal(false)} submit="Browser öffnen"/></div></form></Modal>}
    {extractModal && <Modal title="Text in die Tabelle übernehmen" description="Wähle zuerst, in welche Spalte der angeklickte Text geschrieben werden soll." onClose={() => setExtractModal(false)}><form onSubmit={submitForm(startExtract)}><div className="grid gap-5 px-6 py-5"><Notice title="Wert und Variable gemeinsam erfassen">Nach der Auswahl klickst du den Text im sichtbaren Browser an. Der aktuelle Wert erscheint sofort beim aufgenommenen Gerät in der Tabelle.</Notice>{dataFields.length ? <Field label="Zielspalte"><Select name="key" defaultValue={dataFields.find((field) => field.key === 'seriennummer')?.key || dataFields[0]?.key} required>{dataFields.map((field) => <option value={field.key} key={field.id}>{field.label} · {`{{data.${field.key}}}`}</option>)}</Select></Field> : <Notice tone="warning" title="Noch keine Tabellenspalte">Lege zuerst eine Datenvariable an.</Notice>}</div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setExtractModal(false)} submit="Text im Browser auswählen"/></div></form></Modal>}
    {continueAfterStep != null && active && <Modal title={`Nach Schritt ${continueAfterStep + 1} weiter aufnehmen`} description="Die Pipeline bringt den Browser zuerst automatisch an die richtige Stelle." onClose={() => setContinueAfterStep(null)}><form onSubmit={submitForm(continueRecording)}><div className="grid gap-5 px-6 py-5"><Notice title="Automatisch bis zum Übergabepunkt">Du siehst jeden bisherigen Schritt im Browser. Danach stoppt die Automatik, das Fenster bleibt offen und alle deine folgenden Aktionen werden direkt nach Schritt {continueAfterStep + 1} eingefügt.</Notice><Field label="Gerät" hint="Variablen und Zugangsdaten werden von diesem Gerät verwendet."><Select name="deviceId" defaultValue={devices[0]?.id || ''} required><option value="" disabled>Gerät auswählen …</option>{devices.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</Select></Field>{!devices.length && <p className="text-sm text-destructive">Lege zuerst ein Gerät an.</p>}</div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setContinueAfterStep(null)} submit={`Bis Schritt ${continueAfterStep + 1} ausführen`}/></div></form></Modal>}
    {runModal && active && <Modal title="Pipeline sichtbar ausführen" description="Die Geräte werden nacheinander verarbeitet; jeder Klick bleibt nachvollziehbar." onClose={() => setRunModal(false)}><form onSubmit={submitForm(startRun)}><div className="px-6 py-5"><Notice tone="success" title="Live im Browser">Ziele werden markiert, Klicks animiert und der aktuelle Schritt eingeblendet.</Notice><div className="mt-4 max-h-72 space-y-2 overflow-auto">{devices.map((device) => <label key={device.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-muted"><input type="checkbox" name="deviceIds" value={device.id} className="size-4 accent-zinc-900"/><span className="grid"><strong className="text-sm font-medium">{device.name}</strong><small className="text-xs text-muted-foreground">{device.baseUrl}</small></span></label>)}{!devices.length && <p className="text-sm text-muted-foreground">Lege zuerst ein Gerät an.</p>}</div></div><div className="border-t bg-muted/20 px-6 py-4"><FormActions onCancel={() => setRunModal(false)} submit="Sichtbaren Lauf starten"/></div></form></Modal>}
  </>
}

function VariableGroup({ title, items }: { title: string; items: string[][] }) {
  return <div><p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p><div className="space-y-1">{items.length ? items.map(([label, value]) => <button key={value} className="group block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted" title="In Zwischenablage kopieren" onClick={() => void navigator.clipboard.writeText(value)}><span className="block truncate text-xs font-medium">{label}</span><code className="block truncate font-mono text-[10px] text-muted-foreground group-hover:text-foreground">{value}</code></button>) : <p className="px-2 text-xs text-muted-foreground">Noch keine Felder</p>}</div></div>
}

function StepEditor({ step, dataFields, credentials, earlierResults, onCreateField, onChange }: { step: PipelineStep; dataFields: DataField[]; credentials: Credential[]; earlierResults: string[]; onCreateField: () => void; onChange: (step: PipelineStep) => void }) {
  return <div className="grid gap-4 border-t bg-muted/20 p-4 md:grid-cols-2">
    <Field label="Bezeichnung"><Input value={step.label ?? ''} onChange={(event) => onChange({ ...step, label: event.target.value })}/></Field>
    {'value' in step && <ValueEditor value={step.value} dataFields={dataFields} credentials={credentials} earlierResults={earlierResults} onChange={(value) => onChange({ ...step, value })}/>}
    {step.type === 'navigate' && <ValueEditor value={step.url} label="URL-Quelle" dataFields={dataFields} credentials={credentials} earlierResults={earlierResults} onChange={(url) => onChange({ ...step, url })}/>}
    {step.type === 'extractText' && <><Field label="Ziel in der Datentabelle" hint="Der gelesene Text wird für das aktuelle Gerät in diese Spalte geschrieben."><Select value={step.key} onChange={(event) => onChange({ ...step, key: event.target.value, persist: true })}>{!dataFields.some((field) => field.key === step.key) && <option value={step.key}>{step.key} (aufgenommen)</option>}{dataFields.map((field) => <option value={field.key} key={field.id}>{field.label}</option>)}</Select></Field><div className="flex items-end"><Button variant="secondary" icon={<Database/>} onClick={onCreateField}>Neue Tabellenspalte</Button></div></>}
    {step.type === 'download' && <Field label="Artefakt-Schlüssel"><Input value={step.artifactKey} onChange={(event) => onChange({ ...step, artifactKey: event.target.value })}/></Field>}
    {step.type === 'upload' && <FileEditor file={step.file} onChange={(file) => onChange({ ...step, file })}/>}
    {step.type === 'waitFor' && !step.locator && <Field label="Wartezeit in Millisekunden"><Input type="number" min="0" value={step.milliseconds ?? 1000} onChange={(event) => onChange({ ...step, milliseconds: Number(event.target.value) })}/></Field>}
    {'locator' in step && step.locator && <Field label="Aufgenommenes Ziel"><Input value={step.locator.description || step.locator.candidates[0]?.value || ''} readOnly/></Field>}
    <Field label="Zeitlimit in Millisekunden" hint="Leer = Standardwert"><Input type="number" min="100" value={step.timeoutMs ?? ''} onChange={(event) => onChange({ ...step, timeoutMs: event.target.value ? Number(event.target.value) : undefined })}/></Field>
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

function FileEditor({ file, onChange }: { file: FileSource; onChange: (file: FileSource) => void }) {
  return <><Field label="Dateiquelle"><Select value={file.type} onChange={(event) => onChange(event.target.value === 'retainedArtifact' ? { type: 'retainedArtifact', key: '' } : { type: 'localFile', path: '' })}><option value="retainedArtifact">Vorheriger Download</option><option value="localFile">Lokale Datei</option></Select></Field>{file.type === 'retainedArtifact' ? <Field label="Artefakt-Schlüssel"><Input value={file.key} onChange={(event) => onChange({ ...file, key: event.target.value })}/></Field> : <Field label="Lokaler Dateipfad"><Input value={file.path} placeholder="/Users/.../datei.txt" onChange={(event) => onChange({ ...file, path: event.target.value })}/></Field>}</>
}

function stepSummary(step: PipelineStep, fields: DataField[]) {
  switch (step.type) {
    case 'navigate': return sourceSummary(step.url, fields)
    case 'fill': case 'select': return sourceSummary(step.value, fields)
    case 'extractText': return `→ ${fields.find((field) => field.key === step.key)?.label ?? step.key}`
    case 'download': return `Artefakt: ${step.artifactKey}`
    case 'upload': return step.file.type === 'retainedArtifact' ? `Download: ${step.file.key || 'noch wählen'}` : step.file.path || 'Datei noch wählen'
    case 'waitFor': return step.locator ? `Warten auf ${step.locator.description || 'Element'}` : `${step.milliseconds ?? 1000} ms`
    case 'press': return `Taste ${step.key}`
    case 'toggle': return step.checked ? 'Aktivieren' : 'Deaktivieren'
    default: return 'locator' in step ? step.locator.description || step.locator.candidates[0]?.value || 'Aufgenommenes Element' : ''
  }
}
function sourceSummary(source: ValueSource, fields: DataField[]) { if (source.type === 'literal') return source.value || 'Fester Wert ist leer'; if (source.type === 'deviceField') return fields.find((field) => field.key === source.key)?.label ?? source.key; if (source.type === 'runValue') return `Ergebnis: ${source.key}`; return `Zugangsdaten: ${source.field === 'username' ? 'Benutzername' : 'Passwort'}` }
function speedLabel(speed: Pipeline['speed']) { return speed === 'slow' ? 'Langsam' : speed === 'fast' ? 'Schnell' : 'Normal' }
