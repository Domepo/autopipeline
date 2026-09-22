import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
})
