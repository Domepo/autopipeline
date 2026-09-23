import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import type { SocketEvent } from '@autosecure/shared'
import { appDb } from './database.ts'
import { AutomaticBackupService } from './automatic-backup.ts'
import { RecorderService } from './recorder.ts'
import { RunnerService } from './runner.ts'
import { host, isProduction, port } from './config.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  'http://127.0.0.1:5173',
  'http://localhost:5173',
])
const allowedHosts = new Set(['127.0.0.1', 'localhost'])
if (!isProduction && process.env.ASC_DEV_LAN === '1') {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal ||
        !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) continue
      allowedHosts.add(address.address)
      allowedOrigins.add(`http://${address.address}:5173`)
    }
  }
}
const allowedRequestHosts = new Set(
  [...allowedHosts].flatMap((hostname) => [`${hostname}:${port}`, `${hostname}:5173`]),
)
await app.register(cors, { origin: [...allowedOrigins] })
await app.register(websocket)
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })

app.addHook('onRequest', async (request, reply) => {
  const requestHost = request.headers.host ?? ''
  if (!allowedRequestHosts.has(requestHost)) {
    return reply.code(403).send({ message: 'Ungültiger Host.' })
  }
  const origin = request.headers.origin
  if (origin && !allowedOrigins.has(origin)) {
    return reply.code(403).send({ message: 'Ungültige Anfrageherkunft.' })
  }
})
app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Referrer-Policy', 'no-referrer')
  return payload
})

const clients = new Set<{ readyState: number; send: (value: string) => void }>()
const emit = (event: SocketEvent) => {
  const payload = JSON.stringify(event)
  for (const client of clients) if (client.readyState === 1) client.send(payload)
}

const recorder = new RecorderService(appDb, emit)
const runner = new RunnerService(appDb, emit)

app.get('/ws', { websocket: true }, (socket) => {
  clients.add(socket)
  socket.send(JSON.stringify({ type: 'snapshot', recording: recorder.status() } satisfies SocketEvent))
  socket.on('close', () => clients.delete(socket))
})

app.get('/api/health', async () => ({ ok: true, recording: recorder.status() }))

