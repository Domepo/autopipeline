import { useRef, useState } from 'react'
import { Download, Plus, Trash2, Upload } from 'lucide-react'
import type { Credential, DataField, DataFieldType, Device } from '@autosecure/shared'
import { api, patch, post, remove } from './api.ts'
import { SpreadsheetGrid } from './SpreadsheetGrid.tsx'
import { Button, Field, FormActions, Input, Modal, PageHeader, Select, submitForm } from './components.tsx'

type Props = { devices: Device[]; dataFields: DataField[]; credentials: Credential[]; reload: () => Promise<void>; notify: (message: string, tone?: 'success' | 'error') => void; onDevicesSaved: (devices: Device[]) => void }

export function DataPage({ devices, dataFields, credentials, reload, notify, onDevicesSaved }: Props) {
  const [fieldModal, setFieldModal] = useState<DataField | 'new' | null>(null)
  const [gridVersion, setGridVersion] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const saveField = async (data: FormData) => {
    const body = { label: String(data.get('label') || '').trim(), type: String(data.get('type') || 'text') as DataFieldType }
    if (!body.label) return
    if (fieldModal === 'new') await post('/api/data-fields', body)
    else if (fieldModal) await patch(`/api/data-fields/${fieldModal.id}`, body)
    const created = fieldModal === 'new'
    setFieldModal(null); await reload(); notify(created ? 'Datenspalte wurde angelegt.' : 'Datenspalte wurde aktualisiert.')
  }

  const deleteField = async (field: DataField) => {
    if (!confirm(`Spalte „${field.label}“ und alle darin gespeicherten Werte löschen?`)) return
    await remove(`/api/data-fields/${field.id}`); setFieldModal(null); await reload(); notify('Datenspalte wurde gelöscht.')
  }

  const importFile = async (file?: File) => {
    if (!file) return
    const body = new FormData(); body.append('file', file)
    try {
      const result = await api<{ created: number; updated: number }>('/api/data/import.xlsx', { method: 'POST', body })
      await reload(); setGridVersion((version) => version + 1); notify(`${result.created} Geräte importiert, ${result.updated} aktualisiert.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    if (fileRef.current) fileRef.current.value = ''
  }

  return <>
    <PageHeader eyebrow="Variablen-Speicher" title="Datentabelle" description="Wie in Excel: Werte direkt in Zellen bearbeiten, mehrere Zellen einfügen und Spalten als Pipeline-Variablen verwenden." actions={<>
      <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(event) => void importFile(event.target.files?.[0])}/>
      <Button variant="secondary" icon={<Upload/>} onClick={() => fileRef.current?.click()}>XLSX importieren</Button>
      <Button variant="secondary" icon={<Download/>} onClick={() => { location.href = '/api/data/export.xlsx' }}>XLSX exportieren</Button>
      <Button icon={<Plus/>} onClick={() => setFieldModal('new')}>Neue Spalte</Button>
    </>}/>

    <SpreadsheetGrid key={gridVersion} devices={devices} dataFields={dataFields} credentials={credentials} notify={notify} onDevicesSaved={onDevicesSaved} onAddField={() => setFieldModal('new')} onEditField={setFieldModal}/>

    {fieldModal && <Modal title={fieldModal === 'new' ? 'Datenspalte hinzufügen' : 'Datenspalte bearbeiten'} description="Jede Spalte ist gleichzeitig ein auswählbares Gerätefeld für deine Pipelines." onClose={() => setFieldModal(null)}><form onSubmit={submitForm(saveField)}><div className="grid gap-5 px-6 py-5"><Field label="Spaltenname"><Input name="label" defaultValue={fieldModal === 'new' ? '' : fieldModal.label} placeholder="z. B. Seriennummer" required autoFocus/></Field><Field label="Datentyp"><Select name="type" defaultValue={fieldModal === 'new' ? 'text' : fieldModal.type}><option value="text">Text</option><option value="number">Zahl</option><option value="date">Datum</option><option value="url">URL</option></Select></Field>{fieldModal !== 'new' && <Field label="Pipeline-Variable" hint="Der technische Schlüssel bleibt stabil, wenn der Spaltenname geändert wird."><div className="rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs">{`{{data.${fieldModal.key}}}`}</div></Field>}</div><div className="flex items-center border-t bg-muted/20 px-6 py-4">{fieldModal !== 'new' && <Button type="button" variant="danger" icon={<Trash2/>} onClick={() => void deleteField(fieldModal)}>Spalte löschen</Button>}<FormActions onCancel={() => setFieldModal(null)} submit={fieldModal === 'new' ? 'Spalte anlegen' : 'Speichern'}/></div></form></Modal>}
  </>
}
