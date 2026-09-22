import Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import { mkdirSync, chmodSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Artifact,
  Credential,
  DataField,
  DataFieldType,
  Device,
  Pipeline,
  PipelineStep,
  PlaybackSpeed,
  Run,
  RunLog,
  RunStatus,
} from '@autosecure/shared'
import { artifactsDirectory, dataDirectory, databasePath } from './config.ts'

type Row = Record<string, unknown>

const now = () => new Date().toISOString()
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

export class AppDatabase {
  readonly db: Database.Database

  constructor(path = databasePath) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    mkdirSync(artifactsDirectory, { recursive: true, mode: 0o700 })
    this.db = new Database(path)
    try { chmodSync(path, 0o600) } catch { /* unsupported filesystem */ }
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
        ignore_https_errors INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL DEFAULT '{}',
        pipeline_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS data_fields (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        speed TEXT NOT NULL DEFAULT 'normal',
        steps_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        pipeline_name TEXT NOT NULL,
        pipeline_snapshot TEXT NOT NULL,
        device_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        current_device_id TEXT,
        current_step INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        device_id TEXT,
        step_index INTEGER,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        device_id TEXT,
        step_index INTEGER,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs(run_id, id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at);
    `)
    const deviceColumns = new Set((this.db.prepare('PRAGMA table_info(devices)').all() as Row[]).map((row) => String(row.name)))
    if (!deviceColumns.has('pipeline_ids_json')) this.db.exec("ALTER TABLE devices ADD COLUMN pipeline_ids_json TEXT NOT NULL DEFAULT '[]'")
    const existingKeys = new Set(this.listDataFields().map((field) => field.key))
    const rows = this.db.prepare('SELECT data_json FROM devices').all() as Row[]
    for (const row of rows) {
      for (const key of Object.keys(json<Record<string, string>>(row.data_json, {}))) {
        if (!existingKeys.has(key)) {
          this.createDataField({ key, label: key })
          existingKeys.add(key)
        }
      }
    }
    this.db.prepare(`UPDATE runs SET status = 'interrupted', error = ?, finished_at = ? WHERE status IN ('running', 'paused', 'queued')`)
      .run('Die Anwendung wurde während des Laufs beendet.', now())
  }

  close() { this.db.close() }

  listCredentials(): Credential[] {
    return (this.db.prepare('SELECT * FROM credentials ORDER BY name').all() as Row[]).map(this.mapCredential)
  }

  getCredential(id: string, includePassword = false): Credential | undefined {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined
    if (!row) return undefined
    const result = this.mapCredential(row)
    if (includePassword) result.password = String(row.password ?? '')
    return result
  }

  createCredential(input: { name: string; username?: string; password?: string }): Credential {
    const id = randomUUID(); const stamp = now()
    this.db.prepare('INSERT INTO credentials (id,name,username,password,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, input.name, input.username ?? '', input.password ?? '', stamp, stamp)
    return this.getCredential(id)!
  }

  updateCredential(id: string, input: Partial<{ name: string; username: string; password: string }>): Credential | undefined {
    const existing = this.getCredential(id, true)
    if (!existing) return undefined
    this.db.prepare('UPDATE credentials SET name=?, username=?, password=?, updated_at=? WHERE id=?')
      .run(input.name ?? existing.name, input.username ?? existing.username, input.password ?? existing.password ?? '', now(), id)
    return this.getCredential(id)
  }

  deleteCredential(id: string) { return this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes > 0 }

  listDevices(): Device[] {
    const rows = this.db.prepare(`SELECT d.*, c.name credential_name FROM devices d LEFT JOIN credentials c ON c.id=d.credential_id ORDER BY d.name`).all() as Row[]
    return rows.map(this.mapDevice)
  }

  getDevice(id: string): Device | undefined {
    const row = this.db.prepare(`SELECT d.*, c.name credential_name FROM devices d LEFT JOIN credentials c ON c.id=d.credential_id WHERE d.id=?`).get(id) as Row | undefined
    return row ? this.mapDevice(row) : undefined
  }

  createDevice(input: { name: string; baseUrl: string; credentialId?: string; ignoreHttpsErrors?: boolean; data?: Record<string,string>; pipelineIds?: string[] }): Device {
    const id = randomUUID(); const stamp = now()
    for (const key of Object.keys(input.data ?? {})) this.ensureDataField(key)
    this.db.prepare('INSERT INTO devices (id,name,base_url,credential_id,ignore_https_errors,data_json,pipeline_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.name, input.baseUrl, input.credentialId || null, input.ignoreHttpsErrors ? 1 : 0, JSON.stringify(input.data ?? {}), JSON.stringify(input.pipelineIds ?? []), stamp, stamp)
    return this.getDevice(id)!
  }

  updateDevice(id: string, input: Partial<{ name: string; baseUrl: string; credentialId: string | null; ignoreHttpsErrors: boolean; data: Record<string,string>; pipelineIds: string[] }>): Device | undefined {
    const existing = this.getDevice(id)
    if (!existing) return undefined
    for (const key of Object.keys(input.data ?? {})) this.ensureDataField(key)
    this.db.prepare('UPDATE devices SET name=?,base_url=?,credential_id=?,ignore_https_errors=?,data_json=?,pipeline_ids_json=?,updated_at=? WHERE id=?').run(
      input.name ?? existing.name,
      input.baseUrl ?? existing.baseUrl,
      input.credentialId === undefined ? (existing.credentialId || null) : (input.credentialId || null),
      (input.ignoreHttpsErrors ?? existing.ignoreHttpsErrors) ? 1 : 0,
      JSON.stringify(input.data ?? existing.data),
      JSON.stringify(input.pipelineIds ?? existing.pipelineIds),
      now(), id,
    )
    return this.getDevice(id)
  }

  setDeviceValue(id: string, key: string, value: string) {
    const device = this.getDevice(id)
    if (!device) return undefined
    this.ensureDataField(key)
    device.data[key] = value
    return this.updateDevice(id, { data: device.data })
  }

  deleteDevice(id: string) { return this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0 }

  listDataFields(): DataField[] {
    return (this.db.prepare('SELECT * FROM data_fields ORDER BY position, created_at').all() as Row[]).map(this.mapDataField)
  }

  getDataField(id: string): DataField | undefined {
    const row = this.db.prepare('SELECT * FROM data_fields WHERE id=?').get(id) as Row | undefined
    return row ? this.mapDataField(row) : undefined
  }

  createDataField(input: { key?: string; label: string; type?: DataFieldType }): DataField {
    const label = input.label.trim()
    const key = this.uniqueDataFieldKey(input.key || label)
    const id = randomUUID(); const stamp = now()
    const position = Number((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM data_fields').get() as Row).next)
    this.db.prepare('INSERT INTO data_fields (id,key,label,type,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, key, label || key, input.type ?? 'text', position, stamp, stamp)
    return this.getDataField(id)!
  }

  updateDataField(id: string, input: Partial<{ label: string; type: DataFieldType; position: number }>): DataField | undefined {
    const existing = this.getDataField(id)
    if (!existing) return undefined
    this.db.prepare('UPDATE data_fields SET label=?,type=?,position=?,updated_at=? WHERE id=?')
      .run(input.label?.trim() || existing.label, input.type ?? existing.type, input.position ?? existing.position, now(), id)
    return this.getDataField(id)
  }

  deleteDataField(id: string): boolean {
    const field = this.getDataField(id)
    if (!field) return false
    const transaction = this.db.transaction(() => {
      for (const device of this.listDevices()) {
        if (!(field.key in device.data)) continue
        const next = { ...device.data }
        delete next[field.key]
        this.updateDevice(device.id, { data: next })
      }
      this.db.prepare('DELETE FROM data_fields WHERE id=?').run(id)
    })
    transaction()
    return true
  }

  private ensureDataField(key: string, label = key): DataField {
    const row = this.db.prepare('SELECT * FROM data_fields WHERE key=?').get(key) as Row | undefined
    return row ? this.mapDataField(row) : this.createDataField({ key, label })
  }

  private uniqueDataFieldKey(value: string): string {
    const base = value.toLowerCase().trim()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'feld'
    let key = base; let suffix = 2
    while (this.db.prepare('SELECT 1 FROM data_fields WHERE key=?').get(key)) key = `${base}_${suffix++}`
    return key
  }

  listPipelines(): Pipeline[] {
    return (this.db.prepare('SELECT * FROM pipelines ORDER BY updated_at DESC').all() as Row[]).map(this.mapPipeline)
  }

  getPipeline(id: string): Pipeline | undefined {
    const row = this.db.prepare('SELECT * FROM pipelines WHERE id=?').get(id) as Row | undefined
    return row ? this.mapPipeline(row) : undefined
  }

  createPipeline(input: { name: string; description?: string; speed?: PlaybackSpeed; steps?: PipelineStep[] }): Pipeline {
    const id = randomUUID(); const stamp = now()
    this.db.prepare('INSERT INTO pipelines (id,name,description,speed,steps_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.name, input.description ?? '', input.speed ?? 'normal', JSON.stringify(input.steps ?? []), stamp, stamp)
    return this.getPipeline(id)!
  }

  updatePipeline(id: string, input: Partial<{ name: string; description: string; speed: PlaybackSpeed; steps: PipelineStep[] }>): Pipeline | undefined {
    const existing = this.getPipeline(id)
    if (!existing) return undefined
    for (const step of input.steps ?? []) if (step.type === 'extractText' && step.persist) this.ensureDataField(step.key)
    this.db.prepare('UPDATE pipelines SET name=?,description=?,speed=?,steps_json=?,updated_at=? WHERE id=?')
      .run(input.name ?? existing.name, input.description ?? existing.description, input.speed ?? existing.speed, JSON.stringify(input.steps ?? existing.steps), now(), id)
    return this.getPipeline(id)
  }

  appendPipelineStep(id: string, step: PipelineStep): Pipeline | undefined {
    const pipeline = this.getPipeline(id)
    if (!pipeline) return undefined
    if (step.type === 'extractText' && step.persist) this.ensureDataField(step.key)
    pipeline.steps.push(step)
    return this.updatePipeline(id, { steps: pipeline.steps })
  }

  insertPipelineStep(id: string, index: number, step: PipelineStep): Pipeline | undefined {
    const pipeline = this.getPipeline(id)
    if (!pipeline) return undefined
    if (step.type === 'extractText' && step.persist) this.ensureDataField(step.key)
    const safeIndex = Math.max(0, Math.min(index, pipeline.steps.length))
    pipeline.steps.splice(safeIndex, 0, step)
    return this.updatePipeline(id, { steps: pipeline.steps })
  }

  replacePipelineStep(id: string, index: number, step: PipelineStep): Pipeline | undefined {
    const pipeline = this.getPipeline(id)
    if (!pipeline || index < 0 || index >= pipeline.steps.length) return undefined
    if (step.type === 'extractText' && step.persist) this.ensureDataField(step.key)
    pipeline.steps[index] = step
    return this.updatePipeline(id, { steps: pipeline.steps })
  }

  replaceLastClickWithDownload(id: string, step: PipelineStep): Pipeline | undefined {
    const pipeline = this.getPipeline(id)
    if (!pipeline) return undefined
    const last = pipeline.steps.at(-1)
    if (last?.type === 'click') pipeline.steps[pipeline.steps.length - 1] = step
    else pipeline.steps.push(step)
    return this.updatePipeline(id, { steps: pipeline.steps })
  }

  deletePipeline(id: string) {
    const deleted = this.db.prepare('DELETE FROM pipelines WHERE id = ?').run(id).changes > 0
    if (deleted) for (const device of this.listDevices()) if (device.pipelineIds.includes(id)) this.updateDevice(device.id, { pipelineIds: device.pipelineIds.filter((pipelineId) => pipelineId !== id) })
    return deleted
  }

  createRun(pipeline: Pipeline, deviceIds: string[]): Run {
    const id = randomUUID(); const stamp = now()
    this.db.prepare(`INSERT INTO runs (id,pipeline_id,pipeline_name,pipeline_snapshot,device_ids_json,status,created_at) VALUES (?,?,?,?,?,'queued',?)`)
      .run(id, pipeline.id, pipeline.name, JSON.stringify(pipeline), JSON.stringify(deviceIds), stamp)
    return this.getRun(id)!
  }

  listRuns(): Run[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 100').all() as Row[]).map((row) => this.mapRun(row))
  }

  getRun(id: string, detail = false): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    const run = this.mapRun(row)
    if (detail) {
      run.logs = this.listLogs(id)
      run.artifacts = this.listArtifacts(id)
    }
    return run
  }

  getRunSnapshot(id: string): Pipeline | undefined {
    const row = this.db.prepare('SELECT pipeline_snapshot FROM runs WHERE id=?').get(id) as Row | undefined
    return row ? json<Pipeline>(row.pipeline_snapshot, undefined as unknown as Pipeline) : undefined
  }

  updateRun(id: string, input: Partial<{ status: RunStatus; currentDeviceId: string | null; currentStep: number | null; error: string | null; startedAt: string; finishedAt: string }>): Run | undefined {
    const current = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined
    if (!current) return undefined
    this.db.prepare('UPDATE runs SET status=?,current_device_id=?,current_step=?,error=?,started_at=?,finished_at=? WHERE id=?').run(
      input.status ?? current.status,
      input.currentDeviceId === undefined ? current.current_device_id : input.currentDeviceId,
      input.currentStep === undefined ? current.current_step : input.currentStep,
      input.error === undefined ? current.error : input.error,
      input.startedAt ?? current.started_at,
      input.finishedAt ?? current.finished_at,
      id,
    )
    return this.getRun(id)
  }

  deleteRun(id: string): string[] {
    const paths = (this.db.prepare('SELECT path FROM artifacts WHERE run_id=?').all(id) as Row[]).map((row) => String(row.path))
    this.db.prepare('DELETE FROM runs WHERE id=?').run(id)
    return paths
  }

  addLog(runId: string, input: { deviceId?: string; stepIndex?: number; level: RunLog['level']; message: string }): RunLog {
    const stamp = now()
    const result = this.db.prepare('INSERT INTO run_logs (run_id,device_id,step_index,level,message,created_at) VALUES (?,?,?,?,?,?)')
      .run(runId, input.deviceId ?? null, input.stepIndex ?? null, input.level, input.message, stamp)
    return {
      id: Number(result.lastInsertRowid), runId, deviceId: input.deviceId, stepIndex: input.stepIndex,
      level: input.level, message: input.message, createdAt: stamp,
    }
  }

  listLogs(runId: string): RunLog[] {
    return (this.db.prepare('SELECT * FROM run_logs WHERE run_id=? ORDER BY id').all(runId) as Row[]).map((row) => ({
      id: Number(row.id), runId: String(row.run_id), deviceId: row.device_id ? String(row.device_id) : undefined,
      stepIndex: row.step_index == null ? undefined : Number(row.step_index), level: row.level as RunLog['level'],
      message: String(row.message), createdAt: String(row.created_at),
    }))
  }

  addArtifact(input: { runId: string; deviceId?: string; stepIndex?: number; name: string; path: string; mimeType?: string; kind: Artifact['kind'] }): Artifact {
    const id = randomUUID(); const stamp = now(); const size = existsSync(input.path) ? statSync(input.path).size : 0
    this.db.prepare('INSERT INTO artifacts (id,run_id,device_id,step_index,name,path,mime_type,size,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, input.runId, input.deviceId ?? null, input.stepIndex ?? null, input.name, input.path, input.mimeType ?? null, size, input.kind, stamp)
    return { id, runId: input.runId, deviceId: input.deviceId, stepIndex: input.stepIndex, name: input.name, mimeType: input.mimeType, size, kind: input.kind, createdAt: stamp, downloadUrl: `/api/artifacts/${id}` }
  }

  listArtifacts(runId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at').all(runId) as Row[]).map(this.mapArtifact)
  }

  getArtifactRecord(id: string): (Artifact & { path: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    return { ...this.mapArtifact(row), path: String(row.path) }
  }

  findArtifactByKey(runId: string, deviceId: string, key: string): (Artifact & { path: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE run_id=? AND device_id=? AND name LIKE ? ORDER BY created_at DESC LIMIT 1').get(runId, deviceId, `${key}__%`) as Row | undefined
    return row ? { ...this.mapArtifact(row), path: String(row.path) } : undefined
  }

  async exportWorkbook(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Geräte & Daten')
    const devices = this.listDevices()
    const fields = this.listDataFields()
    sheet.columns = [
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Start-URL', key: 'baseUrl', width: 44 },
      { header: 'Zugangsdatenprofil', key: 'credentialName', width: 28 },
      { header: 'HTTPS-Fehler ignorieren', key: 'ignoreHttpsErrors', width: 22 },
      ...fields.map((field) => ({ header: field.label, key: `data:${field.key}`, width: 24 })),
    ]
    for (const device of devices) {
      const row: Record<string, string | boolean> = { name: device.name, baseUrl: device.baseUrl, credentialName: device.credentialName ?? '', ignoreHttpsErrors: device.ignoreHttpsErrors }
      for (const field of fields) row[`data:${field.key}`] = device.data[field.key] ?? ''
      sheet.addRow(row)
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18233A' } }
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    const value = await workbook.xlsx.writeBuffer()
    return Buffer.from(value)
  }

  async importWorkbook(buffer: Buffer): Promise<{ created: number; updated: number }> {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
    const sheet = workbook.getWorksheet('Geräte & Daten') ?? workbook.worksheets[0]
    if (!sheet) throw new Error('Die Datei enthält kein Arbeitsblatt.')
    const headers = new Map<number, string>()
    sheet.getRow(1).eachCell((cell, col) => headers.set(col, String(cell.value ?? '').trim()))
    let created = 0; let updated = 0
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return
      const values: Record<string, string> = {}
      headers.forEach((header, col) => { values[header] = String(row.getCell(col).text ?? '').trim() })
      if (!values.Name || !values['Start-URL']) return
      const existing = this.listDevices().find((item) => item.name.toLowerCase() === values.Name.toLowerCase())
      const reserved = ['Name', 'Start-URL', 'Zugangsdatenprofil', 'HTTPS-Fehler ignorieren']
      const data: Record<string, string> = {}
      for (const [label, value] of Object.entries(values)) {
        if (reserved.includes(label)) continue
        const field = this.listDataFields().find((item) => item.label.toLowerCase() === label.toLowerCase()) ?? this.createDataField({ label })
        if (value !== '') data[field.key] = value
      }
      if (existing) {
        this.updateDevice(existing.id, { baseUrl: values['Start-URL'], ignoreHttpsErrors: /^(ja|true|1)$/i.test(values['HTTPS-Fehler ignorieren']), data: { ...existing.data, ...data } })
        updated++
      } else {
        this.createDevice({ name: values.Name, baseUrl: values['Start-URL'], ignoreHttpsErrors: /^(ja|true|1)$/i.test(values['HTTPS-Fehler ignorieren']), data })
        created++
      }
    })
    return { created, updated }
  }

  getArtifactDirectory(runId: string, deviceId: string) {
    const path = join(artifactsDirectory, runId, deviceId)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return path
  }

  private mapCredential = (row: Row): Credential => ({
    id: String(row.id), name: String(row.name), username: String(row.username), hasPassword: Boolean(row.password),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  private mapDevice = (row: Row): Device => ({
    id: String(row.id), name: String(row.name), baseUrl: String(row.base_url),
    credentialId: row.credential_id ? String(row.credential_id) : undefined,
    credentialName: row.credential_name ? String(row.credential_name) : undefined,
    ignoreHttpsErrors: Boolean(row.ignore_https_errors), data: json<Record<string,string>>(row.data_json, {}),
    pipelineIds: json<string[]>(row.pipeline_ids_json, []),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  private mapDataField = (row: Row): DataField => ({
    id: String(row.id), key: String(row.key), label: String(row.label), type: row.type as DataFieldType,
    position: Number(row.position), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  private mapPipeline = (row: Row): Pipeline => ({
    id: String(row.id), name: String(row.name), description: String(row.description), speed: row.speed as PlaybackSpeed,
    steps: json<PipelineStep[]>(row.steps_json, []), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  private mapRun = (row: Row): Run => {
    const snapshot = json<Pipeline>(row.pipeline_snapshot, {} as Pipeline)
    const device = row.current_device_id ? this.getDevice(String(row.current_device_id)) : undefined
    return {
      id: String(row.id), pipelineId: String(row.pipeline_id), pipelineName: String(row.pipeline_name),
      deviceIds: json<string[]>(row.device_ids_json, []), status: row.status as RunStatus,
      currentDeviceId: row.current_device_id ? String(row.current_device_id) : undefined,
      currentDeviceName: device?.name, currentStep: row.current_step == null ? undefined : Number(row.current_step),
      totalSteps: snapshot.steps?.length ?? 0, error: row.error ? String(row.error) : undefined,
      stages: snapshot.stages,
      createdAt: String(row.created_at), startedAt: row.started_at ? String(row.started_at) : undefined,
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    }
  }

  private mapArtifact = (row: Row): Artifact => ({
    id: String(row.id), runId: String(row.run_id), deviceId: row.device_id ? String(row.device_id) : undefined,
    stepIndex: row.step_index == null ? undefined : Number(row.step_index), name: String(row.name),
    mimeType: row.mime_type ? String(row.mime_type) : undefined, size: Number(row.size), kind: row.kind as Artifact['kind'],
    createdAt: String(row.created_at), downloadUrl: `/api/artifacts/${String(row.id)}`,
  })
}

export const appDb = new AppDatabase()