const workspaceBusy = () => Boolean(recorder.status()) || appDb.listRuns().some((run) => ['queued', 'running', 'paused'].includes(run.status))
const automaticBackups = new AutomaticBackupService(appDb, workspaceBusy)
app.get('/api/backup', async (_request, reply) => {
  if (workspaceBusy()) return reply.code(409).send({ message: 'Beende laufende Aufnahmen und Geräteabläufe vor dem Backup.' })
  try {
    const buffer = appDb.exportBackup()
    reply.type('application/gzip').header('Content-Disposition', `attachment; filename="autosecurecloud-backup-${new Date().toISOString().slice(0, 10)}.asc.gz"`)
    return reply.send(buffer)
  } catch (error) { return reply.code(500).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.get('/api/backup/automatic', async () => automaticBackups.list())
app.get('/api/backup/automatic/:name', async (request, reply) => {
  const name = (request.params as { name: string }).name
  const data = automaticBackups.read(name)
  if (!data) return reply.code(404).send({ message: 'Backup nicht gefunden.' })
  return reply.type('application/gzip').header('Content-Disposition', `attachment; filename="${name}"`).send(data)
})
app.post('/api/backup/automatic/:name/restore', async (request, reply) => {
  if (workspaceBusy()) return reply.code(409).send({ message: 'Beende laufende Aufnahmen und Geräteabläufe vor der Wiederherstellung.' })
  const data = automaticBackups.read((request.params as { name: string }).name)
  if (!data) return reply.code(404).send({ message: 'Backup nicht gefunden.' })
  try {
    const result = appDb.restoreBackup(data)
    emit({ type: 'workspace.restored' })
    return result
  } catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.post('/api/backup/restore', async (request, reply) => {
  if (workspaceBusy()) return reply.code(409).send({ message: 'Beende laufende Aufnahmen und Geräteabläufe vor der Wiederherstellung.' })
  try {
    const file = await request.file({ limits: { fileSize: 250 * 1024 * 1024, files: 1 } })
    if (!file) return reply.code(400).send({ message: 'Bitte eine Backup-Datei auswählen.' })
    const result = appDb.restoreBackup(await file.toBuffer())
    emit({ type: 'workspace.restored' })
    return result
  } catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})

app.post('/api/workspace/clear', async (request, reply) => {
  if (workspaceBusy()) return reply.code(409).send({ message: 'Beende laufende Aufnahmen und Geräteabläufe vor dem Löschen.' })
  const body = request.body as { confirmation?: unknown } | null
  if (body?.confirmation !== 'ARBEITSBEREICH LÖSCHEN') return reply.code(400).send({ message: 'Bitte das Löschen ausdrücklich bestätigen.' })
  try {
    const result = appDb.clearWorkspace()
    automaticBackups.resetRetryDelay()
    emit({ type: 'workspace.cleared' })
    return result
  } catch (error) { return reply.code(500).send({ message: error instanceof Error ? error.message : String(error) }) }
})

app.get('/api/settings', async () => appDb.getSettings())
app.patch('/api/settings', async (request, reply) => {
  const body = request.body as { title?: unknown; subtitle?: unknown } | null
  if (typeof body?.title !== 'string' || !body.title.trim() || body.title.trim().length > 80 ||
      typeof body.subtitle !== 'string' || body.subtitle.trim().length > 160) {
    return reply.code(400).send({ message: 'Titel (1–80 Zeichen) und Untertitel (maximal 160 Zeichen) prüfen.' })
  }
  return appDb.updateSettings(body.title.trim(), body.subtitle.trim())
})
app.patch('/api/settings/execution', async (request, reply) => {
  const body = request.body as { actionTimeoutMs?: unknown; navigationTimeoutMs?: unknown; downloadTimeoutMs?: unknown } | null
  const values = [body?.actionTimeoutMs, body?.navigationTimeoutMs, body?.downloadTimeoutMs]
  if (values.some((value) => !Number.isInteger(value) || (value as number) < 1_000 || (value as number) > 180_000)) {
    return reply.code(400).send({ message: 'Alle Zeitlimits müssen zwischen 1 und 180 Sekunden liegen.' })
  }
  return appDb.updateExecutionSettings(values[0] as number, values[1] as number, values[2] as number)
})
app.patch('/api/settings/automatic-backup', async (request, reply) => {
  const body = request.body as { interval?: unknown; retention?: unknown } | null
  if (!['off', 'daily', 'weekly'].includes(String(body?.interval)) || !Number.isInteger(body?.retention) || (body?.retention as number) < 1 || (body?.retention as number) > 30) {
    return reply.code(400).send({ message: 'Intervall und Aufbewahrung (1–30 Backups) prüfen.' })
  }
  const wasOff = appDb.getSettings().automaticBackupInterval === 'off'
  appDb.updateAutomaticBackupSettings(body!.interval as 'off' | 'daily' | 'weekly', body!.retention as number)
  if (wasOff && body!.interval !== 'off') automaticBackups.resetRetryDelay()
  automaticBackups.check()
  automaticBackups.prune(body!.retention as number)
  return appDb.getSettings()
})
app.get('/api/settings/logo', async (_request, reply) => {
  const logo = appDb.getLogo()
  if (!logo) return reply.code(404).send({ message: 'Kein Logo hinterlegt.' })
  return reply.type(logo.mimeType).header('Cache-Control', 'no-store').send(logo.data)
})
app.post('/api/settings/logo', async (request, reply) => {
  try {
    const file = await request.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } })
    if (!file) return reply.code(400).send({ message: 'Bitte eine Bilddatei auswählen.' })
    const data = await file.toBuffer()
    const mimeType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
      : null
    if (!mimeType) return reply.code(400).send({ message: 'Bitte ein PNG-, JPG- oder WebP-Bild auswählen.' })
    return appDb.setLogo(data, mimeType)
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error && error.message.includes('file size') ? 'Das Logo darf höchstens 2 MB groß sein.' : 'Das Logo konnte nicht hochgeladen werden.' })
  }
})
app.delete('/api/settings/logo', async () => appDb.setLogo(null, null))

