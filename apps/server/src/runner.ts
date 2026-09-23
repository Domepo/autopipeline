import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Device, DiscoveryCollectionLevel, DownloadMatchSource, FileSource, Pipeline, PipelineStep, Run, RunLog, SocketEvent, ValueSource } from '@autosecure/shared'
import { speedDelay, stepNames } from '@autosecure/shared'
import { appDb, type AppDatabase } from './database.ts'
import { visualizerClientScript } from './browser-scripts.ts'
import { describeLocator, resolveLocator, resolveLocatorAll, resolveLocatorInMatchingContainer, resolveLocatorWithin } from './locator.ts'
import { expandPipelineCalls } from './pipeline-expansion.ts'
import { createMergedAtv } from './atv-merge.ts'
import { launchChromium } from './browser.ts'

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

  private actionTimeout(step: PipelineStep) { return step.timeoutMs ?? this.db.getSettings().actionTimeoutMs }
  private navigationTimeout(step: PipelineStep) { return step.timeoutMs ?? this.db.getSettings().navigationTimeoutMs }
  private downloadTimeout(step: PipelineStep) { return step.timeoutMs ?? this.db.getSettings().downloadTimeoutMs }

  start(pipelineId: string, deviceIds: string[]): Run {
    const pipeline = this.db.getPipeline(pipelineId)
    if (!pipeline) throw new Error('Pipeline nicht gefunden.')
    const expanded = expandPipelineCalls(pipeline, (id) => this.db.getPipeline(id))
    const discoverySteps = expanded.steps.filter((step): step is Extract<PipelineStep, { type: 'discoverDevices' }> => step.type === 'discoverDevices')
    if (discoverySteps.length) {
      const sourceIds = [...new Set(discoverySteps.map((step) => step.sourceDeviceId).filter((id): id is string => Boolean(id)))]
      if (!sourceIds.length) throw new Error('Wähle im Schritt „Geräte entdecken“ zuerst ein Quellgerät aus.')
      if (sourceIds.length > 1) throw new Error('Eine Discovery-Pipeline kann nur ein gemeinsames Quellgerät verwenden.')
      if (!this.db.getDevice(sourceIds[0])) throw new Error('Das Quellgerät der Discovery-Pipeline wurde nicht gefunden.')
      return this.enqueue(expanded, sourceIds)
    }
    if (!deviceIds.length) throw new Error('Bitte mindestens ein Gerät auswählen.')
    return this.enqueue(expanded, deviceIds)
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
      steps: [{ id: randomUUID(), type: 'runPipelines', pipelineIds: available.map((item) => item.id), label: 'Geräteablauf' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const expanded = expandPipelineCalls(pipeline, (id) => this.db.getPipeline(id))
    if (!expanded.steps.length) throw new Error('Die zugeordneten Pipelines enthalten keine Schritte.')
    return this.enqueue(expanded, [device.id])
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
    const subflowPages: Array<{ parent: Page; existing: Set<Page> }> = []
    const values: Record<string, string> = { ...device.data }
    try {
      this.updateRun(runId, { status: 'running', currentDeviceId: device.id, currentStep: 0, error: null })
      this.log(runId, { deviceId: device.id, level: 'info', message: `Gerät „${device.name}“ wird geöffnet.` })
      browser = await launchChromium()
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
            const activePage = await this.executeStep({ runId, pipeline, device, page, context, step, index, values, subflowPages })
            if (activePage) page = activePage
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

  private resolveFileSource(file: FileSource, runId: string, device: Device, values: Record<string, string>): string {
    if (file.type === 'localFile') return this.interpolate(file.path, device, values)
    if (file.type === 'dataFile') return this.db.getDeviceFile(device.id, file.key)?.path ?? ''
    return (values[file.key] && existsSync(values[file.key]) ? values[file.key] : '')
      || this.db.findArtifactByKey(runId, device.id, file.key)?.path
      || this.db.findLatestArtifactByKey(device.id, file.key)?.path
      || ''
  }

  private async executeStep(input: { runId: string; pipeline: Pipeline; device: Device; page: Page; context: BrowserContext; step: PipelineStep; index: number; values: Record<string,string>; subflowPages: Array<{ parent: Page; existing: Set<Page> }> }): Promise<Page | undefined> {
    const { runId, pipeline, device, step, index, values, context } = input
    let page = input.page
    page.setDefaultTimeout(this.actionTimeout(step))
    page.setDefaultNavigationTimeout(this.navigationTimeout(step))
    const wait = speedDelay[step.playbackSpeed ?? pipeline.speed]
    const info = { action: step.type, device: device.name, index, total: pipeline.steps.length, label: step.label || stepNames[step.type] }

    if (step.type === 'navigate') {
      await this.visualize(page, page.locator('body'), info)
      const url = await this.resolveValue(step.url, device, values)
      await delay(wait)
      await page.goto(this.interpolate(url, device, values), { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout(step) })
      return page
    }

    if (step.type === 'discoverDevices') {
      await this.executeDiscovery({ runId, pipeline, device, page, step, index, values, wait })
      return page
    }

    if (step.type === 'runPipelines') throw new Error('Der Zwischenablauf konnte vor dem Lauf nicht aufgelöst werden.')

    if (step.type === 'mergeAtv') {
      await this.visualize(page, page.locator('body'), info)
      const merged = createMergedAtv(step, (file) => this.resolveFileSource(file, runId, device, values), this.db.getArtifactDirectory(runId, device.id))
      try {
        this.db.addArtifact({ runId, deviceId: device.id, stepIndex: index, artifactKey: merged.outputKey, name: merged.outputName, path: merged.path, kind: 'download', mimeType: 'text/plain' })
      } catch (error) { unlinkSync(merged.path); throw error }
      values[merged.outputKey] = merged.path
      this.log(runId, { deviceId: device.id, stepIndex: index, level: 'info', message: `Vorläufiger ATV-Merge: ${merged.retained} Abschnitte aus A behalten, ${merged.replaced} durch B ersetzt, ${merged.added} aus B ergänzt. Ergebnis: ${merged.outputName}.` })
      return page
    }

    const spec = 'locator' in step && step.locator ? this.interpolateLocator(step.locator, device, values) : undefined
    if (spec) await this.visualize(page, page.locator('body'), { ...info, action: 'waiting', label: `Warte auf ${info.label} …` })
    const locator = spec
      ? step.type === 'download' && step.match
        ? await resolveLocatorInMatchingContainer(page, spec, await this.resolveDownloadMatch(step.match.source, pipeline, device, values), step.match.containerSelector)
        : await resolveLocator(page, spec)
      : undefined
    if (locator) {
      await locator.scrollIntoViewIfNeeded()
      await this.visualize(page, locator, info)
    } else {
      await this.visualize(page, page.locator('body'), info)
    }
    await delay(wait)

    switch (step.type) {
      case 'beginSubflow': {
        const existing = new Set(context.pages())
        input.subflowPages.push({ parent: page, existing })
        const nestedPage = await context.newPage()
        const currentUrl = page.url()
        if (/^https?:/i.test(currentUrl)) await nestedPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeout(step) })
        await nestedPage.bringToFront()
        await delay(Math.min(wait, 350))
        return nestedPage
      }
      case 'endSubflow': {
        const checkpoint = input.subflowPages.pop()
        if (!checkpoint) throw new Error(`Für „${step.pipelineName}“ fehlt der pausierte Hauptablauf.`)
        for (const candidate of context.pages()) if (!checkpoint.existing.has(candidate)) await candidate.close().catch(() => {})
        await checkpoint.parent.bringToFront()
        await delay(Math.min(wait, 350))
        return checkpoint.parent
      }
      case 'click': {
        const pageCount = context.pages().length
        await locator!.click({ timeout: this.actionTimeout(step) })
        await delay(250)
        if (context.pages().length > pageCount) page = context.pages().at(-1)!
        break
      }
      case 'fill': await locator!.fill(await this.resolveValue(step.value, device, values)); break
      case 'select': await locator!.selectOption(await this.resolveValue(step.value, device, values)); break
      case 'toggle': await locator!.setChecked(step.checked); break
      case 'press': {
        // locator.press() waits for a navigation started by the key press. Some
        // appliance login pages never signal that navigation as finished even
        // though the form was submitted successfully. Focus the recorded field
        // first, then dispatch the key at page level so the following pipeline
        // step can use Playwright's normal auto-waiting on the destination page.
        if (locator) await locator.focus()
        await page.keyboard.press(step.key)
        break
      }
      case 'extractText': {
        const value = (await locator!.innerText()).trim()
        values[step.key] = value
        if (step.persist) this.db.setDeviceValue(device.id, step.key, value)
        break
      }
      case 'waitFor': if (locator) await locator.waitFor({ state: 'visible', timeout: this.actionTimeout(step) }); else await delay(step.milliseconds ?? 1000); break
      case 'download': {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(step.artifactKey)) throw new Error('Der Name der Dateivariable ist ungültig.')
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: this.downloadTimeout(step) }),
          locator!.click(),
        ])
        const original = safeName(download.suggestedFilename())
        const filename = `${safeName(step.artifactKey)}__${original}`
        const target = join(this.db.getArtifactDirectory(runId, device.id), filename)
        await download.saveAs(target)
        try { this.db.addArtifact({ runId, deviceId: device.id, stepIndex: index, artifactKey: step.artifactKey, name: original, path: target, kind: 'download' }) }
        catch (error) { unlinkSync(target); throw error }
        values[step.artifactKey] = target
        break
      }
      case 'upload': {
        const path = this.resolveFileSource(step.file, runId, device, values)
        const sourceDescription = step.file.type === 'localFile' ? step.file.path : step.file.key
        if (!path || !existsSync(path)) throw new Error(`Upload-Datei nicht gefunden: ${path || sourceDescription || 'kein Pfad'}`)
        await locator!.setInputFiles(path)
        break
      }
    }
    await delay(Math.min(wait, 350))
    return page
  }

  private async executeDiscovery(input: {
    runId: string
    pipeline: Pipeline
    device: Device
    page: Page
    step: Extract<PipelineStep, { type: 'discoverDevices' }>
    index: number
    values: Record<string, string>
    wait: number
  }) {
    const { runId, pipeline, device, page, step, index, values, wait } = input
    const records: Array<{ name: string; baseUrl: string; data: Record<string, string> }> = []
    let skipped = 0

    const clickVisible = async (locator: Locator, label: string) => {
      await locator.waitFor({ state: 'visible', timeout: this.actionTimeout(step) })
      await locator.scrollIntoViewIfNeeded()
      await this.visualize(page, locator, { action: 'click', device: device.name, index, total: pipeline.steps.length, label })
      await delay(wait)
      await locator.click({ timeout: this.actionTimeout(step) })
      await delay(Math.min(wait, 500))
    }

    const scanRecords = async (contextValues: Record<string, string>) => {
      const initial = await resolveLocatorAll(page, step.record.items)
      await initial.first().waitFor({ state: 'visible', timeout: this.actionTimeout(step) })
      const count = await initial.count()
      this.log(runId, { deviceId: device.id, stepIndex: index, level: 'info', message: `${count} Einträge in „${describeLocator(step.record.items)}“ gefunden.` })
      for (let recordIndex = 0; recordIndex < count; recordIndex++) {
        const items = await resolveLocatorAll(page, step.record.items)
        const item = items.nth(recordIndex)
        const name = (await (await resolveLocatorWithin(item, step.record.name)).innerText()).trim()
        await clickVisible(await resolveLocatorWithin(item, step.record.open), `${name} öffnen`)
        for (const action of step.record.afterOpen) await clickVisible(await resolveLocator(page, action), describeLocator(action))

        const found: Record<string, string> = { ...contextValues, name }
        for (const field of step.record.fields) {
          const locator = await resolveLocator(page, field.locator)
          if (await locator.count()) found[field.key] = (await locator.innerText()).trim()
          else if (field.required) throw new Error(`Pflichtfeld „${field.label}“ wurde bei „${name}“ nicht gefunden.`)
          else found[field.key] = ''
        }

        const address = found[step.addressKey]?.trim() ?? ''
        const correctType = !step.requiredTypeKey || !step.requiredTypeValue || found[step.requiredTypeKey]?.trim() === step.requiredTypeValue.trim()
        if (!address || !correctType) {
          skipped++
          const reason = !address ? 'keine Adresse' : `Typ ist nicht „${step.requiredTypeValue}“`
          this.log(runId, { deviceId: device.id, stepIndex: index, level: 'warning', message: `„${name}“ übersprungen: ${reason}.` })
        } else {
          const baseUrl = this.interpolate(step.baseUrlTemplate, device, { ...values, ...found })
          try { new URL(baseUrl) } catch { throw new Error(`Aus „${address}“ wurde keine gültige Start-URL: ${baseUrl}`) }
          const data = Object.fromEntries(Object.entries(found).filter(([key]) => key !== 'name'))
          records.push({ name, baseUrl, data })
          this.log(runId, { deviceId: device.id, stepIndex: index, level: 'success', message: `„${name}“ erkannt · ${baseUrl}` })
        }

        if (step.record.close) await clickVisible(await resolveLocator(page, step.record.close), 'Details schließen')
      }
    }

    const leaveCollection = async (level: DiscoveryCollectionLevel) => {
      if (level.leave.type === 'back') {
        await this.visualize(page, page.locator('body'), { action: 'navigate', device: device.name, index, total: pipeline.steps.length, label: `${level.label} verlassen` })
        await delay(wait)
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: this.navigationTimeout(step) })
        await delay(Math.min(wait, 500))
      } else {
        await clickVisible(await resolveLocator(page, level.leave.locator), `${level.label} verlassen`)
      }
    }

    const walk = async (depth: number, contextValues: Record<string, string>): Promise<void> => {
      if (depth >= step.collections.length) return scanRecords(contextValues)
      const level = step.collections[depth]
      const initial = await resolveLocatorAll(page, level.items)
      await initial.first().waitFor({ state: 'visible', timeout: this.actionTimeout(step) })
      const count = await initial.count()
      this.log(runId, { deviceId: device.id, stepIndex: index, level: 'info', message: `${count} ${level.label} gefunden.` })
      for (let itemIndex = 0; itemIndex < count; itemIndex++) {
        const items = await resolveLocatorAll(page, level.items)
        const item = items.nth(itemIndex)
        const label = level.itemLabel ? (await (await resolveLocatorWithin(item, level.itemLabel)).innerText()).trim() : `${level.label} ${itemIndex + 1}`
        const opener = level.open ? await resolveLocatorWithin(item, level.open) : item
        await clickVisible(opener, `${label} öffnen`)
        await walk(depth + 1, { ...contextValues, [level.id]: label })
        await leaveCollection(level)
      }
    }

    await walk(0, {})
    if (!step.apply) {
      this.log(runId, { deviceId: device.id, stepIndex: index, level: 'info', message: `Vorschau abgeschlossen: ${records.length} Geräte erkannt, ${skipped} übersprungen. Es wurde nichts gespeichert.` })
      return
    }
    const result = this.db.upsertDiscoveredDevices(records, step.duplicatePolicy)
    for (const updated of result.devices) this.emit({ type: 'device.updated', device: updated })
    this.log(runId, {
      deviceId: device.id,
      stepIndex: index,
      level: 'success',
      message: `Übernahme abgeschlossen: ${result.created} neu, ${result.updated} aktualisiert, ${result.duplicates} Duplikate zusammengeführt, ${skipped} übersprungen.`,
    })
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

  private async resolveDownloadMatch(source: DownloadMatchSource, pipeline: Pipeline, device: Device, values: Record<string, string>) {
    if (source.type !== 'stepValue') return this.resolveValue(source, device, values)
    const referenced = pipeline.steps.find((step) => step.id === source.stepId)
    if (!referenced || (referenced.type !== 'fill' && referenced.type !== 'select')) throw new Error('Der verknüpfte Eingabeschritt für den Download wurde nicht gefunden.')
    return this.resolveValue(referenced.value, device, values)
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

  private interpolateLocator(spec: import('@autosecure/shared').LocatorSpec, device: Device, values: Record<string, string>) {
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
