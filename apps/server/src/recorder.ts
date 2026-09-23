import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Device, DownloadMatchSource, LocatorSpec, Pipeline, PipelineStep, RecordingStatus, SocketEvent, ValueSource } from '@autosecure/shared'
import { speedDelay, stepNames } from '@autosecure/shared'
import { appDb, type AppDatabase } from './database.ts'
import { recorderClientScript, visualizerClientScript } from './browser-scripts.ts'
import { resolveLocator, resolveLocatorInMatchingContainer } from './locator.ts'
import { createMergedAtv } from './atv-merge.ts'

type Emit = (event: SocketEvent) => void
type RecorderPayload = {
  type: PipelineStep['type']
  locator?: PipelineStep extends { locator: infer L } ? L : never
  label?: string
  value?: string
  password?: boolean
  text?: string
  checked?: boolean
  key?: string
  filename?: string
}

export class RecorderService {
  private browser?: Browser
  private context?: BrowserContext
  private pages = new Set<Page>()
  private current?: RecordingStatus
  private lastActionAt = 0
  private nextInsertIndex = 0
  private lastRecordedIndex?: number
  private temporaryDirectory?: string
  private pendingExtractKey?: string

  constructor(private db: AppDatabase = appDb, private emit: Emit = () => {}) {}

  private actionTimeout(step: PipelineStep) { return step.timeoutMs ?? this.db.getSettings().actionTimeoutMs }
  private navigationTimeout(step: PipelineStep) { return step.timeoutMs ?? this.db.getSettings().navigationTimeoutMs }
  private downloadTimeout(step: PipelineStep) { return step.timeoutMs ?? this.db.getSettings().downloadTimeoutMs }

  status() { return this.current ?? null }