app.get('/api/credentials', async () => appDb.listCredentials())
app.get('/api/credentials/:id/secret', async (request, reply) => {
  const credential = appDb.getCredential((request.params as { id: string }).id, true)
  if (!credential) return reply.code(404).send({ message: 'Zugangsdatenprofil nicht gefunden.' })
  return { password: credential.password ?? '' }
})
app.post('/api/credentials', async (request, reply) => {
  const body = request.body as { name?: string; username?: string; password?: string }
  if (!body?.name?.trim()) return reply.code(400).send({ message: 'Name ist erforderlich.' })
  const credential = appDb.createCredential({ name: body.name.trim(), username: body.username, password: body.password })
  emit({ type: 'data.changed' })
  return reply.code(201).send(credential)
})
app.patch('/api/credentials/:id', async (request, reply) => {
  const result = appDb.updateCredential((request.params as { id: string }).id, request.body as never)
  if (result) emit({ type: 'data.changed' })
  return result ?? reply.code(404).send({ message: 'Zugangsdatenprofil nicht gefunden.' })
})
app.delete('/api/credentials/:id', async (request, reply) => {
  const deleted = appDb.deleteCredential((request.params as { id: string }).id)
  if (deleted) emit({ type: 'data.changed' })
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Zugangsdatenprofil nicht gefunden.' })
})

