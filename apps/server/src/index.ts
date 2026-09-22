import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { createReadStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SocketEvent } from '@autosecure/shared'
import { appDb } from './database.ts'
import { RecorderService } from './recorder.ts'
import { RunnerService } from './runner.ts'
import { host, isProduction, port } from './config.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
await app.register(cors, { origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] })
await app.register(websocket)
await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } })

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

app.get('/api/credentials', async () => appDb.listCredentials())
app.get('/api/credentials/:id/secret', async (request, reply) => {
  const credential = appDb.getCredential((request.params as { id: string }).id, true)
  if (!credential) return reply.code(404).send({ message: 'Zugangsdatenprofil nicht gefunden.' })
  return { password: credential.password ?? '' }
})
app.post('/api/credentials', async (request, reply) => {
  const body = request.body as { name?: string; username?: string; password?: string }
  if (!body?.name?.trim()) return reply.code(400).send({ message: 'Name ist erforderlich.' })
  return reply.code(201).send(appDb.createCredential({ name: body.name.trim(), username: body.username, password: body.password }))
})
app.patch('/api/credentials/:id', async (request, reply) => {
  const result = appDb.updateCredential((request.params as { id: string }).id, request.body as never)
  return result ?? reply.code(404).send({ message: 'Zugangsdatenprofil nicht gefunden.' })
})
app.delete('/api/credentials/:id', async (request, reply) => {
  const deleted = appDb.deleteCredential((request.params as { id: string }).id)
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Zugangsdatenprofil nicht gefunden.' })
})

