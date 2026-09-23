import { useState } from 'react'
import { LockKeyhole, Trash2 } from 'lucide-react'
import type { Credential, Device } from '@autosecure/shared'
import { cn } from '@/lib/utils'
import { patch, post, remove } from './api.ts'
import { Button, ConfirmButton, Field, FormActions, Input, Modal, Notice, Select, submitForm } from './components.tsx'

export type InventoryAction = { kind: 'new'; deviceId?: never } | { kind: 'edit'; deviceId: string } | { kind: 'credentials'; deviceId?: string }

type Props = {
  action: InventoryAction
  devices: Device[]
  credentials: Credential[]
  reload: () => Promise<void>
  notify: (message: string, tone?: 'success' | 'error') => void
  onClose: () => void
}

export function InventoryDialogs({ action, devices, credentials, reload, notify, onClose }: Props) {
  const targetDevice = devices.find((device) => device.id === action.deviceId)
  const [deviceModal, setDeviceModal] = useState<Device | 'new' | null>(action.kind === 'new' ? 'new' : action.kind === 'edit' ? targetDevice ?? null : null)
  const [credentialModal, setCredentialModal] = useState(action.kind === 'credentials')
  const [editCredential, setEditCredential] = useState<Credential | null>(() => action.kind === 'credentials' ? credentials.find((item) => item.id === targetDevice?.credentialId) ?? null : null)
  const [credentialDeviceId, setCredentialDeviceId] = useState<string | null>(action.kind === 'credentials' ? action.deviceId ?? null : null)
  const credentialDevice = devices.find((device) => device.id === credentialDeviceId)

  const openCredentials = (device: Device) => {
    setDeviceModal(null)
    setCredentialDeviceId(device.id)
    setEditCredential(credentials.find((item) => item.id === device.credentialId) ?? null)
    setCredentialModal(true)
  }
  const closeCredentials = () => { setCredentialModal(false); setEditCredential(null); setCredentialDeviceId(null); onClose() }
  const assignCredential = async (credential: Credential) => {
    if (!credentialDeviceId) return
    try {
      await patch(`/api/devices/${credentialDeviceId}`, { credentialId: credential.id })
      await reload()
      notify(`„${credential.name}“ wurde dem Gerät zugewiesen.`)
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const saveDevice = async (data: FormData) => {
    const body = { name: String(data.get('name') || ''), baseUrl: String(data.get('baseUrl') || ''), credentialId: String(data.get('credentialId') || '') || null, ignoreHttpsErrors: data.get('ignoreHttpsErrors') === 'on' }
    try {
      if (deviceModal !== 'new' && deviceModal) await patch(`/api/devices/${deviceModal.id}`, body)
      else await post('/api/devices', body)
      await reload()
      notify('Gerät wurde gespeichert.')
      onClose()
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }
  const saveCredential = async (data: FormData) => {
    const body = { name: String(data.get('name') || ''), username: String(data.get('username') || ''), password: String(data.get('password') || '') }
    try {
      const saved = editCredential
        ? await patch<Credential>(`/api/credentials/${editCredential.id}`, { ...body, password: body.password || undefined })
        : await post<Credential>('/api/credentials', body)
      if (!editCredential && credentialDeviceId) await patch(`/api/devices/${credentialDeviceId}`, { credentialId: saved.id })
      await reload()
      setEditCredential(saved)
      notify(!editCredential && credentialDeviceId ? 'Zugangsdatenprofil wurde erstellt und dem Gerät zugewiesen.' : 'Zugangsdatenprofil wurde gespeichert.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
  }

  return <>
    {deviceModal && <Modal title={deviceModal === 'new' ? 'Gerät hinzufügen' : 'Gerät bearbeiten'} description="Diese URL wird bei Aufnahme und Ausführung als Startpunkt verwendet." onClose={onClose}><form onSubmit={submitForm(saveDevice)}><div className="grid gap-5 px-6 py-5"><Field label="Name"><Input name="name" defaultValue={deviceModal === 'new' ? '' : deviceModal.name} placeholder="z. B. Firewall Berlin" required autoFocus/></Field><Field label="Start-URL"><Input name="baseUrl" type="url" defaultValue={deviceModal === 'new' ? '' : deviceModal.baseUrl} placeholder="https://192.168.1.1" required/></Field><Field label="Zugangsdatenprofil"><div className="flex items-center gap-2"><Select name="credentialId" defaultValue={deviceModal === 'new' ? '' : deviceModal.credentialId || ''}><option value="">Keine Zuordnung</option>{credentials.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</Select>{deviceModal !== 'new' && <Button type="button" variant="secondary" className="shrink-0" onClick={() => openCredentials(deviceModal)}>{deviceModal.credentialId ? 'Profil öffnen' : 'Neu anlegen'}</Button>}</div></Field><label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"><input name="ignoreHttpsErrors" type="checkbox" className="mt-0.5 size-4 accent-zinc-900" defaultChecked={deviceModal !== 'new' && deviceModal.ignoreHttpsErrors}/><span><strong className="block text-sm font-medium">Selbstsigniertes Zertifikat zulassen</strong><small className="text-xs text-muted-foreground">Nur für vertrauenswürdige interne Geräte aktivieren.</small></span></label></div><div className="flex border-t bg-muted/20 px-6 py-4">{deviceModal !== 'new' && <ConfirmButton title="Gerät löschen" description={`„${deviceModal.name}“ und alle zugehörigen Gerätewerte werden gelöscht.`} onConfirm={async () => { await remove(`/api/devices/${deviceModal.id}`); await reload(); notify('Gerät wurde gelöscht.'); onClose() }}>Gerät löschen</ConfirmButton>}<FormActions onCancel={onClose}/></div></form></Modal>}

    {credentialModal && <Modal title="Zugangsdaten" description={credentialDevice ? `Zugangsprofil für „${credentialDevice.name}“ verwalten.` : 'Wiederverwendbare Profile für Geräte und Webseiten.'} onClose={closeCredentials} wide><div className="grid md:grid-cols-[1.1fr_.9fr]"><div className="border-b p-5 md:border-r md:border-b-0"><Notice tone="warning" title="Lokale Klartextspeicherung">Passwörter werden wie festgelegt unverschlüsselt in der lokalen SQLite-Datei gespeichert.</Notice><div className="mt-4 space-y-2">{credentials.map((item) => <button key={item.id} className={cn('flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted', editCredential?.id === item.id && 'border-zinc-400 bg-muted')} onClick={() => setEditCredential(item)}><span className="grid size-8 place-items-center rounded-md bg-muted"><LockKeyhole className="size-4"/></span><span className="grid"><strong className="text-sm font-medium">{item.name}</strong><small className="text-xs text-muted-foreground">{item.username || 'Kein Benutzername'} · {item.hasPassword ? 'Passwort gesetzt' : 'Kein Passwort'}</small></span></button>)}{!credentials.length && <p className="py-4 text-sm text-muted-foreground">Noch keine Profile vorhanden.</p>}</div></div><form className="grid content-start gap-4 p-5" onSubmit={submitForm(saveCredential)}><h3 className="text-sm font-semibold">{editCredential ? 'Profil bearbeiten' : 'Neues Profil'}</h3>{credentialDevice && !editCredential && <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">Ein neues Profil wird „{credentialDevice.name}“ direkt zugewiesen.</p>}{editCredential && <p className="text-xs text-muted-foreground">Dieses Profil wird von {devices.filter((device) => device.credentialId === editCredential.id).length} Geräten verwendet.</p>}{credentialDevice && editCredential && credentialDevice.credentialId !== editCredential.id && <Button type="button" variant="secondary" onClick={() => void assignCredential(editCredential)}>„{editCredential.name}“ diesem Gerät zuweisen</Button>}<Field label="Bezeichnung"><Input name="name" defaultValue={editCredential?.name ?? ''} placeholder="z. B. Firewall Admin" required key={`n-${editCredential?.id}`}/></Field><Field label="Benutzername"><Input name="username" defaultValue={editCredential?.username ?? ''} autoComplete="off" key={`u-${editCredential?.id}`}/></Field><Field label="Passwort" hint={editCredential ? 'Leer lassen, um das bestehende Passwort beizubehalten.' : undefined}><Input name="password" type="password" autoComplete="new-password" key={`p-${editCredential?.id}`}/></Field><div className="flex flex-wrap justify-end gap-2">{editCredential && <ConfirmButton icon={<Trash2/>} title="Profil löschen" description={`Das Zugangsdatenprofil „${editCredential.name}“ wird gelöscht und von zugewiesenen Geräten entfernt.`} onConfirm={async () => { await remove(`/api/credentials/${editCredential.id}`); setEditCredential(null); await reload() }}>Löschen</ConfirmButton>}<Button type="button" variant="ghost" onClick={() => setEditCredential(null)}>Leeren</Button><Button type="submit">Speichern</Button></div></form></div></Modal>}
  </>
}
