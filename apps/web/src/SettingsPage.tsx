import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Download, RotateCcw, ShieldCheck, Upload } from 'lucide-react'
import type { AppSettings, AutomaticBackup } from '@autosecure/shared'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { api, patch } from './api.ts'
import { Button, Field, Input, Modal, Notice, PageHeader, Select } from './components.tsx'

type Props = {
  settings: AppSettings
  onSaved: (settings: AppSettings) => void
  notify: (message: string, tone?: 'success' | 'error') => void
}

export function SettingsPage({ settings, onSaved, notify }: Props) {
  const [title, setTitle] = useState(settings.title)
  const [subtitle, setSubtitle] = useState(settings.subtitle)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fileInputKey, setFileInputKey] = useState(0)
  const [actionSeconds, setActionSeconds] = useState(settings.actionTimeoutMs / 1000)
  const [navigationSeconds, setNavigationSeconds] = useState(settings.navigationTimeoutMs / 1000)
  const [downloadSeconds, setDownloadSeconds] = useState(settings.downloadTimeoutMs / 1000)
  const [backupFile, setBackupFile] = useState<File | null>(null)
  const [restoreConfirmed, setRestoreConfirmed] = useState(false)
  const [automaticBackupInterval, setAutomaticBackupInterval] = useState(settings.automaticBackupInterval)
  const [automaticBackupRetention, setAutomaticBackupRetention] = useState(settings.automaticBackupRetention)
  const [automaticBackups, setAutomaticBackups] = useState<AutomaticBackup[]>([])
  const [automaticBackupListError, setAutomaticBackupListError] = useState<string | null>(null)
  const [selectedAutomaticBackup, setSelectedAutomaticBackup] = useState<AutomaticBackup | null>(null)
  const [clearModalOpen, setClearModalOpen] = useState(false)
  const [clearConfirmation, setClearConfirmation] = useState('')
  const [lastAutomaticBackupAt, setLastAutomaticBackupAt] = useState(settings.lastAutomaticBackupAt)
  const [automaticBackupError, setAutomaticBackupError] = useState(settings.automaticBackupError)

  useEffect(() => {
    setActionSeconds(settings.actionTimeoutMs / 1000)
    setNavigationSeconds(settings.navigationTimeoutMs / 1000)
    setDownloadSeconds(settings.downloadTimeoutMs / 1000)
  }, [settings.actionTimeoutMs, settings.navigationTimeoutMs, settings.downloadTimeoutMs])

  useEffect(() => {
    setAutomaticBackupInterval(settings.automaticBackupInterval)
    setAutomaticBackupRetention(settings.automaticBackupRetention)
    setLastAutomaticBackupAt(settings.lastAutomaticBackupAt)
    setAutomaticBackupError(settings.automaticBackupError)
  }, [settings.automaticBackupInterval, settings.automaticBackupRetention, settings.lastAutomaticBackupAt, settings.automaticBackupError])

  const loadAutomaticBackups = async () => {
    try {
      setAutomaticBackups(await api<AutomaticBackup[]>('/api/backup/automatic'))
      setAutomaticBackupListError(null)
    } catch (error) { setAutomaticBackupListError(error instanceof Error ? error.message : String(error)) }
  }

  useEffect(() => {
    void loadAutomaticBackups()
    const timer = window.setInterval(() => {
      void loadAutomaticBackups()
      void api<AppSettings>('/api/settings').then((current) => {
        setLastAutomaticBackupAt(current.lastAutomaticBackupAt)
        setAutomaticBackupError(current.automaticBackupError)
      }).catch(() => {})
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!file) return setPreviewUrl(null)
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const saveText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      const saved = await patch<AppSettings>('/api/settings', { title, subtitle })
      onSaved(saved)
      setTitle(saved.title)
      setSubtitle(saved.subtitle)
      notify('Titel und Untertitel wurden gespeichert.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const uploadLogo = async () => {
    if (!file) return
    setBusy(true)
    try {
      const body = new FormData()
      body.append('file', file)
      onSaved(await api<AppSettings>('/api/settings/logo', { method: 'POST', body }))
      setFile(null)
      setFileInputKey((key) => key + 1)
      notify('Logo wurde gespeichert.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const resetLogo = async () => {
    setBusy(true)
    try {
      onSaved(await api<AppSettings>('/api/settings/logo', { method: 'DELETE' }))
      setFile(null)
      setFileInputKey((key) => key + 1)
      notify('Standardlogo wurde wiederhergestellt.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const saveExecution = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      onSaved(await patch<AppSettings>('/api/settings/execution', { actionTimeoutMs: actionSeconds * 1000, navigationTimeoutMs: navigationSeconds * 1000, downloadTimeoutMs: downloadSeconds * 1000 }))
      notify('Standard-Zeitlimits wurden gespeichert.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const downloadBackup = async () => {
    setBusy(true)
    try {
      const response = await fetch('/api/backup')
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || 'Das Backup konnte nicht erstellt werden.')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `autosecurecloud-backup-${new Date().toISOString().slice(0, 10)}.asc.gz`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      notify('Backup wurde heruntergeladen.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const restoreBackup = async () => {
    if (!backupFile || !restoreConfirmed) return
    setBusy(true)
    try {
      const body = new FormData()
      body.append('file', backupFile)
      await api('/api/backup/restore', { method: 'POST', body })
      setBackupFile(null)
      setRestoreConfirmed(false)
      notify('Backup wurde wiederhergestellt. Der Arbeitsbereich wird neu geladen.')
      window.location.reload()
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const saveAutomaticBackups = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    try {
      onSaved(await patch<AppSettings>('/api/settings/automatic-backup', { interval: automaticBackupInterval, retention: automaticBackupRetention }))
      await loadAutomaticBackups()
      notify(automaticBackupInterval === 'off' ? 'Automatische Backups wurden ausgeschaltet.' : 'Automatische Backups wurden gespeichert.')
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const restoreAutomaticBackup = async () => {
    if (!selectedAutomaticBackup || !restoreConfirmed) return
    setBusy(true)
    try {
      await api(`/api/backup/automatic/${encodeURIComponent(selectedAutomaticBackup.name)}/restore`, { method: 'POST' })
      setSelectedAutomaticBackup(null)
      setRestoreConfirmed(false)
      notify('Backup wurde wiederhergestellt. Der Arbeitsbereich wird neu geladen.')
      window.location.reload()
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  const clearWorkspace = async () => {
    if (clearConfirmation !== 'ARBEITSBEREICH LÖSCHEN') return
    setBusy(true)
    try {
      const result = await api<{ cleanupWarning: string | null }>('/api/workspace/clear', { method: 'POST', body: JSON.stringify({ confirmation: clearConfirmation }) })
      if (result.cleanupWarning) window.alert(result.cleanupWarning)
      window.location.reload()
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error') }
    finally { setBusy(false) }
  }

  return <>
    <PageHeader eyebrow="Konfiguration" title="Einstellungen" description="Arbeitsbereich, Ausführung und Datensicherung verwalten."/>
    <div className="grid max-w-4xl gap-5 lg:grid-cols-2">
      <Card className="gap-5 p-6 shadow-none">
        <div><h2 className="text-base font-semibold">Titel und Untertitel</h2><p className="mt-1 text-sm text-muted-foreground">Beide Texte erscheinen oben im Menü.</p></div>
        <form className="grid gap-5" onSubmit={saveText}>
          <Field label="Titel"><Input aria-label="Titel" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} required placeholder="AutoSecureCloud"/></Field>
          <Field label="Untertitel"><Input aria-label="Untertitel" value={subtitle} onChange={(event) => setSubtitle(event.target.value)} maxLength={160} placeholder="Sicherheitsautomation"/></Field>
          <div><Button type="submit" disabled={busy || (!title.trim())}>Texte speichern</Button></div>
        </form>
      </Card>
      <Card className="gap-5 p-6 shadow-none">
        <div><h2 className="text-base font-semibold">Logo</h2><p className="mt-1 text-sm text-muted-foreground">PNG, JPG oder WebP, maximal 2 MB.</p></div>
        <div className="flex items-center gap-4">
          <span className={cn('grid shrink-0 place-items-center overflow-hidden', previewUrl || settings.logoUrl ? 'h-16 w-28 bg-transparent' : 'size-20 rounded-xl bg-blue-600 text-white')}>
            {previewUrl || settings.logoUrl ? <img src={previewUrl || settings.logoUrl || ''} alt="Logovorschau" className="size-full object-contain"/> : <ShieldCheck className="size-8"/>}
          </span>
          <div className="min-w-0"><p className="text-sm font-medium">{file ? file.name : settings.logoUrl ? 'Aktuelles Logo' : 'Standardlogo'}</p><p className="mt-1 text-xs text-muted-foreground">Das Bild wird im Seitenmenü angezeigt.</p></div>
        </div>
        <label className="block text-sm font-medium" htmlFor="settings-logo">Neues Logo auswählen</label>
        <Input key={fileInputKey} id="settings-logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy}/>
        <div className="flex flex-wrap gap-2">
          <Button type="button" icon={<Upload/>} onClick={uploadLogo} disabled={!file || busy}>Logo speichern</Button>
          {settings.logoUrl && <Button type="button" variant="secondary" icon={<RotateCcw/>} onClick={resetLogo} disabled={busy}>Standardlogo</Button>}
        </div>
      </Card>
      <Card className="gap-5 p-6 shadow-none lg:col-span-2">
        <div><h2 className="text-base font-semibold">Timeouts</h2><p className="mt-1 text-sm text-muted-foreground">Standard-Timeouts für Aufnahmen und Geräteabläufe. Ein Timeout im einzelnen Schritt hat Vorrang.</p></div>
        <form className="grid gap-4 sm:grid-cols-3" onSubmit={saveExecution}>
          <Field label="Timeout für Aktionen (Sekunden)"><Input aria-label="Timeout für Aktionen (Sekunden)" type="number" min={1} max={180} step={1} value={actionSeconds} onChange={(event) => setActionSeconds(Number(event.target.value))} required/></Field>
          <Field label="Timeout für Seitenwechsel (Sekunden)"><Input aria-label="Timeout für Seitenwechsel (Sekunden)" type="number" min={1} max={180} step={1} value={navigationSeconds} onChange={(event) => setNavigationSeconds(Number(event.target.value))} required/></Field>
          <Field label="Timeout für Downloads (Sekunden)"><Input aria-label="Timeout für Downloads (Sekunden)" type="number" min={1} max={180} step={1} value={downloadSeconds} onChange={(event) => setDownloadSeconds(Number(event.target.value))} required/></Field>
          <div className="sm:col-span-3"><Button type="submit" disabled={busy}>Timeouts speichern</Button></div>
        </form>
      </Card>
      <Card className="gap-5 p-6 shadow-none lg:col-span-2">
        <div><h2 className="text-base font-semibold">Daten und Backup</h2><p className="mt-1 text-sm text-muted-foreground">Aktiver Speicherort für Geräte, Automationen und Laufdateien:</p><code className="mt-2 block break-all rounded-lg bg-muted px-3 py-2 text-xs">{settings.storagePath}</code></div>
        <Notice tone="warning" title="Backup sicher aufbewahren">Das Backup enthält Zugangsdaten und heruntergeladene Dateien. Es ist komprimiert, aber nicht verschlüsselt.</Notice>
        <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" icon={<Download/>} disabled={busy} onClick={() => void downloadBackup()}>Vollständiges Backup herunterladen</Button><Button type="button" variant="secondary" icon={<Upload/>} disabled={busy} onClick={() => document.getElementById('settings-backup')?.click()}>Backup wiederherstellen</Button><input id="settings-backup" className="sr-only" type="file" accept=".gz,.asc.gz" onChange={(event) => { setBackupFile(event.target.files?.[0] ?? null); setRestoreConfirmed(false); event.target.value = '' }}/></div>
        <div className="border-t pt-5">
          <h3 className="text-sm font-semibold">Automatische Backups</h3>
          <p className="mt-1 text-sm text-muted-foreground">Beim Einschalten ist das erste Backup sofort fällig. Danach sichert die laufende Anwendung täglich oder wöchentlich; laufende Aufnahmen und Geräteabläufe werden abgewartet.</p>
          <form className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={saveAutomaticBackups}>
            <Field label="Intervall"><Select value={automaticBackupInterval} onChange={(event) => setAutomaticBackupInterval(event.target.value as AppSettings['automaticBackupInterval'])}><option value="off">Aus</option><option value="daily">Täglich</option><option value="weekly">Wöchentlich</option></Select></Field>
            <Field label="Backups aufbewahren"><Input aria-label="Backups aufbewahren" type="number" min={1} max={30} step={1} value={automaticBackupRetention} onChange={(event) => setAutomaticBackupRetention(Number(event.target.value))} required/></Field>
            <Button type="submit" disabled={busy}>Einstellungen speichern</Button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">Speicherort: <code className="break-all">{settings.backupDirectory}</code></p>
          {lastAutomaticBackupAt && <p className="mt-2 text-xs text-muted-foreground">Letztes automatisches Backup: {new Date(lastAutomaticBackupAt).toLocaleString('de-DE')}</p>}
          {automaticBackupError && <Notice tone="danger" title="Automatisches Backup fehlgeschlagen">{automaticBackupError}</Notice>}
          {automaticBackupListError && <p className="mt-2 text-sm text-destructive">{automaticBackupListError}</p>}
          {automaticBackups.length > 0 && <div className="mt-4 space-y-2"><h4 className="text-sm font-medium">Gespeicherte Backups</h4>{automaticBackups.map((backup) => <div key={backup.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"><span className="text-sm">{new Date(backup.createdAt).toLocaleString('de-DE')} <small className="text-muted-foreground">({(backup.size / 1024 / 1024).toFixed(1)} MB)</small></span><span className="flex gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => { const link = document.createElement('a'); link.href = `/api/backup/automatic/${encodeURIComponent(backup.name)}`; link.download = backup.name; link.click() }}>Herunterladen</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => { setSelectedAutomaticBackup(backup); setRestoreConfirmed(false) }}>Wiederherstellen</Button></span></div>)}</div>}
        </div>
        <div className="border-t pt-5">
          <h3 className="text-sm font-semibold">Arbeitsbereich löschen</h3>
          <p className="mt-1 text-sm text-muted-foreground">Entfernt den aktuellen Arbeitsbereich vollständig. Gespeicherte automatische Backups bleiben erhalten.</p>
          <Button type="button" variant="danger" className="mt-4" disabled={busy} onClick={() => { setClearConfirmation(''); setClearModalOpen(true) }}>Arbeitsbereich löschen</Button>
        </div>
      </Card>
    </div>
    {backupFile && <Modal title="Backup wiederherstellen" description={backupFile.name} onClose={() => { if (!busy) setBackupFile(null) }}>
      <div className="grid gap-4 px-6 py-5"><Notice tone="danger" title="Der aktuelle Arbeitsbereich wird ersetzt">Geräte, Automationen, Zugangsdaten, Datenwerte, Läufe und Dateien werden auf den Stand des Backups gesetzt. Lade bei Bedarf zuerst ein Backup des aktuellen Stands herunter.</Notice><label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4" checked={restoreConfirmed} onChange={(event) => setRestoreConfirmed(event.target.checked)}/><span>Ich möchte den aktuellen Arbeitsbereich durch dieses Backup ersetzen.</span></label></div>
      <div className="flex justify-end gap-2 border-t bg-muted/20 px-6 py-4"><Button variant="ghost" disabled={busy} onClick={() => setBackupFile(null)}>Abbrechen</Button><Button variant="danger" disabled={busy || !restoreConfirmed} onClick={() => void restoreBackup()}>{busy ? 'Wird wiederhergestellt …' : 'Wiederherstellen'}</Button></div>
    </Modal>}
    {selectedAutomaticBackup && <Modal title="Automatisches Backup wiederherstellen" description={new Date(selectedAutomaticBackup.createdAt).toLocaleString('de-DE')} onClose={() => { if (!busy) setSelectedAutomaticBackup(null) }}>
      <div className="grid gap-4 px-6 py-5"><Notice tone="danger" title="Der aktuelle Arbeitsbereich wird ersetzt">Geräte, Automationen, Zugangsdaten, Datenwerte, Läufe und Dateien werden auf den Stand dieses Backups gesetzt.</Notice><label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4" checked={restoreConfirmed} onChange={(event) => setRestoreConfirmed(event.target.checked)}/><span>Ich möchte den aktuellen Arbeitsbereich durch dieses Backup ersetzen.</span></label></div>
      <div className="flex justify-end gap-2 border-t bg-muted/20 px-6 py-4"><Button variant="ghost" disabled={busy} onClick={() => setSelectedAutomaticBackup(null)}>Abbrechen</Button><Button variant="danger" disabled={busy || !restoreConfirmed} onClick={() => void restoreAutomaticBackup()}>{busy ? 'Wird wiederhergestellt …' : 'Wiederherstellen'}</Button></div>
    </Modal>}
    {clearModalOpen && <Modal title="Arbeitsbereich vollständig löschen" description="Gespeicherte automatische Backups bleiben erhalten." onClose={() => { if (!busy) setClearModalOpen(false) }}>
      <div className="grid gap-4 px-6 py-5"><Notice tone="danger" title="Alle aktuellen Daten werden entfernt">Geräte, Automationen, Zugangsdaten, Tabellenwerte, Läufe, heruntergeladene Dateien, Logo und Einstellungen werden gelöscht. Die automatische Sicherung wird ausgeschaltet. Backups im Backup-Ordner bleiben erhalten und können danach wiederhergestellt werden.</Notice><Field label="Zur Bestätigung ARBEITSBEREICH LÖSCHEN eingeben"><Input value={clearConfirmation} onChange={(event) => setClearConfirmation(event.target.value)} autoFocus autoComplete="off"/></Field></div>
      <div className="flex justify-end gap-2 border-t bg-muted/20 px-6 py-4"><Button variant="ghost" disabled={busy} onClick={() => setClearModalOpen(false)}>Abbrechen</Button><Button variant="danger" disabled={busy || clearConfirmation !== 'ARBEITSBEREICH LÖSCHEN'} onClick={() => void clearWorkspace()}>{busy ? 'Wird gelöscht …' : 'Endgültig löschen'}</Button></div>
    </Modal>}
  </>
}
