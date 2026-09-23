import { useRef, useState } from 'react'
import { Copy, Download, ExternalLink, FileDown, MoreHorizontal, Plus, Trash2, Upload } from 'lucide-react'
import type { Artifact, Credential, DataField, DataFieldType, Device, WorkbookImportPreview } from '@autosecure/shared'
import { DropdownMenu } from 'radix-ui'
import { Button as LinkButton } from '@/components/ui/button'
import { api, patch, post, remove } from './api.ts'
import { SpreadsheetGrid } from './SpreadsheetGrid.tsx'
import { Button, ConfirmButton, Field, FormActions, Input, Modal, Notice, PageHeader, Select, submitForm } from './components.tsx'

type Props = { devices: Device[]; dataFields: DataField[]; credentials: Credential[]; artifacts: Artifact[]; reload: () => Promise<void>; notify: (message: string, tone?: 'success' | 'error') => void; onDevicesSaved: (devices: Device[]) => void; expanded?: boolean }

export function DataPage({ devices, dataFields, credentials, artifacts, reload, notify, onDevicesSaved, expanded = false }: Props) {
  const [fieldModal, setFieldModal] = useState<DataField | 'new' | null>(null)
  const [filesDeviceId, setFilesDeviceId] = useState<string | null>(null)
  const [credentialDeviceId, setCredentialDeviceId] = useState<string | null>(null)
  const [gridVersion, setGridVersion] = useState(0)
  const [importPreview, setImportPreview] = useState<{ file: File; preview: WorkbookImportPreview } | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const filesDevice = filesDeviceId ? devices.find((device) => device.id === filesDeviceId) : undefined
  const credentialDevice = credentialDeviceId ? devices.find((device) => device.id === credentialDeviceId) : undefined
  const deviceFiles = filesDeviceId ? artifacts.filter((artifact) => artifact.deviceId === filesDeviceId) : []

  const saveField = async (data: FormData) => {
    const body = { label: String(data.get('label') || '').trim(), type: String(data.get('type') || 'text') as DataFieldType }
    if (!body.label) return
    if (fieldModal === 'new') await post('/api/data-fields', body)
    else if (fieldModal) await patch(`/api/data-fields/${fieldModal.id}`, body)
    const created = fieldModal === 'new'
    setFieldModal(null); await reload(); notify(created ? 'Datenspalte wurde angelegt.' : 'Datenspalte wurde aktualisiert.')
  }

  const deleteField = async (field: DataField) => {
    await remove(`/api/data-fields/${field.id}`); setFieldModal(null); await reload(); notify('Datenspalte wurde gelöscht.')
  }

  const previewImport = async (file?: File) => {
    if (!file) return
    const body = new FormData(); body.append('file', file)
    try {
      setImportBusy(true)
      const preview = await api<WorkbookImportPreview>('/api/data/import-preview.xlsx', { method: 'POST', body })
      setImportPreview({ file, preview })
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setImportBusy(false) }
    if (fileRef.current) fileRef.current.value = ''
  }
  const applyImport = async () => {
    if (!importPreview || importBusy) return
    const body = new FormData(); body.append('file', importPreview.file)
    setImportBusy(true)
    try {
      const result = await api<{ created: number; updated: number }>('/api/data/import.xlsx', { method: 'POST', body })
      await reload(); setGridVersion((version) => version + 1); setImportPreview(null)
      notify(`${result.created} Geräte importiert, ${result.updated} aktualisiert.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setImportBusy(false) }
  }

  return <div className={expanded ? 'relative flex h-full w-full min-h-0 flex-col' : undefined}>
    <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(event) => void previewImport(event.target.files?.[0])}/>
    {!expanded && <PageHeader eyebrow="Gemeinsamer Gerätespeicher" title="Daten" description="Jede Zeile gehört zu einem Gerät. Automationen lesen und schreiben diese Werte wie Variablen." actions={<>
      <LinkButton variant="secondary" asChild><a href="/?view=data" target="_blank" rel="noopener noreferrer"><ExternalLink/>In neuem Tab öffnen</a></LinkButton>
      <Button variant="secondary" icon={<Upload/>} onClick={() => fileRef.current?.click()}>XLSX importieren</Button>
      <Button variant="secondary" icon={<Download/>} onClick={() => { location.href = '/api/data/export.xlsx' }}>XLSX exportieren</Button>
      <Button icon={<Plus/>} onClick={() => setFieldModal('new')}>Neue Spalte</Button>
    </>}/>}

    <SpreadsheetGrid key={gridVersion} expanded={expanded} devices={devices} dataFields={dataFields} credentials={credentials} artifacts={artifacts} notify={notify} onDevicesSaved={onDevicesSaved} onAddField={() => setFieldModal('new')} onEditField={setFieldModal} onViewFiles={setFilesDeviceId} onEditCredentials={setCredentialDeviceId} toolbarActions={expanded ? <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><Button variant="secondary" size="icon" aria-label="Tabellenaktionen öffnen" title="Tabellenaktionen"><MoreHorizontal/></Button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={8} className="z-50 min-w-52 rounded-xl border bg-white p-1.5 shadow-lg outline-none">
        <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none focus:bg-blue-50" onSelect={() => fileRef.current?.click()}><Upload className="size-4"/>XLSX importieren</DropdownMenu.Item>
        <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none focus:bg-blue-50" onSelect={() => { location.href = '/api/data/export.xlsx' }}><Download className="size-4"/>XLSX exportieren</DropdownMenu.Item>
        <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none focus:bg-blue-50" onSelect={() => setFieldModal('new')}><Plus className="size-4"/>Neue Spalte</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root> : undefined}/>

    {credentialDevice && <CredentialAssignmentModal key={credentialDevice.id} device={credentialDevice} credentials={credentials} reload={reload} notify={notify} onDevicesSaved={onDevicesSaved} onClose={() => setCredentialDeviceId(null)}/>}

    {importPreview && <Modal title="XLSX-Import prüfen" description={importPreview.file.name} onClose={() => { if (!importBusy) setImportPreview(null) }} wide>
      <div className="grid gap-4 px-6 py-5">
        <Notice tone="info" title={`${importPreview.preview.created} neu · ${importPreview.preview.updated} werden aktualisiert`}>Bestehende Geräte werden über ihren Namen erkannt. Angezeigte Felder werden übernommen; andere Daten bleiben erhalten.</Notice>
        {importPreview.preview.warnings.length > 0 && <Notice tone="warning" title="Hinweise">{importPreview.preview.warnings.map((warning) => <span className="block" key={warning}>{warning}</span>)}</Notice>}
        <div className="max-h-72 overflow-auto rounded-lg border">{importPreview.preview.rows.map((row, index) => <div key={`${row.name}-${index}`} className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5 text-sm last:border-b-0"><span className="font-medium">{row.name}</span><span className="text-xs text-muted-foreground">{row.action === 'create' ? 'Neu' : 'Aktualisieren'}{row.changes.length ? ` · ${row.changes.join(', ')}` : ''}</span></div>)}</div>
        <p className="text-xs text-muted-foreground">Die XLSX-Datei enthält keine Passwörter und ist kein vollständiges Backup.</p>
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/20 px-6 py-4"><Button type="button" variant="ghost" disabled={importBusy} onClick={() => setImportPreview(null)}>Abbrechen</Button><Button type="button" disabled={importBusy} onClick={() => void applyImport()}>{importBusy ? 'Wird importiert …' : 'Importieren'}</Button></div>
    </Modal>}

    {filesDevice && <Modal wide title={`Dateien · ${filesDevice.name}`} description="Downloads und Merge-Ergebnisse dieses Geräts. Die aktuelle Datei jeder Variable steht direkt in der Tabelle." onClose={() => setFilesDeviceId(null)}><div className="max-h-[65vh] space-y-2 overflow-auto p-5">{deviceFiles.length ? deviceFiles.map((artifact) => <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-background p-3" key={artifact.id}><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-700"><FileDown className="size-4"/></span><span className="grid min-w-0 flex-1"><strong className="truncate text-sm font-medium">{artifactName(artifact)}</strong><small className="truncate text-xs text-muted-foreground">{artifact.runName || 'Lauf'} · {formatDate(artifact.createdAt)} · {formatBytes(artifact.size)}</small><code className="mt-1 truncate font-mono text-[10px] text-blue-700">{artifact.artifactKey || 'Keine Dateivariable'}</code></span>{artifact.artifactKey && <Button variant="secondary" size="sm" icon={<Copy/>} onClick={() => void navigator.clipboard.writeText(artifact.artifactKey!).then(() => notify(`Dateivariable „${artifact.artifactKey}“ kopiert.`))}>Variable</Button>}<a className="inline-flex h-8 items-center gap-2 rounded-md border bg-white px-3 text-xs font-medium hover:bg-muted" href={artifact.downloadUrl} download><Download className="size-3.5"/>Herunterladen</a></div>) : <p className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">Für dieses Gerät wurden noch keine Dateien heruntergeladen.</p>}</div></Modal>}

    {fieldModal && <Modal title={fieldModal === 'new' ? 'Datenspalte hinzufügen' : 'Datenspalte bearbeiten'} description="Jede Spalte ist gleichzeitig ein auswählbares Gerätefeld für deine Automationen." onClose={() => setFieldModal(null)}><form onSubmit={submitForm(saveField)}><div className="grid gap-5 px-6 py-5"><Field label="Spaltenname"><Input name="label" defaultValue={fieldModal === 'new' ? '' : fieldModal.label} placeholder="z. B. Seriennummer" required autoFocus/></Field><Field label="Datentyp"><Select name="type" defaultValue={fieldModal === 'new' ? 'text' : fieldModal.type}><option value="text">Text</option><option value="number">Zahl</option><option value="date">Datum</option><option value="url">URL</option><option value="file">Datei</option></Select></Field>{fieldModal !== 'new' && <Field label="Automationsvariable" hint="Der technische Schlüssel bleibt stabil, wenn der Spaltenname geändert wird."><div className="rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs">{`{{data.${fieldModal.key}}}`}</div></Field>}</div><div className="flex items-center border-t bg-muted/20 px-6 py-4">{fieldModal !== 'new' && <ConfirmButton icon={<Trash2/>} title="Spalte löschen" description={`Die Spalte „${fieldModal.label}“ und alle darin gespeicherten Werte werden gelöscht.`} onConfirm={() => deleteField(fieldModal)}>Spalte löschen</ConfirmButton>}<FormActions onCancel={() => setFieldModal(null)} submit={fieldModal === 'new' ? 'Spalte anlegen' : 'Speichern'}/></div></form></Modal>}
  </div>
}

function CredentialAssignmentModal({ device, credentials, reload, notify, onDevicesSaved, onClose }: {
  device: Device
  credentials: Credential[]
  reload: () => Promise<void>
  notify: Props['notify']
  onDevicesSaved: Props['onDevicesSaved']
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState(device.credentialId ?? 'manual')
  const [saving, setSaving] = useState(false)
  const selected = credentials.find((credential) => credential.id === selectedId)

  const assign = async (credentialId: string | null) => {
    if (saving) return
    setSaving(true)
    try {
      const saved = await patch<Device>(`/api/devices/${device.id}`, { credentialId })
      onDevicesSaved([saved])
      await reload()
      notify(credentialId ? 'Zugangsdatenprofil wurde dem Gerät zugewiesen.' : 'Zugangsdatenprofil wurde vom Gerät entfernt.')
      onClose()
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setSaving(false) }
  }

  const saveProfile = async (data: FormData) => {
    if (saving) return
    setSaving(true)
    try {
      if (selectedId === 'manual') {
        const result = await post<{ device: Device; credential: Credential }>(`/api/devices/${device.id}/credentials`, {
          username: String(data.get('username') || ''), password: String(data.get('password') || ''),
        })
        onDevicesSaved([result.device])
        await reload()
        notify('Benutzername und Passwort wurden gespeichert und diesem Gerät zugewiesen.')
        onClose()
        return
      }
      const body = { name: String(data.get('name') || '').trim(), username: String(data.get('username') || '').trim(), password: String(data.get('password') || '') }
      const saved = selected
        ? await patch<Credential>(`/api/credentials/${selected.id}`, { ...body, password: body.password || undefined })
        : await post<Credential>('/api/credentials', body)
      if (device.credentialId !== saved.id) {
        const updated = await patch<Device>(`/api/devices/${device.id}`, { credentialId: saved.id })
        onDevicesSaved([updated])
      }
      await reload()
      notify(selected ? 'Zugangsdatenprofil wurde gespeichert und zugewiesen.' : 'Neues Zugangsdatenprofil wurde erstellt und zugewiesen.')
      onClose()
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setSaving(false) }
  }

  return <Modal title={`Zugangsdaten · ${device.name}`} description="Profil auswählen oder Benutzername und Passwort direkt eingeben." onClose={onClose}>
    <div className="grid gap-5 px-6 py-5">
      <Field label="Zugangsdatenprofil"><Select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={saving} autoFocus>
        <option value="">Keine Zuordnung</option>
        {credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name}</option>)}
        <option value="manual">Benutzername und Passwort eingeben</option>
        <option value="new">Neues Profil anlegen …</option>
      </Select></Field>
      {selectedId === '' ? <div className="grid gap-3"><p className="text-sm text-muted-foreground">Für dieses Gerät werden keine gespeicherten Zugangsdaten verwendet.</p><Button type="button" variant="secondary" onClick={() => setSelectedId('manual')}>Benutzername und Passwort eingeben</Button></div> : <form key={selectedId} id="credential-profile-form" className="grid gap-4" onSubmit={submitForm(saveProfile)}>
        {selectedId === 'manual' && <Notice tone="info" title="Direkt für dieses Gerät">Gib die Zugangsdaten ein. Die App legt automatisch ein Profil an und weist es diesem Gerät zu.</Notice>}
        {selected && <p className="text-xs text-muted-foreground">Änderungen an diesem Profil gelten auch für andere Geräte, die es verwenden.</p>}
        {selectedId !== 'manual' && <Field label="Bezeichnung"><Input name="name" defaultValue={selected?.name ?? ''} placeholder="z. B. Firewall Admin" required disabled={saving}/></Field>}
        <Field label="Benutzername"><Input name="username" defaultValue={selected?.username ?? ''} autoComplete="off" required={selectedId === 'manual'} disabled={saving}/></Field>
        <Field label="Passwort" hint={selected ? 'Leer lassen, um das bestehende Passwort beizubehalten.' : undefined}><Input name="password" type="password" autoComplete="new-password" required={selectedId === 'manual'} disabled={saving}/></Field>
      </form>}
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-muted/20 px-6 py-4">
      <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Abbrechen</Button>
      {selectedId !== 'new' && selectedId !== 'manual' && device.credentialId !== (selectedId || undefined) && <Button type="button" variant="secondary" onClick={() => void assign(selectedId || null)} disabled={saving}>{selectedId ? 'Nur zuweisen' : 'Zuordnung entfernen'}</Button>}
      {selectedId !== '' && <Button type="submit" form="credential-profile-form" disabled={saving}>{saving ? 'Speichert …' : selectedId === 'manual' ? 'Zugangsdaten speichern' : selected ? 'Profil speichern und zuweisen' : 'Profil erstellen und zuweisen'}</Button>}
    </div>
  </Modal>
}

function artifactName(artifact: Artifact) {
  const prefix = artifact.artifactKey ? `${artifact.artifactKey}__` : ''
  return prefix && artifact.name.startsWith(prefix) ? artifact.name.slice(prefix.length) : artifact.name
}

function formatDate(value: string) { return new Date(value).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
