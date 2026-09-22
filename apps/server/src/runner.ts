import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Device, Pipeline, PipelineStep, Run, RunLog, SocketEvent, ValueSource } from '@autosecure/shared'
import { speedDelay, stepNames } from '@autosecure/shared'
import { appDb, type AppDatabase } from './database.ts'
import { visualizerClientScript } from './browser-scripts.ts'
import { describeLocator, resolveLocator } from './locator.ts'

type Emit = (event: SocketEvent) => void
type FailureAction = 'retry' | 'skip' | 'stop'
type Control = {
  manualPaused: boolean
  stopped: boolean
  failureResolver?: (action: FailureAction) => void
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'datei'

export class RunnerService {
  private queue: Promise<void> = Promise.resolve()
  private controls = new Map<string, Control>()

  constructor(private db: AppDatabase = appDb, private emit: Emit = () => {}) {}

  start(pipelineId: string, deviceIds: string[]): Run {
    const pipeline = this.db.getPipeline(pipelineId)
    if (!pipeline) throw new Error('Pipeline nicht gefunden.')
    if (!deviceIds.length) throw new Error('Bitte mindestens ein Gerät auswählen.')
    return this.enqueue(pipeline, deviceIds)
  }

  startDevicePlan(deviceId: string): Run {
    const device = this.db.getDevice(deviceId)
    if (!device) throw new Error('Gerät nicht gefunden.')
    if (!device.pipelineIds.length) throw new Error('Diesem Gerät sind noch keine Pipelines zugeordnet.')
    const pipelines = device.pipelineIds.map((id) => this.db.getPipeline(id))
    const missingIndex = pipelines.findIndex((pipeline) => !pipeline)
    if (missingIndex >= 0) throw new Error(`Eine zugeordnete Pipeline wurde nicht gefunden: ${device.pipelineIds[missingIndex]}`)
    const available = pipelines as Pipeline[]
    const pipeline: Pipeline = {
      id: `device-plan:${device.id}`,
      name: `Geräteablauf · ${device.name}`,
      description: available.map((item) => item.name).join(' → '),
      speed: 'normal',
      stages: available.map((item) => ({ pipelineId: item.id, name: item.name, stepCount: item.steps.length })),
      steps: available.flatMap((item) => item.steps.map((step) => ({
        ...step,
        id: randomUUID(),
        label: `${item.name} · ${step.label || stepNames[step.type]}`,
        playbackSpeed: item.speed,
      } as PipelineStep))),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    if (!pipeline.steps.length) throw new Error('Die zugeordneten Pipelines enthalten keine Schritte.')
    return this.enqueue(pipeline, [device.id])
  }

  private enqueue(pipeline: Pipeline, deviceIds: string[]): Run {
    const run = this.db.createRun(pipeline, deviceIds)
    this.controls.set(run.id, { manualPaused: false, stopped: false })
    this.emitRun(run.id)
    this.queue = this.queue.then(() => this.execute(run.id)).catch((error) => this.failRun(run.id, error))
    return run
  }

  pause(runId: string) {
    const control = this.controls.get(runId)
    if (!control) throw new Error('Dieser Lauf ist nicht aktiv.')
    control.manualPaused = true
    this.updateRun(runId, { status: 'paused' })
  }

  resume(runId: string) {
    const control = this.controls.get(runId)
    if (!control) throw new Error('Dieser Lauf ist nicht aktiv.')
    control.manualPaused = false
    this.updateRun(runId, { status: 'running', error: null })
  }

  failureAction(runId: string, action: FailureAction) {
    const control = this.controls.get(runId)
    if (!control) throw new Error('Dieser Lauf ist nicht aktiv.')
    if (action === 'stop') control.stopped = true
    control.failureResolver?.(action)
    control.failureResolver = undefined
  }

  stop(runId: string) {
    const control = this.controls.get(runId)
    if (!control) throw new Error('Dieser Lauf ist nicht aktiv.')
    control.stopped = true
    control.manualPaused = false
    control.failureResolver?.('stop')
  }

  private async execute(runId: string) {
    const run = this.db.getRun(runId)
    const pipeline = this.db.getRunSnapshot(runId)
    const control = this.controls.get(runId)
    if (!run || !pipeline || !control) return
    this.updateRun(runId, { status: 'running', startedAt: new Date().toISOString(), error: null })
    this.log(runId, { level: 'info', message: `Pipeline „${pipeline.name}“ wurde gestartet.` })

    for (const deviceId of run.deviceIds) {
      if (control.stopped) break
      const device = this.db.getDevice(deviceId)
      if (!device) {
        this.log(runId, { level: 'error', message: `Gerät ${deviceId} wurde nicht gefunden.` })
        continue
      }
      await this.executeDevice(runId, pipeline, device, control)
    }

    if (control.stopped) {
      this.updateRun(runId, { status: 'stopped', finishedAt: new Date().toISOString() })
      this.log(runId, { level: 'warning', message: 'Der Lauf wurde gestoppt.' })
    } else {
      this.updateRun(runId, { status: 'completed', currentDeviceId: null, currentStep: null, finishedAt: new Date().toISOString(), error: null })
      this.log(runId, { level: 'success', message: 'Alle Geräte wurden erfolgreich verarbeitet.' })
    }
    this.controls.delete(runId)
  }

  private async executeDevice(runId: string, pipeline: Pipeline, device: Device, control: Control) {
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let page: Page | undefined
    const values: Record<string, string> = { ...device.data }
    try {
      this.updateRun(runId, { status: 'running', currentDeviceId: device.id, currentStep: 0, error: null })
      this.log(runId, { deviceId: device.id, level: 'info', message: `Gerät „${device.name}“ wird geöffnet.` })
      browser = await chromium.launch({ headless: false })
      context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: device.ignoreHttpsErrors })
      await context.addInitScript({ content: visualizerClientScript })
      page = await context.newPage()
      context.on('page', async (newPage) => { page = newPage; await newPage.bringToFront().catch(() => {}) })
      await page.bringToFront()

      for (let index = 0; index < pipeline.steps.length; index++) {
        if (control.stopped) break
        while (control.manualPaused && !control.stopped) await delay(180)
        if (control.stopped) break
        let outcome: 'done' | 'retry' | 'skip' = 'retry'
        while (outcome === 'retry' && !control.stopped) {
          const step = pipeline.steps[index]
          this.updateRun(runId, { status: 'running', currentDeviceId: device.id, currentStep: index, error: null })
          try {
            if (!page || page.isClosed()) page = context.pages().find((candidate) => !candidate.isClosed())
            if (!page) throw new Error('Das sichtbare Browserfenster wurde geschlossen.')
            await page.bringToFront()
            await this.executeStep({ runId, pipeline, device, page, context, step, index, values })
            this.log(runId, { deviceId: device.id, stepIndex: index, level: 'success', message: `${index + 1}. ${step.label || stepNames[step.type]}` })
            outcome = 'done'
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await this.captureFailure(runId, device, page, index).catch(() => {})
            this.log(runId, { deviceId: device.id, stepIndex: index, level: 'error', message })
            this.updateRun(runId, { status: 'paused', error: message, currentDeviceId: device.id, currentStep: index })
            const action = await new Promise<FailureAction>((resolve) => { control.failureResolver = resolve })
            control.failureResolver = undefined
            if (action === 'stop') { control.stopped = true; break }
            outcome = action === 'skip' ? 'skip' : 'retry'
          }
        }
      }
      if (!control.stopped) this.log(runId, { deviceId: device.id, level: 'success', message: `Gerät „${device.name}“ ist abgeschlossen.` })
    } finally {
      await context?.close().catch(() => {})
      await browser?.close().catch(() => {})
    }
  }

  private async executeStep(input: { runId: string; pipeline: Pipeline; device: Device; page: Page; context: BrowserContext; step: PipelineStep; index: number; values: Record<string,string> }) {
    const { runId, pipeline, device, step, index, values, context } = input
    let page = input.page
    page.setDefaultTimeout(step.timeoutMs ?? 15_000)
    page.setDefaultNavigationTimeout(step.timeoutMs ?? 45_000)
    const wait = speedDelay[step.playbackSpeed ?? pipeline.speed]
    const info = { action: step.type, device: device.name, index, total: pipeline.steps.length, label: step.label || stepNames[step.type] }

    if (step.type === 'navigate') {
      await this.visualize(page, page.locator('body'), info)
      const url = await this.resolveValue(step.url, device, values)
      await delay(wait)
      await page.goto(this.interpolate(url, device, values), { waitUntil: 'domcontentloaded', timeout: step.timeoutMs ?? 45_000 })
      return
    }

    const spec = 'locator' in step ? step.locator : undefined
    const locator = spec ? await resolveLocator(page, spec) : undefined
    if (locator) {
      await locator.scrollIntoViewIfNeeded()
      await this.visualize(page, locator, info)
    } else {
      await this.visualize(page, page.locator('body'), info)
    }
    await delay(wait)

    switch (step.type) {
      case 'click': {
        const pageCount = context.pages().length
        await locator!.click({ timeout: step.timeoutMs ?? 15_000 })
        await delay(250)
        if (context.pages().length > pageCount) page = context.pages().at(-1)!
        break
      }
      case 'fill': await locator!.fill(await this.resolveValue(step.value, device, values)); break
      case 'select': await locator!.selectOption(await this.resolveValue(step.value, device, values)); break
      case 'toggle': await locator!.setChecked(step.checked); break
      case 'press': if (locator) await locator.press(step.key); else await page.keyboard.press(step.key); break
      case 'extractText': {
        const value = (await locator!.innerText()).trim()
        values[step.key] = value
        if (step.persist) this.db.setDeviceValue(device.id, step.key, value)
        break
      }
      case 'waitFor': if (locator) await locator.waitFor({ state: 'visible', timeout: step.timeoutMs ?? 15_000 }); else await delay(step.milliseconds ?? 1000); break
      case 'download': {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: step.timeoutMs ?? 60_000 }),
          locator!.click(),
        ])
        const original = safeName(download.suggestedFilename())
        const filename = `${safeName(step.artifactKey)}__${original}`
        const target = join(this.db.getArtifactDirectory(runId, device.id), filename)
        await download.saveAs(target)
        this.db.addArtifact({ runId, deviceId: device.id, stepIndex: index, name: filename, path: target, kind: 'download' })
        values[step.artifactKey] = target
        break
      }
      case 'upload': {
        let path = ''
        if (step.file.type === 'localFile') path = this.interpolate(step.file.path, device, values)
        else path = values[step.file.key] || this.db.findArtifactByKey(runId, device.id, step.file.key)?.path || ''
        const sourceDescription = step.file.type === 'retainedArtifact' ? step.file.key : step.file.path
        if (!path || !existsSync(path)) throw new Error(`Upload-Datei nicht gefunden: ${path || sourceDescription || 'kein Pfad'}`)
        await locator!.setInputFiles(path)
        break
      }
    }
    await delay(Math.min(wait, 350))
  }

  private async resolveValue(source: ValueSource, device: Device, values: Record<string,string>): Promise<string> {
    if (source.type === 'literal') return this.interpolate(source.value, device, values)
    if (source.type === 'deviceField') {
      if (source.key === 'baseUrl') return device.baseUrl
      if (source.key === 'name') return device.name
      return values[source.key] ?? device.data[source.key] ?? ''
    }
    if (source.type === 'runValue') return values[source.key] ?? ''
    const credentialId = source.credentialId || device.credentialId
    const credential = credentialId ? this.db.getCredential(credentialId, true) : undefined
    if (!credential) throw new Error('Für dieses Eingabefeld fehlen Zugangsdaten.')
    return source.field === 'password' ? credential.password ?? '' : credential.username
  }

  private interpolate(value: string, device: Device, values: Record<string,string>) {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawKey: string) => {
      const key = rawKey.trim()
      if (key === 'device.baseUrl') return device.baseUrl
      if (key === 'device.name') return device.name
      if (key.startsWith('data.')) return values[key.slice(5)] ?? device.data[key.slice(5)] ?? ''
      if (key.startsWith('result.')) return values[key.slice(7)] ?? ''
      return values[key] ?? ''
    })
  }

  private async visualize(page: Page, locator: Locator, info: Record<string,unknown>) {
    await locator.evaluate((element, detail) => {
      const win = window as unknown as { __ascVisualize?: (element: Element, info: unknown) => void }
      win.__ascVisualize?.(element, detail)
    }, info)
  }

  private async captureFailure(runId: string, device: Device, page: Page | undefined, stepIndex: number) {
    if (!page || page.isClosed()) return
    const filename = `fehler_schritt_${stepIndex + 1}_${Date.now()}.png`
    const target = join(this.db.getArtifactDirectory(runId, device.id), filename)
    await page.screenshot({ path: target, fullPage: true })
    this.db.addArtifact({ runId, deviceId: device.id, stepIndex, name: filename, path: target, mimeType: 'image/png', kind: 'screenshot' })
  }

  private log(runId: string, input: Omit<RunLog, 'id' | 'runId' | 'createdAt'>) {
    const log = this.db.addLog(runId, input)
    this.emit({ type: 'run.log', log })
    this.emitRun(runId)
  }

  private updateRun(runId: string, input: Parameters<AppDatabase['updateRun']>[1]) {
    const run = this.db.updateRun(runId, input)
    if (run) this.emit({ type: 'run.updated', run })
    return run
  }

  private emitRun(runId: string) {
    const run = this.db.getRun(runId)
    if (run) this.emit({ type: 'run.updated', run })
  }

  private failRun(runId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.db.updateRun(runId, { status: 'failed', error: message, finishedAt: new Date().toISOString() })
    this.log(runId, { level: 'error', message })
    this.controls.delete(runId)
  }

  removeRun(runId: string) {
    const paths = this.db.deleteRun(runId)
    for (const path of paths) if (existsSync(path)) try { unlinkSync(path) } catch { /* best effort */ }
  }
}
