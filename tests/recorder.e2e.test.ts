import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserContext } from 'playwright'
import { AppDatabase } from '../apps/server/src/database.ts'
import { RecorderService } from '../apps/server/src/recorder.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe.runIf(process.env.ASC_E2E === '1')('sichtbare Fortsetzungsaufnahme', () => {
  it('spielt bis zum Übergabepunkt und fügt den nächsten Klick dort ein', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'autosecurecloud-recorder-e2e-'))
    temporaryDirectories.push(directory)
    const db = new AppDatabase(join(directory, 'test.db'))
    const fixtureUrl = 'http://127.0.0.1:4310/fixture/firewall'
    const device = db.createDevice({ name: 'Demo', baseUrl: fixtureUrl })
    db.createDataField({ key: 'seriennummer', label: 'Seriennummer' })
    const pipeline = db.createPipeline({ name: 'Fortsetzen', speed: 'fast', steps: [
      { id: 'navigate', type: 'navigate', label: 'Demo öffnen', url: { type: 'literal', value: fixtureUrl } },
      { id: 'fill', type: 'fill', label: 'Benutzername', locator: { candidates: [{ kind: 'label', value: 'Benutzername', exact: true }] }, value: { type: 'literal', value: 'demo' } },
      { id: 'existing', type: 'waitFor', label: 'Bestehender Schritt', milliseconds: 50 },
    ] })
    const recorder = new RecorderService(db)

    try {
      const status = await recorder.continueFrom({ pipelineId: pipeline.id, deviceId: device.id, afterStepIndex: 1 })
      expect(status.phase).toBe('recording')
      const context = (recorder as unknown as { context: BrowserContext }).context
      const page = context.pages().at(-1)!
      expect(page.url()).toBe(fixtureUrl)
      expect(await page.getByLabel('Benutzername').inputValue()).toBe('demo')

      await page.getByRole('button', { name: 'Anmelden' }).click()
      await expect.poll(() => db.getPipeline(pipeline.id)?.steps.length).toBe(4)
      expect(db.getPipeline(pipeline.id)?.steps.map((step) => step.id)).toEqual(['navigate', 'fill', expect.any(String), 'existing'])
      expect(db.getPipeline(pipeline.id)?.steps[2]).toMatchObject({ type: 'click', label: 'Anmelden' })

      await recorder.setExtractMode('seriennummer')
      await page.locator('#device-key').click()
      await expect.poll(() => db.getDevice(device.id)?.data.seriennummer).toBe('FW-DEMO-42A7')
      expect(db.getPipeline(pipeline.id)?.steps[3]).toMatchObject({ type: 'extractText', key: 'seriennummer', label: 'Text erfassen: Seriennummer' })
    } finally {
      await recorder.stop()
      db.close()
    }
  }, 20_000)
})