  async start(input: { pipelineId: string; deviceId?: string; url?: string; ignoreHttpsErrors?: boolean }) {
    await this.stop()
    const pipeline = this.db.getPipeline(input.pipelineId)
    if (!pipeline) throw new Error('Pipeline nicht gefunden.')
    const device = input.deviceId ? this.db.getDevice(input.deviceId) : undefined
    const url = input.url || device?.baseUrl
    if (!url) throw new Error('Bitte ein Gerät oder eine Start-URL auswählen.')

    this.browser = await chromium.launch({ headless: false })
    this.context = await this.browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: input.ignoreHttpsErrors ?? device?.ignoreHttpsErrors ?? false })
    await this.enableRecording(this.context, input.pipelineId)
    const page = await this.context.newPage()
    this.attachPage(page, input.pipelineId)
    this.nextInsertIndex = pipeline.steps.length
    this.lastRecordedIndex = undefined
    this.current = { pipelineId: input.pipelineId, deviceId: input.deviceId, active: true, mode: 'record', phase: 'opening', startedAt: new Date().toISOString(), url }
    this.emit({ type: 'recording.status', recording: this.current })
    const step: PipelineStep = { id: randomUUID(), type: 'navigate', label: 'Startseite öffnen', url: { type: 'literal', value: url } }
    this.saveStep(input.pipelineId, step)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.db.getSettings().navigationTimeoutMs })
      await page.bringToFront()
      this.current = { ...this.current, phase: 'recording' }
      this.emit({ type: 'recording.status', recording: this.current })
      return this.current
    } catch (error) {
      const reverted = this.db.updatePipeline(input.pipelineId, { steps: pipeline.steps })
      if (reverted) this.emit({ type: 'pipeline.updated', pipeline: reverted })
      await this.stop()
      const message = error instanceof Error ? error.message : String(error)
      if (/ERR_CERT_|CERT_AUTHORITY_INVALID/i.test(message)) throw new Error('Das HTTPS-Zertifikat wird nicht vertraut. Aktiviere beim Aufnahmestart „Selbstsigniertes Zertifikat zulassen“ und starte die Aufnahme erneut.')
      throw new Error(`Die Startseite konnte nicht geöffnet werden: ${message}`)
    }
  }

  async continueFrom(input: { pipelineId: string; deviceId: string; afterStepIndex: number }) {
    await this.stop()
    const pipeline = this.db.getPipeline(input.pipelineId)
    if (!pipeline) throw new Error('Pipeline nicht gefunden.')
    const device = this.db.getDevice(input.deviceId)
    if (!device) throw new Error('Bitte ein Gerät auswählen.')
    if (!Number.isInteger(input.afterStepIndex) || input.afterStepIndex < 0 || input.afterStepIndex >= pipeline.steps.length) throw new Error('Der gewählte Schritt ist nicht mehr vorhanden.')

    this.browser = await chromium.launch({ headless: false })
    this.context = await this.browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: device.ignoreHttpsErrors })
    await this.context.addInitScript({ content: visualizerClientScript })
    const page = await this.context.newPage()
    this.temporaryDirectory = mkdtempSync(join(tmpdir(), 'asc-recording-'))
    this.nextInsertIndex = input.afterStepIndex + 1
    this.lastRecordedIndex = undefined
    this.current = {
      pipelineId: input.pipelineId, deviceId: input.deviceId, active: true, mode: 'record', phase: 'replaying',
      replayStep: 0, replayTotal: input.afterStepIndex + 1, insertAfterStep: input.afterStepIndex,
      startedAt: new Date().toISOString(), url: device.baseUrl,
    }
    this.emit({ type: 'recording.status', recording: this.current })

    try {
      const values: Record<string, string> = { ...device.data }
      for (let index = 0; index <= input.afterStepIndex; index++) {
        this.current = { ...this.current, replayStep: index }
        this.emit({ type: 'recording.status', recording: this.current })
        const activePage = [...this.context.pages()].reverse().find((candidate) => !candidate.isClosed()) ?? page
        await activePage.bringToFront()
        await this.replayStep({ pipeline, device, page: activePage, context: this.context, step: pipeline.steps[index], index, values })
      }
      for (const openPage of this.context.pages()) {
        await openPage.evaluate(() => {
          const active = document.activeElement
          if (active instanceof HTMLElement) active.blur()
        }).catch(() => {})
      }
      await this.enableRecording(this.context, input.pipelineId)
      for (const openPage of this.context.pages()) {
        this.attachPage(openPage, input.pipelineId)
        for (const frame of openPage.frames()) await frame.evaluate(recorderClientScript).catch(() => {})
        await openPage.evaluate(() => (window as unknown as { __ascClearVisualize?: () => void }).__ascClearVisualize?.()).catch(() => {})
      }
      const activePage = [...this.context.pages()].reverse().find((candidate) => !candidate.isClosed()) ?? page
      await activePage.bringToFront()
      this.current = { ...this.current, phase: 'recording', replayStep: input.afterStepIndex + 1 }
      this.emit({ type: 'recording.status', recording: this.current })
      return this.current
    } catch (error) {
      await this.stop()
      throw new Error(`Bis Schritt ${input.afterStepIndex + 1} konnte nicht abgespielt werden: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async setExtractMode(key?: string) {
    if (!this.current || !this.context) throw new Error('Es läuft keine Aufnahme.')
    if (this.current.phase !== 'recording') throw new Error('Bitte warte, bis die vorhandenen Schritte abgespielt wurden.')
    if (key && !this.db.listDataFields().some((field) => field.key === key)) throw new Error('Die gewählte Tabellenspalte wurde nicht gefunden.')
    this.pendingExtractKey = key || undefined
    this.current = { ...this.current, mode: 'extract' }
    for (const page of this.pages) {
      await page.evaluate(() => { (window as unknown as { __ascSetRecorderMode?: (mode: string) => void }).__ascSetRecorderMode?.('extract') }).catch(() => {})
    }
    this.emit({ type: 'recording.status', recording: this.current })
    return this.current
  }

  async stop() {
    if (this.context) await this.context.close().catch(() => {})
    if (this.browser) await this.browser.close().catch(() => {})
    this.pages.clear(); this.context = undefined; this.browser = undefined; this.current = undefined
    this.nextInsertIndex = 0; this.lastRecordedIndex = undefined; this.pendingExtractKey = undefined
    if (this.temporaryDirectory) rmSync(this.temporaryDirectory, { recursive: true, force: true })
    this.temporaryDirectory = undefined
    this.emit({ type: 'recording.status', recording: null })
  }

  private async enableRecording(context: BrowserContext, pipelineId: string) {
    await context.exposeBinding('__ascEmit', async (_source, payload: RecorderPayload) => this.capture(pipelineId, payload))
    await context.addInitScript({ content: recorderClientScript })
    context.on('page', (page) => this.attachPage(page, pipelineId))
  }

  private attachPage(page: Page, pipelineId: string) {
    if (this.pages.has(page)) return
    this.pages.add(page)
    page.on('close', () => this.pages.delete(page))
    page.on('download', async (download) => {
      const pipeline = this.db.getPipeline(pipelineId)
      const last = this.lastRecordedIndex == null ? undefined : pipeline?.steps[this.lastRecordedIndex]
      const locator = last && last.type === 'click' ? last.locator : undefined
      if (!locator) return
      const suggested = download.suggestedFilename()
      const recentInput = this.lastRecordedIndex == null ? undefined : pipeline?.steps
        .slice(Math.max(0, this.lastRecordedIndex - 3), this.lastRecordedIndex)
        .reverse()
        .find((candidate) => (candidate.type === 'fill' || candidate.type === 'select') && candidate.value.type !== 'credentialField')
      const step: PipelineStep = {
        id: randomUUID(), type: 'download', label: `Download: ${suggested}`, locator,
        artifactKey: suggested.replace(/\.[^.]+$/, '').replace(/\W+/g, '_') || 'download',
        match: recentInput ? { source: { type: 'stepValue', stepId: recentInput.id }, containerSelector: 'tr' } : undefined,
      }
      const updated = this.lastRecordedIndex == null ? undefined : this.db.replacePipelineStep(pipelineId, this.lastRecordedIndex, step)
      if (updated) this.emit({ type: 'pipeline.updated', pipeline: updated })
    })
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame() || Date.now() - this.lastActionAt < 1800 || !this.current) return
      const url = frame.url()
      if (!/^https?:/.test(url) || url === this.current.url) return
      const step: PipelineStep = { id: randomUUID(), type: 'navigate', label: 'Seite öffnen', url: { type: 'literal', value: url } }
      this.saveStep(pipelineId, step)
    })
  }

  private capture(pipelineId: string, payload: RecorderPayload) {
    if (!this.current) return
    this.lastActionAt = Date.now()
    const id = randomUUID()
    const label = payload.password ? 'Passwort eingeben' : payload.label?.trim() || undefined
    let step: PipelineStep | undefined
    switch (payload.type) {
      case 'click': if (payload.locator) step = { id, type: 'click', label: label || 'Element anklicken', locator: payload.locator }; break
      case 'fill': if (payload.locator) {
        const value: ValueSource = payload.password ? { type: 'credentialField', field: 'password' } : { type: 'literal', value: payload.value ?? '' }
        step = { id, type: 'fill', label: label || 'Text eingeben', locator: payload.locator, value }
      } break
      case 'select': if (payload.locator) step = { id, type: 'select', label: label || 'Auswahl setzen', locator: payload.locator, value: { type: 'literal', value: payload.value ?? '' } }; break
      case 'toggle': if (payload.locator) step = { id, type: 'toggle', label: label || 'Schalter setzen', locator: payload.locator, checked: Boolean(payload.checked) }; break
      case 'press': step = { id, type: 'press', label: `Taste ${payload.key}`, locator: payload.locator, key: payload.key ?? 'Enter' }; break
      case 'extractText': if (payload.locator) {
        const key = this.pendingExtractKey || (label || 'erfasster_wert').toLowerCase().replace(/[^a-z0-9äöüß]+/gi, '_').replace(/^_|_$/g, '') || 'wert'
        const field = this.db.listDataFields().find((item) => item.key === key)
        step = { id, type: 'extractText', label: `Text erfassen: ${field?.label || label || key}`, locator: payload.locator, key, persist: true }
        if (this.current.deviceId && payload.text != null) {
          const device = this.db.setDeviceValue(this.current.deviceId, key, payload.text.trim())
          if (device) this.emit({ type: 'device.updated', device })
        }
        this.pendingExtractKey = undefined
        this.current = { ...this.current, mode: 'record' }
        this.emit({ type: 'recording.status', recording: this.current })
      } break
      case 'upload': if (payload.locator) step = { id, type: 'upload', label: `Datei hochladen${payload.filename ? `: ${payload.filename}` : ''}`, locator: payload.locator, file: { type: 'dataFile', key: '' } }; break
    }
    if (!step) return
    this.saveStep(pipelineId, step)
  }

  private saveStep(pipelineId: string, step: PipelineStep) {
    const index = this.nextInsertIndex
    const updated = this.db.insertPipelineStep(pipelineId, index, step)
    if (!updated) return
    this.lastRecordedIndex = index
    this.nextInsertIndex = index + 1
    this.emit({ type: 'pipeline.updated', pipeline: updated })
  }

  private async replayStep(input: { pipeline: Pipeline; device: Device; page: Page; context: BrowserContext; step: PipelineStep; index: number; values: Record<string, string>; callStack?: string[] }) {
    const { pipeline, device, step, index, values, context } = input
    const page = input.page
    const callStack = input.callStack ?? [pipeline.id]
    page.setDefaultTimeout(this.actionTimeout(step))
    page.setDefaultNavigationTimeout(this.navigationTimeout(step))
    const wait = speedDelay[pipeline.speed]
    const info = { action: step.type, device: device.name, index, total: this.current?.replayTotal ?? input.index + 1, label: step.label || stepNames[step.type] }
    if (step.type === 'navigate') {
      await this.visualize(page, page.locator('body'), info)
      await this.delay(wait)
      await page.goto(this.interpolate(await this.resolveValue(step.url, device, values), device, values), { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout(step) })
      return
    }
    if (step.type === 'runPipelines') {
      if (!step.pipelineIds.length) throw new Error('Im Zwischenablauf wurde keine Automation ausgewählt.')
      await this.visualize(page, page.locator('body'), { ...info, action: 'waiting', label: 'Hauptautomation pausieren …' })
      const existing = new Set(context.pages())
      const nestedPage = await context.newPage()
      const currentUrl = page.url()
      if (/^https?:/i.test(currentUrl)) await nestedPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout(step) })
      try {
        for (const pipelineId of step.pipelineIds) {
          if (callStack.includes(pipelineId)) throw new Error('Dieser Zwischenablauf enthält einen gegenseitigen Aufruf.')
          const nested = this.db.getPipeline(pipelineId)
          if (!nested) throw new Error(`Eingebettete Automation nicht gefunden: ${pipelineId}`)
          for (let nestedIndex = 0; nestedIndex < nested.steps.length; nestedIndex++) {
            const activeNestedPage = [...context.pages()].reverse().find((candidate) => !existing.has(candidate) && !candidate.isClosed()) ?? nestedPage
            await this.replayStep({ pipeline: nested, device, page: activeNestedPage, context, step: nested.steps[nestedIndex], index: nestedIndex, values, callStack: [...callStack, pipelineId] })
          }
        }
      } finally {
        for (const candidate of context.pages()) if (!existing.has(candidate)) await candidate.close().catch(() => {})
        await page.bringToFront()
      }
      return
    }
    if (step.type === 'beginSubflow' || step.type === 'endSubflow') throw new Error('Interne Zwischenablauf-Schritte können nicht aufgenommen werden.')
    if (step.type === 'discoverDevices') throw new Error('Nach einer Gerätesuche kann die Aufnahme nicht mitten im Lauf fortgesetzt werden. Starte dafür eine neue Pipeline.')
    if (step.type === 'mergeAtv') {
      if (!this.temporaryDirectory) throw new Error('Für den ATV-Merge fehlt das temporäre Aufnahmeverzeichnis.')
      await this.visualize(page, page.locator('body'), info)
      const merged = createMergedAtv(step, (file) => file.type === 'localFile'
        ? this.interpolate(file.path, device, values)
        : (values[file.key] && existsSync(values[file.key]) ? values[file.key] : '') || (file.type === 'dataFile'
          ? this.db.getDeviceFile(device.id, file.key)?.path
          : this.db.findLatestArtifactByKey(device.id, file.key)?.path) || '', this.temporaryDirectory)
      values[merged.outputKey] = merged.path
      return
    }
    const spec = 'locator' in step && step.locator ? this.interpolateLocator(step.locator, device, values) : undefined
    if (spec) await this.visualize(page, page.locator('body'), { ...info, action: 'waiting', label: `Warte auf ${info.label} …` })
    const locator = spec
      ? step.type === 'download' && step.match
        ? await resolveLocatorInMatchingContainer(page, spec, await this.resolveDownloadMatch(step.match.source, pipeline, device, values), step.match.containerSelector)
        : await resolveLocator(page, spec)
      : undefined
    if (locator) { await locator.scrollIntoViewIfNeeded(); await this.visualize(page, locator, info) }
    else await this.visualize(page, page.locator('body'), info)
    await this.delay(wait)
    switch (step.type) {
      case 'click': await locator!.click({ timeout: this.actionTimeout(step) }); break
      case 'fill': await locator!.fill(await this.resolveValue(step.value, device, values)); break
      case 'select': await locator!.selectOption(await this.resolveValue(step.value, device, values)); break
      case 'toggle': await locator!.setChecked(step.checked); break
      case 'press': {
        // Keep replayed login submissions from hanging while a target appliance
        // performs its own navigation. The next replayed step waits for its
        // target on the resulting page.
        if (locator) await locator.focus()
        await page.keyboard.press(step.key)
        break
      }
      case 'extractText': values[step.key] = (await locator!.innerText()).trim(); break
      case 'waitFor': if (locator) await locator.waitFor({ state: 'visible', timeout: this.actionTimeout(step) }); else await this.delay(step.milliseconds ?? 1000); break
      case 'download': {
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: this.downloadTimeout(step) }), locator!.click()])
        const target = join(this.temporaryDirectory!, `${step.artifactKey}__${basename(download.suggestedFilename())}`)
        await download.saveAs(target); values[step.artifactKey] = target
        break
      }
      case 'upload': {
        const path = step.file.type === 'localFile'
          ? this.interpolate(step.file.path, device, values)
          : (values[step.file.key] && existsSync(values[step.file.key]) ? values[step.file.key] : '') || (step.file.type === 'dataFile'
            ? this.db.getDeviceFile(device.id, step.file.key)?.path
            : this.db.findLatestArtifactByKey(device.id, step.file.key)?.path) || ''
        if (!path || !existsSync(path)) throw new Error(`Upload-Datei nicht gefunden: ${path || ('key' in step.file ? step.file.key : step.file.path)}`)
        await locator!.setInputFiles(path)
        break
      }
    }
    await this.delay(Math.min(wait, 350))
  }

  private async resolveValue(source: ValueSource, device: Device, values: Record<string, string>) {
    if (source.type === 'literal') return this.interpolate(source.value, device, values)
    if (source.type === 'deviceField') return source.key === 'baseUrl' ? device.baseUrl : source.key === 'name' ? device.name : device.data[source.key] ?? ''
    if (source.type === 'runValue') return values[source.key] ?? ''
    const credential = this.db.getCredential(source.credentialId || device.credentialId || '', true)
    if (!credential) throw new Error('Für dieses Eingabefeld fehlen Zugangsdaten.')
    return source.field === 'password' ? credential.password ?? '' : credential.username
  }

  private async resolveDownloadMatch(source: DownloadMatchSource, pipeline: Pipeline, device: Device, values: Record<string, string>) {
    if (source.type !== 'stepValue') return this.resolveValue(source, device, values)
    const referenced = pipeline.steps.find((step) => step.id === source.stepId)
    if (!referenced || (referenced.type !== 'fill' && referenced.type !== 'select')) throw new Error('Der verknüpfte Eingabeschritt für den Download wurde nicht gefunden.')
    return this.resolveValue(referenced.value, device, values)
  }

  private interpolate(value: string, device: Device, values: Record<string, string>) {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawKey: string) => {
      const key = rawKey.trim()
      if (key === 'device.baseUrl') return device.baseUrl
      if (key === 'device.name') return device.name
      if (key.startsWith('data.')) return values[key.slice(5)] ?? device.data[key.slice(5)] ?? ''
      if (key.startsWith('result.')) return values[key.slice(7)] ?? ''
      return values[key] ?? ''
    })
  }

  private interpolateLocator(spec: LocatorSpec, device: Device, values: Record<string, string>): LocatorSpec {
    return {
      ...spec,
      description: spec.description ? this.interpolate(spec.description, device, values) : undefined,
      candidates: spec.candidates.map((candidate) => ({
        ...candidate,
        value: this.interpolate(candidate.value, device, values),
        name: candidate.name ? this.interpolate(candidate.name, device, values) : undefined,
      })),
    }
  }

  private async visualize(page: Page, locator: Locator, info: Record<string, unknown>) {
    await locator.evaluate((element, detail) => (window as unknown as { __ascVisualize?: (element: Element, info: unknown) => void }).__ascVisualize?.(element, detail), info)
  }

  private delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)) }
}
