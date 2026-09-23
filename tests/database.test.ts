import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppDatabase as AppDatabaseType } from '../apps/server/src/database.ts'

const temporaryDirectories: string[] = []
const makePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'autosecurecloud-test-'))
  temporaryDirectories.push(directory)
  return join(directory, 'test.db')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('lokale Datenhaltung', () => {
  it('behält Titel, Untertitel und Logo nach einem Neustart', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const path = makePath()
    const db = new AppDatabase(path)
    expect(db.getSettings()).toMatchObject({ title: 'AutoSecureCloud', subtitle: 'Sicherheitsautomation', logoUrl: null, actionTimeoutMs: 15000, navigationTimeoutMs: 45000, downloadTimeoutMs: 60000 })
    db.updateSettings('Mein Portal', 'Interne Automationen')
    db.updateExecutionSettings(12000, 35000, 50000)
    db.setLogo(Buffer.from('bildinhalt'), 'image/png')
    const logoUrl = db.getSettings().logoUrl
    db.close()

    const reopened = new AppDatabase(path)
    expect(reopened.getSettings()).toMatchObject({ title: 'Mein Portal', subtitle: 'Interne Automationen', logoUrl, actionTimeoutMs: 12000, navigationTimeoutMs: 35000, downloadTimeoutMs: 50000 })
    expect(reopened.getLogo()).toEqual({ data: Buffer.from('bildinhalt'), mimeType: 'image/png' })
    expect(reopened.setLogo(null, null).logoUrl).toBeNull()
    reopened.close()
  })

  it('speichert Geräte, Zugangsdaten und dynamische Werte', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const credential = db.createCredential({ name: 'Firewall Admin', username: 'admin', password: 'geheim' })
    const device = db.createDevice({ name: 'Firewall Berlin', baseUrl: 'https://10.0.0.1', credentialId: credential.id, data: { seriennummer: 'FW-42' } })

    expect(db.listCredentials()[0]).toMatchObject({ username: 'admin', hasPassword: true })
    expect(db.listCredentials()[0].password).toBeUndefined()
    expect(db.getCredential(credential.id, true)?.password).toBe('geheim')
    expect(db.getDevice(device.id)).toMatchObject({ credentialName: 'Firewall Admin', data: { seriennummer: 'FW-42' } })

    db.setDeviceValue(device.id, 'token', 'SEC-123')
    expect(db.getDevice(device.id)?.data.token).toBe('SEC-123')
    db.close()
  })

  it('legt manuelle Zugangsdaten direkt am Gerät an, ohne ein geteiltes Profil zu verändern', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const shared = db.createCredential({ name: 'Gemeinsam', username: 'alt', password: 'alt-passwort' })
    const first = db.createDevice({ name: 'Gerät A', baseUrl: 'https://a.local', credentialId: shared.id })
    const second = db.createDevice({ name: 'Gerät B', baseUrl: 'https://b.local', credentialId: shared.id })

    expect(db.createCredentialForDevice('fehlt', { username: 'neu', password: 'neu-passwort' })).toBeUndefined()
    expect(db.listCredentials()).toHaveLength(1)
    const result = db.createCredentialForDevice(first.id, { username: 'neu', password: 'neu-passwort' })!
    expect(result.credential).toMatchObject({ name: 'Gerät A · manuell', username: 'neu', hasPassword: true })
    expect(result.credential.password).toBeUndefined()
    expect(result.device.credentialId).toBe(result.credential.id)
    expect(db.getCredential(result.credential.id, true)?.password).toBe('neu-passwort')
    expect(db.getDevice(second.id)?.credentialId).toBe(shared.id)
    expect(db.getCredential(shared.id, true)?.password).toBe('alt-passwort')
    db.close()
  })

  it('friert die Pipeline für einen gestarteten Lauf ein', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const device = db.createDevice({ name: 'Testgerät', baseUrl: 'http://127.0.0.1' })
    const pipeline = db.createPipeline({ name: 'Sicherung', steps: [{ id: 'one', type: 'navigate', url: { type: 'deviceField', key: 'baseUrl' } }] })
    const run = db.createRun(pipeline, [device.id])
    db.updatePipeline(pipeline.id, { steps: [] })

    expect(db.getRunSnapshot(run.id)?.steps).toHaveLength(1)
    expect(db.getPipeline(pipeline.id)?.steps).toHaveLength(0)
    db.close()
  })

  it('ordnet heruntergeladene Dateien ihrem Gerät zu', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const path = makePath()
    const db: AppDatabaseType = new AppDatabase(path)
    const first = db.createDevice({ name: 'Firewall Nord', baseUrl: 'https://192.0.2.10' })
    const second = db.createDevice({ name: 'Firewall Süd', baseUrl: 'https://192.0.2.20' })
    const pipeline = db.createPipeline({ name: 'Lizenz laden' })
    const run = db.createRun(pipeline, [first.id, second.id])
    const file = join(temporaryDirectories.at(-1)!, 'lizenz.bin')
    writeFileSync(file, 'testdatei')

    db.addArtifact({ runId: run.id, deviceId: first.id, artifactKey: 'lizenz', name: 'lizenz.bin', path: file, kind: 'download' })

    expect(db.listArtifactsForDevice(first.id)).toMatchObject([{ name: 'lizenz.bin', artifactKey: 'lizenz', runName: 'Lizenz laden', deviceId: first.id, size: 9 }])
    expect(db.listArtifactsForDevice(second.id)).toEqual([])
    expect(db.listDownloadArtifacts()).toMatchObject([{ artifactKey: 'lizenz', deviceId: first.id }])
    expect(db.findLatestArtifactByKey(first.id, 'lizenz')?.path).toBe(file)
    db.close()
  })

  it('dupliziert eine Pipeline mit unabhängigen Schritt-IDs', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const source = db.createPipeline({ name: 'VPN starten', steps: [{ id: 'click-start', type: 'click', locator: { candidates: [{ kind: 'role', value: 'button', name: '{{device.name}}' }] } }] })
    const copy = db.duplicatePipeline(source.id)

    expect(copy).toMatchObject({ name: 'VPN starten Kopie', speed: source.speed })
    expect(copy?.steps).toHaveLength(1)
    expect(copy?.steps[0].id).not.toBe(source.steps[0].id)
    expect((copy?.steps[0] as Extract<(typeof source.steps)[number], { type: 'click' }>).locator.candidates[0].name).toBe('{{device.name}}')
    db.close()
  })

  it('hält Schrittverknüpfungen beim Duplizieren einer Pipeline intakt', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const source = db.createPipeline({ name: 'Profil laden', steps: [
      { id: 'profile-name', type: 'fill', locator: { candidates: [{ kind: 'css', value: '#name' }] }, value: { type: 'literal', value: 'Profil A' } },
      { id: 'profile-download', type: 'download', locator: { candidates: [{ kind: 'text', value: 'Herunterladen' }] }, artifactKey: 'profil', match: { source: { type: 'stepValue', stepId: 'profile-name' }, containerSelector: 'tr' } },
    ] })

    const copy = db.duplicatePipeline(source.id)!
    const fill = copy.steps[0]
    const download = copy.steps[1]

    if (download.type !== 'download' || download.match?.source.type !== 'stepValue') throw new Error('Download-Verknüpfung fehlt.')
    expect(download.match.source.stepId).toBe(fill.id)
    expect(download.match.source.stepId).not.toBe('profile-name')
    db.close()
  })

  it('speichert den geordneten Pipeline-Plan eines Geräts', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const tunnel = db.createPipeline({ name: 'VPN-Tunnel' })
    const license = db.createPipeline({ name: 'Lizenz laden' })
    const device = db.createDevice({
      name: 'Firewall Hamburg',
      baseUrl: 'https://10.0.0.1',
      pipelineIds: [tunnel.id, license.id],
    })

    expect(db.getDevice(device.id)?.pipelineIds).toEqual([tunnel.id, license.id])
    db.updateDevice(device.id, { pipelineIds: [license.id, tunnel.id] })
    expect(db.getDevice(device.id)?.pipelineIds).toEqual([license.id, tunnel.id])

    db.deletePipeline(license.id)
    expect(db.getDevice(device.id)?.pipelineIds).toEqual([tunnel.id])
    db.close()
  })

  it('fügt eine Automation mehreren Geräten hinzu, ohne vorhandene Abläufe zu ersetzen oder zu duplizieren', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const existing = db.createPipeline({ name: 'Anmelden' })
    const added = db.createPipeline({ name: 'Lizenz laden' })
    const first = db.createDevice({ name: 'Firewall Nord', baseUrl: 'https://192.0.2.10', pipelineIds: [existing.id] })
    const second = db.createDevice({ name: 'Firewall Süd', baseUrl: 'https://192.0.2.20', pipelineIds: [added.id] })

    expect(db.addPipelineToDevices(added.id, [first.id, second.id, first.id])).toMatchObject({ added: 1 })
    expect(db.getDevice(first.id)?.pipelineIds).toEqual([existing.id, added.id])
    expect(db.getDevice(second.id)?.pipelineIds).toEqual([added.id])
    expect(db.addPipelineToDevices(added.id, [first.id, 'unbekannt'])).toBeUndefined()
    expect(db.getDevice(first.id)?.pipelineIds).toEqual([existing.id, added.id])
    db.close()
  })

  it('weist dasselbe Zugangsprofil mehreren Geräten zu und lässt ungültige Zuordnungen unverändert', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const oldCredential = db.createCredential({ name: 'Alt', username: 'alt' })
    const sharedCredential = db.createCredential({ name: 'Gemeinsam', username: 'admin' })
    const first = db.createDevice({ name: 'Firewall Nord', baseUrl: 'https://192.0.2.10', credentialId: oldCredential.id })
    const second = db.createDevice({ name: 'Firewall Süd', baseUrl: 'https://192.0.2.20' })

    expect(db.assignCredentialToDevices(sharedCredential.id, [first.id, second.id, first.id])).toMatchObject({ updated: 2, devices: [{ credentialId: sharedCredential.id }, { credentialId: sharedCredential.id }] })
    expect(db.assignCredentialToDevices(sharedCredential.id, [first.id, second.id])).toMatchObject({ updated: 0 })
    expect(db.assignCredentialToDevices(oldCredential.id, [first.id, 'unbekannt'])).toBeUndefined()
    expect(db.getDevice(first.id)?.credentialId).toBe(sharedCredential.id)
    expect(db.getDevice(second.id)?.credentialName).toBe('Gemeinsam')
    db.close()
  })

  it('speichert Ablaufvorlagen und weist sie mehreren Geräten zu', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const tunnel = db.createPipeline({ name: 'VPN öffnen' })
    const license = db.createPipeline({ name: 'Lizenz aktualisieren' })
    const first = db.createDevice({ name: 'Firewall Nord', baseUrl: 'https://192.0.2.10' })
    const second = db.createDevice({ name: 'Firewall Süd', baseUrl: 'https://192.0.2.20' })
    const group = db.createPipelineGroup({ name: 'Standard-Firewall', pipelineIds: [tunnel.id, license.id] })

    expect(db.applyPipelineGroup(group.id, [first.id, second.id])).toHaveLength(2)
    expect(db.getDevice(first.id)?.pipelineIds).toEqual([tunnel.id, license.id])
    expect(db.getDevice(second.id)?.pipelineIds).toEqual([tunnel.id, license.id])

    db.deletePipeline(tunnel.id)
    expect(db.getPipelineGroup(group.id)?.pipelineIds).toEqual([license.id])
    db.close()
  })

  it('übernimmt entdeckte Geräte und lässt bei doppelter Adresse den letzten Fund gewinnen', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const result = db.upsertDiscoveredDevices([
      { name: 'Testgerät', baseUrl: 'https://192.0.2.40', data: { bereich: 'Standort Nord', ip_adresse: '192.0.2.40' } },
      { name: 'Anlage C', baseUrl: 'https://192.0.2.40/', data: { bereich: 'Standort Nord', ip_adresse: '192.0.2.40' } },
      { name: 'Gateway 1', baseUrl: 'https://198.51.100.10', data: { bereich: 'Standort Süd', ip_adresse: '198.51.100.10' } },
    ], 'lastWins')

    expect(result).toMatchObject({ created: 2, updated: 0, duplicates: 1 })
    expect(db.listDevices().map((device) => [device.name, device.baseUrl])).toEqual([
      ['Anlage C', 'https://192.0.2.40/'],
      ['Gateway 1', 'https://198.51.100.10'],
    ])
    const update = db.upsertDiscoveredDevices([
      { name: 'Anlage C neu', baseUrl: 'https://192.0.2.40', data: { status: 'aktiv' } },
    ])
    expect(update).toMatchObject({ created: 0, updated: 1 })
    expect(db.listDevices().find((device) => device.baseUrl.includes('192.0.2.40'))).toMatchObject({ name: 'Anlage C neu', data: { status: 'aktiv' } })
    db.close()
  })

  it('fügt fortgesetzte Aufnahmen direkt hinter dem Übergabeschritt ein', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const pipeline = db.createPipeline({ name: 'Fortsetzen', steps: [
      { id: 'one', type: 'navigate', url: { type: 'literal', value: 'http://127.0.0.1/start' } },
      { id: 'three', type: 'waitFor', milliseconds: 1000 },
    ] })

    db.insertPipelineStep(pipeline.id, 1, { id: 'two', type: 'click', locator: { candidates: [{ kind: 'css', value: '#weiter' }] } })
    expect(db.getPipeline(pipeline.id)?.steps.map((step) => step.id)).toEqual(['one', 'two', 'three'])

    db.replacePipelineStep(pipeline.id, 1, { id: 'download', type: 'download', locator: { candidates: [{ kind: 'css', value: '#weiter' }] }, artifactKey: 'datei' })
    expect(db.getPipeline(pipeline.id)?.steps.map((step) => step.id)).toEqual(['one', 'download', 'three'])
    db.close()
  })

  it('verwaltet Tabellenspalten als stabile Pipeline-Variablen', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const db: AppDatabaseType = new AppDatabase(makePath())
    const device = db.createDevice({ name: 'Firewall Köln', baseUrl: 'https://fw-koeln.local' })
    const field = db.createDataField({ label: 'Seriennummer', type: 'text' })

    db.setDeviceValue(device.id, field.key, 'FW-CGN-17')
    expect(db.listDataFields()[0]).toMatchObject({ key: 'seriennummer', label: 'Seriennummer' })
    expect(db.getDevice(device.id)?.data.seriennummer).toBe('FW-CGN-17')

    db.updateDataField(field.id, { label: 'Gerätekennung' })
    expect(db.listDataFields()[0]).toMatchObject({ key: 'seriennummer', label: 'Gerätekennung' })
    const pipeline = db.createPipeline({ name: 'Auslesen' })
    db.updatePipeline(pipeline.id, { steps: [{ id: 'extract', type: 'extractText', locator: { candidates: [{ kind: 'css', value: '#key' }] }, key: 'konfigurationsschluessel', persist: true }] })
    expect(db.listDataFields().map((item) => item.key)).toContain('konfigurationsschluessel')
    db.deleteDataField(field.id)
    expect(db.getDevice(device.id)?.data.seriennummer).toBeUndefined()
    db.close()
  })

  it('exportiert und importiert Gerätedaten als XLSX', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const source: AppDatabaseType = new AppDatabase(makePath())
    source.createDevice({ name: 'Firewall München', baseUrl: 'https://fw.local', data: { status: 'bereit', zertifikat: '2027-10-01' } })
    const workbook = await source.exportWorkbook()
    const target: AppDatabaseType = new AppDatabase(makePath())
    const result = await target.importWorkbook(workbook)

    expect(result).toEqual({ created: 1, updated: 0 })
    expect(target.listDevices()[0].data).toEqual({ status: 'bereit', zertifikat: '2027-10-01' })
    source.close(); target.close()
  })

  it('prüft XLSX-Dateien vor dem Import und verändert bei ungültigen Zeilen nichts', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const ExcelJS = (await import('exceljs')).default
    const source = new AppDatabase(makePath())
    source.createDevice({ name: 'Neu', baseUrl: 'https://new.local' })
    source.createDevice({ name: 'Ungültig', baseUrl: 'https://valid.local' })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(source.exportWorkbook() as unknown as Parameters<typeof workbook.xlsx.load>[0])
    workbook.worksheets[0].getRow(3).getCell(2).value = 'javascript:alert(1)'
    const file = Buffer.from(await workbook.xlsx.writeBuffer())
    const target = new AppDatabase(makePath())
    await expect(target.previewWorkbook(file)).rejects.toThrow('Nur HTTP- und HTTPS-Adressen')
    await expect(target.importWorkbook(file)).rejects.toThrow('Nur HTTP- und HTTPS-Adressen')
    expect(target.listDevices()).toHaveLength(0)
    source.close(); target.close()
  })

  it('stellt Geräte, Zugangsdaten, Läufe und Dateien aus einem vollständigen Backup wieder her', async () => {
    const { AppDatabase } = await import('../apps/server/src/database.ts')
    const source = new AppDatabase(makePath())
    source.updateSettings('Backup-Test', 'Wiederherstellung')
    source.setLogo(Buffer.from('logo'), 'image/png')
    const credential = source.createCredential({ name: 'Admin', username: 'root', password: 'geheim' })
    const pipeline = source.createPipeline({ name: 'Prüfen' })
    const device = source.createDevice({ name: 'Firewall', baseUrl: 'https://fw.local', credentialId: credential.id, pipelineIds: [pipeline.id] })
    const run = source.createRun(pipeline, [device.id])
    const artifactPath = join(dirname(makePath()), 'download.txt')
    writeFileSync(artifactPath, 'gesicherte Datei')
    source.addArtifact({ runId: run.id, deviceId: device.id, name: 'download.txt', path: artifactPath, kind: 'download' })
    const backup = source.exportBackup()
    const target = new AppDatabase(makePath())
    target.createDevice({ name: 'Wird ersetzt', baseUrl: 'https://old.local' })
    expect(target.restoreBackup(backup)).toEqual({ devices: 1, pipelines: 1, artifacts: 1 })
    expect(target.listDevices()).toHaveLength(1)
    expect(target.getCredential(credential.id, true)?.password).toBe('geheim')
    expect(target.getSettings()).toMatchObject({ title: 'Backup-Test', subtitle: 'Wiederherstellung' })
    expect(target.getLogo()?.data).toEqual(Buffer.from('logo'))
    expect(target.getRun(run.id)?.status).toBe('interrupted')
    const artifact = target.getRun(run.id, true)?.artifacts?.[0]
    expect(artifact).toBeDefined()
    expect(readFileSync(target.getArtifactRecord(artifact!.id)!.path, 'utf8')).toBe('gesicherte Datei')
    const restoredDirectory = dirname(target.getArtifactRecord(artifact!.id)!.path)
    expect(() => target.restoreBackup(Buffer.from('ungültig'))).toThrow('ungültiges Format')
    expect(target.listDevices()).toHaveLength(1)
    source.close(); target.close()
    rmSync(restoredDirectory, { recursive: true, force: true })
  })
})