app.get('/api/devices', async () => appDb.listDevices())
app.post('/api/devices', async (request, reply) => {
  const body = request.body as { name?: string; baseUrl?: string; credentialId?: string; ignoreHttpsErrors?: boolean; data?: Record<string,string>; pipelineIds?: string[] }
  if (!body?.name?.trim() || !body?.baseUrl?.trim()) return reply.code(400).send({ message: 'Name und Start-URL sind erforderlich.' })
  try { new URL(body.baseUrl) } catch { return reply.code(400).send({ message: 'Die Start-URL ist ungültig.' }) }
  if (body.pipelineIds?.some((id) => !appDb.getPipeline(id))) return reply.code(400).send({ message: 'Mindestens eine Pipeline wurde nicht gefunden.' })
  return reply.code(201).send(appDb.createDevice({ ...body, name: body.name.trim(), baseUrl: body.baseUrl.trim() } as Parameters<typeof appDb.createDevice>[0]))
})
app.patch('/api/devices/:id', async (request, reply) => {
  const body = request.body as { pipelineIds?: string[] }
  if (body.pipelineIds?.some((pipelineId) => !appDb.getPipeline(pipelineId))) return reply.code(400).send({ message: 'Mindestens eine Pipeline wurde nicht gefunden.' })
  const result = appDb.updateDevice((request.params as { id: string }).id, body as never)
  return result ?? reply.code(404).send({ message: 'Gerät nicht gefunden.' })
})
app.post('/api/devices/:id/duplicate', async (request, reply) => {
  const source = appDb.getDevice((request.params as { id: string }).id)
  if (!source) return reply.code(404).send({ message: 'Gerät nicht gefunden.' })
  const body = request.body as { name?: string; baseUrl?: string }
  if (!body?.name?.trim() || !body?.baseUrl?.trim()) return reply.code(400).send({ message: 'Name und Start-URL sind erforderlich.' })
  try { new URL(body.baseUrl) } catch { return reply.code(400).send({ message: 'Die Start-URL ist ungültig.' }) }
  return reply.code(201).send(appDb.createDevice({
    name: body.name.trim(), baseUrl: body.baseUrl.trim(), credentialId: source.credentialId,
    ignoreHttpsErrors: source.ignoreHttpsErrors, pipelineIds: source.pipelineIds, data: {},
  }))
})
app.post('/api/devices/:id/run', async (request, reply) => {
  try { return reply.code(201).send(runner.startDevicePlan((request.params as { id: string }).id)) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})
app.delete('/api/devices/:id', async (request, reply) => {
  const deleted = appDb.deleteDevice((request.params as { id: string }).id)
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Gerät nicht gefunden.' })
})

app.get('/api/data-fields', async () => appDb.listDataFields())
app.post('/api/data-fields', async (request, reply) => {
  const body = request.body as { label?: string; key?: string; type?: 'text' | 'number' | 'date' | 'url' }
  if (!body?.label?.trim()) return reply.code(400).send({ message: 'Eine Spaltenbezeichnung ist erforderlich.' })
  return reply.code(201).send(appDb.createDataField({ label: body.label, key: body.key, type: body.type }))
})
app.patch('/api/data-fields/:id', async (request, reply) => {
  const result = appDb.updateDataField((request.params as { id: string }).id, request.body as never)
  return result ?? reply.code(404).send({ message: 'Datenspalte nicht gefunden.' })
})
app.delete('/api/data-fields/:id', async (request, reply) => {
  const deleted = appDb.deleteDataField((request.params as { id: string }).id)
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
app.delete('/api/pipelines/:id', async (request, reply) => {
  const deleted = appDb.deletePipeline((request.params as { id: string }).id)
  return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Pipeline nicht gefunden.' })
})

app.post('/api/recordings/start', async (request, reply) => {
  try { return await recorder.start(request.body as { pipelineId: string; deviceId?: string; url?: string }) }
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
app.post('/api/data/import.xlsx', async (request, reply) => {
  const file = await request.file()
  if (!file) return reply.code(400).send({ message: 'Bitte eine XLSX-Datei auswählen.' })
  try { return await appDb.importWorkbook(await file.toBuffer()) }
  catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }) }
})

const fixtureShell = (title: string, body: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui;background:#eef3f8;color:#142038;margin:0;padding:40px}main{max-width:720px;margin:auto;background:white;padding:32px;border-radius:16px;box-shadow:0 18px 50px #19314a22}label{display:block;margin:16px 0 6px;font-weight:700}input,button{font:inherit;padding:10px 12px;border:1px solid #9cabc0;border-radius:8px}button,a.button{display:inline-block;background:#0c78b8;color:white;border:0;text-decoration:none;padding:11px 16px;border-radius:8px;margin-top:14px;cursor:pointer}.secret{padding:16px;background:#e8f7ff;border-left:4px solid #0c78b8;font:700 18px ui-monospace,monospace}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`
app.get('/fixture/firewall', async (_request, reply) => reply.type('text/html').send(fixtureShell('Demo-Firewall', `<p>Diese Seite dient zum Testen einer vollständigen Aufnahme.</p><section id="login"><label for="username">Benutzername</label><input id="username"><label for="password">Passwort</label><input id="password" type="password"><br><button id="login-button" onclick="document.querySelector('#login').hidden=true;document.querySelector('#config').hidden=false">Anmelden</button></section><section id="config" hidden><h2>Geräteinformationen</h2><p>Konfigurationsschlüssel:</p><div id="device-key" class="secret">FW-DEMO-42A7</div><a class="button" href="/fixture/portal">Zum Zertifikatsportal</a><h2>Konfiguration hochladen</h2><label for="config-file">Konfigurationsdatei</label><input id="config-file" type="file"><button onclick="document.querySelector('#upload-result').textContent='Datei wurde übernommen.'">Übernehmen</button><p id="upload-result"></p></section>`)))
app.get('/fixture/portal', async (_request, reply) => reply.type('text/html').send(fixtureShell('Demo-Zertifikatsportal', `<label for="device-key-input">Konfigurationsschlüssel</label><input id="device-key-input"><br><a id="download-config" class="button" href="/fixture/download">Konfiguration herunterladen</a><p><a href="/fixture/firewall">Zurück zur Firewall</a></p>`)))
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
  await recorder.stop()
  appDb.close()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ host, port })
console.log(`AutoSecureCloud läuft unter http://${host}:${port}`)