app.get('/api/devices', async () => appDb.listDevices())
app.post('/api/devices/bulk-automation', async (request, reply) => {
  const body = request.body as { pipelineId?: string; deviceIds?: string[] }
  if (typeof body?.pipelineId !== 'string' || !body.pipelineId || !Array.isArray(body.deviceIds) || !body.deviceIds.length || body.deviceIds.some((id) => typeof id !== 'string')) {
    return reply.code(400).send({ message: 'Wähle eine Automation und mindestens ein Gerät aus.' })
  }
  if (!appDb.getPipeline(body.pipelineId)) return reply.code(404).send({ message: 'Automation nicht gefunden.' })
  if (body.deviceIds.some((id) => !appDb.getDevice(id))) return reply.code(404).send({ message: 'Mindestens ein Gerät wurde nicht gefunden.' })
  const result = appDb.addPipelineToDevices(body.pipelineId, body.deviceIds)!
  if (result.added) emit({ type: 'data.changed' })
  return { added: result.added, skipped: result.devices.length - result.added, devices: result.devices }
})
app.post('/api/devices/bulk-credentials', async (request, reply) => {
  const body = request.body as { credentialId?: string; deviceIds?: string[] }
  if (typeof body?.credentialId !== 'string' || !body.credentialId || !Array.isArray(body.deviceIds) || !body.deviceIds.length || body.deviceIds.some((id) => typeof id !== 'string' || !id)) {
    return reply.code(400).send({ message: 'Wähle ein Zugangsdatenprofil und mindestens ein Gerät aus.' })
  }
  if (!appDb.getCredential(body.credentialId)) return reply.code(404).send({ message: 'Zugangsdatenprofil nicht gefunden.' })
  if (body.deviceIds.some((id) => !appDb.getDevice(id))) return reply.code(404).send({ message: 'Mindestens ein Gerät wurde nicht gefunden.' })
  const result = appDb.assignCredentialToDevices(body.credentialId, body.deviceIds)!
  if (result.updated) emit({ type: 'data.changed' })
  return { updated: result.updated, unchanged: result.devices.length - result.updated, devices: result.devices }
})
app.get('/api/devices/:id/artifacts', async (request, reply) => {
  const deviceId = (request.params as { id: string }).id
  if (!appDb.getDevice(deviceId)) return reply.code(404).send({ message: 'Gerät nicht gefunden.' })
  return appDb.listArtifactsForDevice(deviceId)
})
app.get('/api/artifacts', async () => appDb.listDownloadArtifacts())
app.post('/api/devices', async (request, reply) => {
  const body = request.body as { name?: string; baseUrl?: string; credentialId?: string; ignoreHttpsErrors?: boolean; data?: Record<string,string>; pipelineIds?: string[] }
  if (!body?.name?.trim() || !body?.baseUrl?.trim()) return reply.code(400).send({ message: 'Name und Start-URL sind erforderlich.' })
  try { new URL(body.baseUrl) } catch { return reply.code(400).send({ message: 'Die Start-URL ist ungültig.' }) }
  if (body.pipelineIds?.some((id) => !appDb.getPipeline(id))) return reply.code(400).send({ message: 'Mindestens eine Pipeline wurde nicht gefunden.' })
  const device = appDb.createDevice({ ...body, name: body.name.trim(), baseUrl: body.baseUrl.trim() } as Parameters<typeof appDb.createDevice>[0])
  emit({ type: 'data.changed' })
  return reply.code(201).send(device)
})
app.post('/api/devices/:id/credentials', async (request, reply) => {
  const body = request.body as { username?: unknown; password?: unknown } | null
  if (typeof body?.username !== 'string' || !body.username.trim() || typeof body.password !== 'string' || !body.password.trim()) {
    return reply.code(400).send({ message: 'Benutzername und Passwort sind erforderlich.' })
  }
  const result = appDb.createCredentialForDevice((request.params as { id: string }).id, { username: body.username.trim(), password: body.password })
  if (!result) return reply.code(404).send({ message: 'Gerät nicht gefunden.' })
  emit({ type: 'data.changed' })
  return reply.code(201).send(result)
})
app.patch('/api/devices/:id', async (request, reply) => {
  const body = request.body as { pipelineIds?: string[] }
  if (body.pipelineIds?.some((pipelineId) => !appDb.getPipeline(pipelineId))) return reply.code(400).send({ message: 'Mindestens eine Pipeline wurde nicht gefunden.' })
  const result = appDb.updateDevice((request.params as { id: string }).id, body as never)
  if (result) emit({ type: 'data.changed' })
  return result ?? reply.code(404).send({ message: 'Gerät nicht gefunden.' })
})
app.post('/api/devices/:id/duplicate', async (request, reply) => {
  const source = appDb.getDevice((request.params as { id: string }).id)
  if (!source) return reply.code(404).send({ message: 'Gerät nicht gefunden.' })
  const body = request.body as { name?: string; baseUrl?: string }
  if (!body?.name?.trim() || !body?.baseUrl?.trim()) return reply.code(400).send({ message: 'Name und Start-URL sind erforderlich.' })
  try { new URL(body.baseUrl) } catch { return reply.code(400).send({ message: 'Die Start-URL ist ungültig.' }) }
  const copy = appDb.createDevice({
    name: body.name.trim(), baseUrl: body.baseUrl.trim(), credentialId: source.credentialId,
    ignoreHttpsErrors: source.ignoreHttpsErrors, pipelineIds: source.pipelineIds, data: {},
  })
  emit({ type: 'data.changed' })
  return reply.code(201).send(copy)
})
app.post('/api/devices/:id/run', async (request, reply) => {
  try { return reply.code(201).send(runner.startDevicePlan((request.params as { id: string }).id)) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.delete('/api/devices/:id', async (request, reply) => {
  const deleted = appDb.deleteDevice((request.params as { id: string }).id)
  if (deleted) emit({ type: 'data.changed' })
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Gerät nicht gefunden.' })
})

app.get('/api/pipeline-groups', async () => appDb.listPipelineGroups())
app.post('/api/pipeline-groups', async (request, reply) => {
  const body = request.body as { name?: string; description?: string; pipelineIds?: string[] }
  if (!body?.name?.trim()) return reply.code(400).send({ message: 'Name ist erforderlich.' })
  if (!body.pipelineIds?.length) return reply.code(400).send({ message: 'Die Vorlage benötigt mindestens eine Automation.' })
  if (body.pipelineIds.some((id) => !appDb.getPipeline(id))) return reply.code(400).send({ message: 'Mindestens eine Automation wurde nicht gefunden.' })
  return reply.code(201).send(appDb.createPipelineGroup({ name: body.name.trim(), description: body.description?.trim(), pipelineIds: body.pipelineIds }))
})
app.patch('/api/pipeline-groups/:id', async (request, reply) => {
  const body = request.body as { name?: string; description?: string; pipelineIds?: string[] }
  if (body.pipelineIds?.some((id) => !appDb.getPipeline(id))) return reply.code(400).send({ message: 'Mindestens eine Automation wurde nicht gefunden.' })
  const result = appDb.updatePipelineGroup((request.params as { id: string }).id, body)
  return result ?? reply.code(404).send({ message: 'Ablaufvorlage nicht gefunden.' })
})
app.post('/api/pipeline-groups/:id/apply', async (request, reply) => {
  const body = request.body as { deviceIds?: string[] }
  if (!body.deviceIds?.length) return reply.code(400).send({ message: 'Wähle mindestens ein Gerät aus.' })
  if (body.deviceIds.some((id) => !appDb.getDevice(id))) return reply.code(400).send({ message: 'Mindestens ein Gerät wurde nicht gefunden.' })
  const result = appDb.applyPipelineGroup((request.params as { id: string }).id, body.deviceIds)
  return result ?? reply.code(404).send({ message: 'Ablaufvorlage nicht gefunden.' })
})
app.delete('/api/pipeline-groups/:id', async (request, reply) => {
  const deleted = appDb.deletePipelineGroup((request.params as { id: string }).id)
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Ablaufvorlage nicht gefunden.' })
})

app.get('/api/data-fields', async () => appDb.listDataFields())
app.post('/api/data-fields', async (request, reply) => {
  const body = request.body as { label?: string; key?: string; type?: 'text' | 'number' | 'date' | 'url' | 'file' }
  if (!body?.label?.trim()) return reply.code(400).send({ message: 'Eine Spaltenbezeichnung ist erforderlich.' })
  const field = appDb.createDataField({ label: body.label, key: body.key, type: body.type })
  emit({ type: 'data.changed' })
  return reply.code(201).send(field)
})
app.patch('/api/data-fields/:id', async (request, reply) => {
  const result = appDb.updateDataField((request.params as { id: string }).id, request.body as never)
  if (result) emit({ type: 'data.changed' })
  return result ?? reply.code(404).send({ message: 'Datenspalte nicht gefunden.' })
})
app.delete('/api/data-fields/:id', async (request, reply) => {
  const deleted = appDb.deleteDataField((request.params as { id: string }).id)
  if (deleted) emit({ type: 'data.changed' })
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Datenspalte nicht gefunden.' })
})

app.get('/api/pipelines', async () => appDb.listPipelines())
app.post('/api/pipelines', async (request, reply) => {
  const body = request.body as { name?: string; description?: string }
  if (!body?.name?.trim()) return reply.code(400).send({ message: 'Name ist erforderlich.' })
  return reply.code(201).send(appDb.createPipeline({ name: body.name.trim(), description: body.description }))
})
app.patch('/api/pipelines/:id', async (request, reply) => {
  const result = appDb.updatePipeline((request.params as { id: string }).id, request.body as never)
  return result ?? reply.code(404).send({ message: 'Pipeline nicht gefunden.' })
})
app.post('/api/pipelines/:id/duplicate', async (request, reply) => {
  const body = request.body as { name?: string } | undefined
  const result = appDb.duplicatePipeline((request.params as { id: string }).id, body?.name)
  return result ? reply.code(201).send(result) : reply.code(404).send({ message: 'Pipeline nicht gefunden.' })
})
app.delete('/api/pipelines/:id', async (request, reply) => {
  const deleted = appDb.deletePipeline((request.params as { id: string }).id)
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Pipeline nicht gefunden.' })
})

app.post('/api/recordings/start', async (request, reply) => {
  try { return await recorder.start(request.body as { pipelineId: string; deviceId?: string; url?: string; ignoreHttpsErrors?: boolean }) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.post('/api/recordings/continue', async (request, reply) => {
  try { return await recorder.continueFrom(request.body as { pipelineId: string; deviceId: string; afterStepIndex: number }) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.post('/api/recordings/extract', async (request, reply) => {
  try { return await recorder.setExtractMode((request.body as { key?: string } | undefined)?.key) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.post('/api/recordings/stop', async () => { await recorder.stop(); return { ok: true } })

app.get('/api/runs', async () => appDb.listRuns())
app.get('/api/runs/:id', async (request, reply) => appDb.getRun((request.params as { id: string }).id, true) ?? reply.code(404).send({ message: 'Lauf nicht gefunden.' }))
app.post('/api/runs', async (request, reply) => {
  const body = request.body as { pipelineId?: string; deviceIds?: string[] }
  try { return reply.code(201).send(runner.start(body.pipelineId ?? '', body.deviceIds ?? [])) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
for (const [path, handler] of [
  ['pause', () => runner.pause.bind(runner)],
  ['resume', () => runner.resume.bind(runner)],
] as const) {
  app.post(`/api/runs/:id/${path}`, async (request, reply) => {
    try { handler()((request.params as { id: string }).id); return { ok: true } }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
  })
}
app.post('/api/runs/:id/retry', async (request, reply) => { try { runner.failureAction((request.params as { id: string }).id, 'retry'); return { ok: true } } catch (error) { return reply.code(400).send({ message: String(error) }) } })
app.post('/api/runs/:id/skip', async (request, reply) => { try { runner.failureAction((request.params as { id: string }).id, 'skip'); return { ok: true } } catch (error) { return reply.code(400).send({ message: String(error) }) } })
app.post('/api/runs/:id/stop', async (request, reply) => { try { runner.stop((request.params as { id: string }).id); return { ok: true } } catch (error) { return reply.code(400).send({ message: String(error) }) } })
app.delete('/api/runs/:id', async (request, reply) => { runner.removeRun((request.params as { id: string }).id); return reply.code(204).send() })

app.get('/api/artifacts/:id', async (request, reply) => {
  const artifact = appDb.getArtifactRecord((request.params as { id: string }).id)
  if (!artifact || !existsSync(artifact.path)) return reply.code(404).send({ message: 'Datei nicht gefunden.' })
  reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`)
  if (artifact.mimeType) reply.type(artifact.mimeType)
  return reply.send(createReadStream(artifact.path))
})

app.get('/api/data/export.xlsx', async (_request, reply) => {
  const buffer = await appDb.exportWorkbook()
  reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  reply.header('Content-Disposition', 'attachment; filename="autosecurecloud-daten.xlsx"')
  return reply.send(buffer)
})
app.post('/api/data/import-preview.xlsx', async (request, reply) => {
  const file = await request.file()
  if (!file) return reply.code(400).send({ message: 'Bitte eine XLSX-Datei auswählen.' })
  try { return await appDb.previewWorkbook(await file.toBuffer()) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.post('/api/data/import.xlsx', async (request, reply) => {
  const file = await request.file()
  if (!file) return reply.code(400).send({ message: 'Bitte eine XLSX-Datei auswählen.' })
  try {
    const result = await appDb.importWorkbook(await file.toBuffer())
    emit({ type: 'data.changed' })
    return result
  }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})

const fixtureShell = (title: string, body: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui;background:#eef3f8;color:#142038;margin:0;padding:40px}main{max-width:720px;margin:auto;background:white;padding:32px;border-radius:16px;box-shadow:0 18px 50px #19314a22}label{display:block;margin:16px 0 6px;font-weight:700}input,button{font:inherit;padding:10px 12px;border:1px solid #9cabc0;border-radius:8px}button,a.button{display:inline-block;background:#0c78b8;color:white;border:0;text-decoration:none;padding:11px 16px;border-radius:8px;margin-top:14px;cursor:pointer}.secret{padding:16px;background:#e8f7ff;border-left:4px solid #0c78b8;font:700 18px ui-monospace,monospace}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`
app.get('/fixture/firewall', async (_request, reply) => reply.type('text/html').send(fixtureShell('Demo-Firewall', `<p>Diese Seite dient zum Testen einer vollständigen Aufnahme.</p><section id="login"><label for="username">Benutzername</label><input id="username"><label for="password">Passwort</label><input id="password" type="password"><br><button id="login-button" onclick="document.querySelector('#login').hidden=true;document.querySelector('#config').hidden=false">Anmelden</button></section><section id="config" hidden><h2>Geräteinformationen</h2><p>Konfigurationsschlüssel:</p><div id="device-key" class="secret">FW-DEMO-42A7</div><a class="button" href="/fixture/portal">Zum Zertifikatsportal</a><h2>Konfiguration hochladen</h2><label for="config-file">Konfigurationsdatei</label><input id="config-file" type="file"><button onclick="document.querySelector('#upload-result').textContent='Datei wurde übernommen.'">Übernehmen</button><p id="upload-result"></p></section>`)))
app.get('/fixture/portal', async (_request, reply) => reply.type('text/html').send(fixtureShell('Demo-Zertifikatsportal', `<label for="device-key-input">Konfigurationsschlüssel</label><input id="device-key-input"><br><a id="download-config" class="button" href="/fixture/download">Konfiguration herunterladen</a><p><a href="/fixture/firewall">Zurück zur Firewall</a></p>`)))
app.get('/fixture/discovery', async (_request, reply) => reply.type('text/html').send(fixtureShell('Demo-Gerätesuche', `
  <p>Diese Seite simuliert verschachtelte Standorte und Maschinen.</p>
  <section id="site-list"><h2>Service Targets</h2><div id="sites"></div></section>
  <section id="machine-list" hidden><button id="back-sites">← Standorte</button><h2 id="site-title"></h2><div id="machines"></div></section>
  <div id="machine-modal" hidden style="position:fixed;inset:8%;overflow:auto;background:white;border:1px solid #9cabc0;border-radius:16px;padding:28px;box-shadow:0 24px 80px #14203844">
    <button class="close-modal" style="float:right">Schließen</button><h2 id="machine-title"></h2>
    <button class="vpn-toggle">VPN client information</button>
    <div id="vpn-info" hidden><p>Type: <strong class="router-type"></strong></p><p class="ip-row">IP address: <strong class="ip-address"></strong></p></div>
  </div>
  <script>
    const groups = [
      { name: 'Standort Nord', machines: [
        { name: 'Anlage A', type: 'mGuard (router mode)', ip: '192.0.2.10' },
        { name: 'Anlage B', type: 'VPN Client', ip: '' },
        { name: 'Testgerät', type: 'mGuard (router mode)', ip: '192.0.2.40' },
        { name: 'Anlage C', type: 'mGuard (router mode)', ip: '192.0.2.40' },
      ]},
      { name: 'Standort Süd', machines: [
        { name: 'Gateway 1', type: 'mGuard (router mode)', ip: '198.51.100.10' },
        { name: 'Gateway 2', type: 'mGuard (router mode)', ip: '198.51.100.20' },
        { name: 'Gateway 3', type: 'mGuard (router mode)', ip: '198.51.100.30' },
      ]},
    ]
    const sites = document.querySelector('#sites')
    const machines = document.querySelector('#machines')
    const renderSites = () => { sites.innerHTML = groups.map((group, index) => '<button class="site-card" data-index="' + index + '"><strong class="site-name">' + group.name + '</strong><br>' + group.machines.length + ' Maschinen</button>').join(' ') }
    const openSite = (index) => {
      const group = groups[index]
      document.querySelector('#site-list').hidden = true
      document.querySelector('#machine-list').hidden = false
      document.querySelector('#site-title').textContent = group.name
      machines.innerHTML = group.machines.map((machine, machineIndex) => '<article class="machine-card" data-group="' + index + '" data-index="' + machineIndex + '" style="margin:12px 0;padding:16px;border:1px solid #ccd5e0;border-radius:12px"><strong class="machine-name">' + machine.name + '</strong><br><button class="more">More</button></article>').join('')
    }
    renderSites()
    sites.addEventListener('click', (event) => { const card = event.target.closest('.site-card'); if (card) openSite(Number(card.dataset.index)) })
    document.querySelector('#back-sites').addEventListener('click', () => { document.querySelector('#machine-list').hidden = true; document.querySelector('#site-list').hidden = false })
    machines.addEventListener('click', (event) => {
      const button = event.target.closest('.more'); if (!button) return
      const card = button.closest('.machine-card'); const machine = groups[Number(card.dataset.group)].machines[Number(card.dataset.index)]
      document.querySelector('#machine-title').textContent = machine.name
      document.querySelector('.router-type').textContent = machine.type
      document.querySelector('.ip-address').textContent = machine.ip
      document.querySelector('.ip-row').hidden = !machine.ip
      document.querySelector('#vpn-info').hidden = true
      document.querySelector('#machine-modal').hidden = false
    })
    document.querySelector('.vpn-toggle').addEventListener('click', () => { document.querySelector('#vpn-info').hidden = false })
    document.querySelector('.close-modal').addEventListener('click', () => { document.querySelector('#machine-modal').hidden = true })
  </script>
`)))
app.get('/fixture/download', async (_request, reply) => {
  reply.type('application/octet-stream').header('Content-Disposition', 'attachment; filename="firewall-konfiguration.txt"')
  return reply.send('AutoSecureCloud Demo-Konfiguration\nErstellt: ' + new Date().toISOString())
})

if (isProduction) {
  const webRoot = resolve(process.cwd(), 'apps/web/dist')
  await app.register(fastifyStatic, { root: webRoot })
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/fixture/')) return reply.code(404).send({ message: 'Nicht gefunden.' })
    return reply.sendFile('index.html')
  })
}

const shutdown = async () => {
  automaticBackups.stop()
  await recorder.stop()
  appDb.close()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ host, port })
automaticBackups.start()
console.log(`AutoSecureCloud läuft unter http://${host}:${port}`)
