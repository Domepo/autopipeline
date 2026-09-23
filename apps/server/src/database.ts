import Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import { mkdirSync, chmodSync, existsSync, statSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
  Artifact,
  AppSettings,
  Credential,
  DataField,
  DataFieldType,
  Device,
  Pipeline,
  PipelineGroup,
  PipelineStep,
  PlaybackSpeed,
  Run,
  RunLog,
  RunStatus,
  WorkbookImportPreview,
} from '@autosecure/shared'
import { artifactsDirectory, backupsDirectory, dataDirectory, databasePath } from './config.ts'

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
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL,
        logo BLOB,
        logo_mime TEXT,
        logo_version INTEGER NOT NULL DEFAULT 0,
        action_timeout_ms INTEGER NOT NULL DEFAULT 15000,
        navigation_timeout_ms INTEGER NOT NULL DEFAULT 45000,
        download_timeout_ms INTEGER NOT NULL DEFAULT 60000,
        automatic_backup_interval TEXT NOT NULL DEFAULT 'off',
        automatic_backup_retention INTEGER NOT NULL DEFAULT 7,
        last_automatic_backup_at TEXT,
        automatic_backup_error TEXT
      );
      INSERT OR IGNORE INTO app_settings (id, title, subtitle) VALUES (1, 'AutoSecureCloud', 'Sicherheitsautomation');
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
      CREATE TABLE IF NOT EXISTS pipeline_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        pipeline_ids_json TEXT NOT NULL DEFAULT '[]',
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
        artifact_key TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_artifacts_device ON artifacts(device_id, created_at DESC);
    `)
    const deviceColumns = new Set((this.db.prepare('PRAGMA table_info(devices)').all() as Row[]).map((row) => String(row.name)))
    const settingsColumns = new Set((this.db.prepare('PRAGMA table_info(app_settings)').all() as Row[]).map((row) => String(row.name)))
    if (!settingsColumns.has('action_timeout_ms')) this.db.exec('ALTER TABLE app_settings ADD COLUMN action_timeout_ms INTEGER NOT NULL DEFAULT 15000')
    if (!settingsColumns.has('navigation_timeout_ms')) this.db.exec('ALTER TABLE app_settings ADD COLUMN navigation_timeout_ms INTEGER NOT NULL DEFAULT 45000')
    if (!settingsColumns.has('download_timeout_ms')) this.db.exec('ALTER TABLE app_settings ADD COLUMN download_timeout_ms INTEGER NOT NULL DEFAULT 60000')
    if (!settingsColumns.has('automatic_backup_interval')) this.db.exec("ALTER TABLE app_settings ADD COLUMN automatic_backup_interval TEXT NOT NULL DEFAULT 'off'")
    if (!settingsColumns.has('automatic_backup_retention')) this.db.exec('ALTER TABLE app_settings ADD COLUMN automatic_backup_retention INTEGER NOT NULL DEFAULT 7')
    if (!settingsColumns.has('last_automatic_backup_at')) this.db.exec('ALTER TABLE app_settings ADD COLUMN last_automatic_backup_at TEXT')
    if (!settingsColumns.has('automatic_backup_error')) this.db.exec('ALTER TABLE app_settings ADD COLUMN automatic_backup_error TEXT')
    if (!deviceColumns.has('pipeline_ids_json')) this.db.exec("ALTER TABLE devices ADD COLUMN pipeline_ids_json TEXT NOT NULL DEFAULT '[]'")
    const artifactColumns = new Set((this.db.prepare('PRAGMA table_info(artifacts)').all() as Row[]).map((row) => String(row.name)))
    if (!artifactColumns.has('artifact_key')) this.db.exec('ALTER TABLE artifacts ADD COLUMN artifact_key TEXT')
    this.db.exec("UPDATE artifacts SET artifact_key=substr(name,1,instr(name,'__')-1) WHERE kind='download' AND artifact_key IS NULL AND instr(name,'__')>1")
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_device_key ON artifacts(device_id, artifact_key, created_at DESC)')
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
    this.db.exec('CREATE TABLE IF NOT EXISTS migration_flags (name TEXT PRIMARY KEY)')
    if (!this.db.prepare('SELECT 1 FROM migration_flags WHERE name=?').get('file_variables_v1')) {
      this.db.transaction(() => {
        this.backfillFileVariables()
        this.db.prepare('INSERT INTO migration_flags (name) VALUES (?)').run('file_variables_v1')
      })()
    }
    this.db.prepare(`UPDATE runs SET status = 'interrupted', error = ?, finished_at = ? WHERE status IN ('running', 'paused', 'queued')`)
      .run('Die Anwendung wurde während des Laufs beendet.', now())
  }

  close() { this.db.close() }

  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT title, subtitle, logo, logo_version, action_timeout_ms, navigation_timeout_ms, download_timeout_ms, automatic_backup_interval, automatic_backup_retention, last_automatic_backup_at, automatic_backup_error FROM app_settings WHERE id = 1').get() as Row
    return {
      title: String(row.title),
      subtitle: String(row.subtitle),
      logoUrl: row.logo ? `/api/settings/logo?v=${row.logo_version}` : null,
      storagePath: dataDirectory,
      actionTimeoutMs: Number(row.action_timeout_ms),
      navigationTimeoutMs: Number(row.navigation_timeout_ms),
      downloadTimeoutMs: Number(row.download_timeout_ms),
      automaticBackupInterval: row.automatic_backup_interval as AppSettings['automaticBackupInterval'],
      automaticBackupRetention: Number(row.automatic_backup_retention),
      lastAutomaticBackupAt: row.last_automatic_backup_at ? String(row.last_automatic_backup_at) : null,
      automaticBackupError: row.automatic_backup_error ? String(row.automatic_backup_error) : null,
      backupDirectory: backupsDirectory,
    }
  }

  updateSettings(title: string, subtitle: string): AppSettings {
    this.db.prepare('UPDATE app_settings SET title = ?, subtitle = ? WHERE id = 1').run(title, subtitle)
    return this.getSettings()
  }

  updateExecutionSettings(actionTimeoutMs: number, navigationTimeoutMs: number, downloadTimeoutMs: number): AppSettings {
    this.db.prepare('UPDATE app_settings SET action_timeout_ms=?, navigation_timeout_ms=?, download_timeout_ms=? WHERE id=1')
      .run(actionTimeoutMs, navigationTimeoutMs, downloadTimeoutMs)
    return this.getSettings()
  }

  updateAutomaticBackupSettings(interval: AppSettings['automaticBackupInterval'], retention: number): AppSettings {
    this.db.prepare("UPDATE app_settings SET last_automatic_backup_at=CASE WHEN automatic_backup_interval='off' AND ? != 'off' THEN NULL ELSE last_automatic_backup_at END, automatic_backup_interval=?, automatic_backup_retention=?, automatic_backup_error=NULL WHERE id=1")
      .run(interval, interval, retention)
    return this.getSettings()
  }

  recordAutomaticBackup(error: string | null, completedAt?: string): void {
    this.db.prepare('UPDATE app_settings SET last_automatic_backup_at=COALESCE(?, last_automatic_backup_at), automatic_backup_error=? WHERE id=1')
      .run(completedAt ?? null, error)
  }

  clearWorkspace(): { cleanupWarning: string | null } {
    const stagedArtifacts = join(dataDirectory, `artifacts-clear-${randomUUID()}`)
    const hadArtifacts = existsSync(artifactsDirectory)
    if (hadArtifacts) renameSync(artifactsDirectory, stagedArtifacts)
    try {
      mkdirSync(artifactsDirectory, { recursive: true, mode: 0o700 })
      this.db.transaction(() => {
        for (const table of ['artifacts', 'run_logs', 'runs', 'devices', 'pipeline_groups', 'pipelines', 'data_fields', 'credentials']) {
          this.db.prepare(`DELETE FROM ${table}`).run()
        }
        this.db.prepare("UPDATE app_settings SET title='AutoSecureCloud', subtitle='Sicherheitsautomation', logo=NULL, logo_mime=NULL, logo_version=logo_version+1, action_timeout_ms=15000, navigation_timeout_ms=45000, download_timeout_ms=60000, automatic_backup_interval='off', automatic_backup_retention=7, last_automatic_backup_at=NULL, automatic_backup_error=NULL WHERE id=1").run()
        this.db.prepare("DELETE FROM sqlite_sequence WHERE name='run_logs'").run()
      })()
    } catch (error) {
      rmSync(artifactsDirectory, { recursive: true, force: true })
      if (hadArtifacts) renameSync(stagedArtifacts, artifactsDirectory)
      throw error
    }
    try {
      if (hadArtifacts) rmSync(stagedArtifacts, { recursive: true, force: true })
      return { cleanupWarning: null }
    } catch (error) {
      return { cleanupWarning: `Die Daten wurden gelöscht, aber alte Dateireste konnten nicht entfernt werden: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  getLogo(): { data: Buffer; mimeType: string } | undefined {
    const row = this.db.prepare('SELECT logo, logo_mime FROM app_settings WHERE id = 1').get() as Row
    return row.logo ? { data: row.logo as Buffer, mimeType: String(row.logo_mime) } : undefined
  }

  setLogo(data: Buffer | null, mimeType: string | null): AppSettings {
    this.db.prepare('UPDATE app_settings SET logo = ?, logo_mime = ?, logo_version = logo_version + 1 WHERE id = 1').run(data, mimeType)
    return this.getSettings()
  }

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

  createCredentialForDevice(deviceId: string, input: { username: string; password: string }): { device: Device; credential: Credential } | undefined {
    const device = this.getDevice(deviceId)
    if (!device) return undefined
    return this.db.transaction(() => {
      const credential = this.createCredential({ name: `${device.name} · manuell`, username: input.username, password: input.password })
      const updated = this.updateDevice(deviceId, { credentialId: credential.id })!
      return { device: updated, credential }
    })()
  }

  addPipelineToDevices(pipelineId: string, deviceIds: string[]): { devices: Device[]; added: number } | undefined {
    if (!this.getPipeline(pipelineId)) return undefined
    const uniqueIds = [...new Set(deviceIds)]
    const devices = uniqueIds.map((id) => this.getDevice(id))
    if (devices.some((device) => !device)) return undefined
    const transaction = this.db.transaction(() => {
      let added = 0
      const updated = devices.map((device) => {
        const current = device!
        if (current.pipelineIds.includes(pipelineId)) return current
        added += 1
        return this.updateDevice(current.id, { pipelineIds: [...current.pipelineIds, pipelineId] })!
      })
      return { devices: updated, added }
    })
    return transaction()
  }

  assignCredentialToDevices(credentialId: string, deviceIds: string[]): { devices: Device[]; updated: number } | undefined {
    if (!this.getCredential(credentialId)) return undefined
    const uniqueIds = [...new Set(deviceIds)]
    const devices = uniqueIds.map((id) => this.getDevice(id))
    if (devices.some((device) => !device)) return undefined
    const transaction = this.db.transaction(() => {
      let updated = 0
      const assigned = devices.map((device) => {
        const current = device!
        if (current.credentialId === credentialId) return current
        updated += 1
        return this.updateDevice(current.id, { credentialId })!
      })
      return { devices: assigned, updated }
    })
    return transaction()
  }

  setDeviceValue(id: string, key: string, value: string) {
    const device = this.getDevice(id)
    if (!device) return undefined
    this.ensureDataField(key)
    device.data[key] = value
    return this.updateDevice(id, { data: device.data })
  }

  private setDeviceFileValue(deviceId: string, key: string, artifactId: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`Der Dateischlüssel „${key}“ darf nur Buchstaben, Zahlen, Punkt, Unterstrich und Bindestrich enthalten.`)
    const field = this.listDataFields().find((item) => item.key === key)
    if (field && field.type !== 'file') throw new Error(`Die Tabellenspalte „${field.label}“ ist keine Dateivariable.`)
    if (!field) {
      const stamp = now()
      const position = Number((this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM data_fields').get() as Row).next)
      this.db.prepare('INSERT INTO data_fields (id,key,label,type,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), key, key, 'file', position, stamp, stamp)
    }
    const device = this.getDevice(deviceId)
    if (device) this.updateDevice(deviceId, { data: { ...device.data, [key]: artifactId } })
  }

  private backfillFileVariables() {
    const downloads = this.db.prepare("SELECT id, device_id, artifact_key, path FROM artifacts WHERE kind='download' AND device_id IS NOT NULL AND artifact_key IS NOT NULL ORDER BY created_at DESC, rowid DESC").all() as Row[]
    for (const artifact of downloads) {
      const deviceId = String(artifact.device_id)
      const key = String(artifact.artifact_key)
      const device = this.getDevice(deviceId)
      if (!device || device.data[key] || !existsSync(String(artifact.path))) continue
      try { this.setDeviceFileValue(deviceId, key, String(artifact.id)) }
      catch { /* Older file keys can conflict with existing text columns. */ }
    }
  }

  upsertDiscoveredDevices(
    records: Array<{ name: string; baseUrl: string; data: Record<string, string> }>,
    duplicatePolicy: 'firstWins' | 'lastWins' = 'lastWins',
  ): { created: number; updated: number; duplicates: number; devices: Device[] } {
    const unique = new Map<string, { name: string; baseUrl: string; data: Record<string, string> }>()
    let duplicates = 0
    for (const record of records) {
      const key = record.baseUrl.trim().replace(/\/+$/, '').toLowerCase()
      if (unique.has(key)) {
        duplicates++
        if (duplicatePolicy === 'firstWins') continue
      }
      unique.set(key, { ...record, baseUrl: record.baseUrl.trim() })
    }

    let created = 0
    let updated = 0
    const devices: Device[] = []
    const transaction = this.db.transaction(() => {
      for (const record of unique.values()) {
        const normalized = record.baseUrl.replace(/\/+$/, '').toLowerCase()
        const existing = this.listDevices().find((device) => device.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized)
        if (existing) {
          const device = this.updateDevice(existing.id, { name: record.name, baseUrl: record.baseUrl, data: { ...existing.data, ...record.data } })!
          devices.push(device)
          updated++
        } else {
          devices.push(this.createDevice({ name: record.name, baseUrl: record.baseUrl, ignoreHttpsErrors: true, data: record.data }))
          created++
        }
      }
    })
    transaction()
    return { created, updated, duplicates, devices }
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

  duplicatePipeline(id: string, name?: string): Pipeline | undefined {
    const source = this.getPipeline(id)
    if (!source) return undefined
    const idMap = new Map(source.steps.map((step) => [step.id, randomUUID()]))
    const steps = source.steps.map((step) => {
      const clone = { ...structuredClone(step), id: idMap.get(step.id)! } as PipelineStep
      if (clone.type === 'download' && clone.match?.source.type === 'stepValue') {
        const mapped = idMap.get(clone.match.source.stepId)
        if (mapped) clone.match = { ...clone.match, source: { ...clone.match.source, stepId: mapped } }
      }
      return clone
    })
    return this.createPipeline({
      name: name?.trim() || `${source.name} Kopie`,
      description: source.description,
      speed: source.speed,
      steps,
    })
  }

  updatePipeline(id: string, input: Partial<{ name: string; description: string; speed: PlaybackSpeed; steps: PipelineStep[] }>): Pipeline | undefined {
    const existing = this.getPipeline(id)
    if (!existing) return undefined
    for (const step of input.steps ?? []) if (step.type === 'extractText' && step.persist) this.ensureDataField(step.key)
    this.db.prepare('UPDATE pipelines SET name=?,description=?,speed=?,steps_json=?,updated_at=? WHERE id=?')
      .run(input.name ?? existing.name, input.description ?? existing.description, input.speed ?? existing.speed, JSON.stringify(input.steps ?? existing.steps), now(), id)
    return this.getPipeline(id)
  }

  listPipelineGroups(): PipelineGroup[] {
    return (this.db.prepare('SELECT * FROM pipeline_groups ORDER BY name').all() as Row[]).map(this.mapPipelineGroup)
  }

  getPipelineGroup(id: string): PipelineGroup | undefined {
    const row = this.db.prepare('SELECT * FROM pipeline_groups WHERE id=?').get(id) as Row | undefined
    return row ? this.mapPipelineGroup(row) : undefined
  }

  createPipelineGroup(input: { name: string; description?: string; pipelineIds: string[] }): PipelineGroup {
    const id = randomUUID(); const stamp = now()
    this.db.prepare('INSERT INTO pipeline_groups (id,name,description,pipeline_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, input.name, input.description ?? '', JSON.stringify(input.pipelineIds), stamp, stamp)
    return this.getPipelineGroup(id)!
  }

  updatePipelineGroup(id: string, input: Partial<{ name: string; description: string; pipelineIds: string[] }>): PipelineGroup | undefined {
    const existing = this.getPipelineGroup(id)
    if (!existing) return undefined
    this.db.prepare('UPDATE pipeline_groups SET name=?,description=?,pipeline_ids_json=?,updated_at=? WHERE id=?')
      .run(input.name ?? existing.name, input.description ?? existing.description, JSON.stringify(input.pipelineIds ?? existing.pipelineIds), now(), id)
    return this.getPipelineGroup(id)
  }

  deletePipelineGroup(id: string): boolean {
    return this.db.prepare('DELETE FROM pipeline_groups WHERE id=?').run(id).changes > 0
  }

  applyPipelineGroup(id: string, deviceIds: string[]): Device[] | undefined {
    const group = this.getPipelineGroup(id)
    if (!group) return undefined
    const transaction = this.db.transaction(() => deviceIds.map((deviceId) => this.updateDevice(deviceId, { pipelineIds: group.pipelineIds })).filter((device): device is Device => Boolean(device)))
    return transaction()
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
    if (deleted) {
      for (const device of this.listDevices()) if (device.pipelineIds.includes(id)) this.updateDevice(device.id, { pipelineIds: device.pipelineIds.filter((pipelineId) => pipelineId !== id) })
      for (const group of this.listPipelineGroups()) if (group.pipelineIds.includes(id)) this.updatePipelineGroup(group.id, { pipelineIds: group.pipelineIds.filter((pipelineId) => pipelineId !== id) })
      for (const pipeline of this.listPipelines()) {
        const steps = pipeline.steps.map((step) => step.type === 'runPipelines' && step.pipelineIds.includes(id)
          ? { ...step, pipelineIds: step.pipelineIds.filter((pipelineId) => pipelineId !== id) }
          : step)
        if (steps.some((step, index) => step !== pipeline.steps[index])) this.updatePipeline(pipeline.id, { steps })
      }
    }
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
    return this.db.transaction(() => {
      const artifacts = this.db.prepare('SELECT id, device_id, artifact_key, path FROM artifacts WHERE run_id=?').all(id) as Row[]
      for (const artifact of artifacts) {
        if (!artifact.device_id || !artifact.artifact_key) continue
        const deviceId = String(artifact.device_id)
        const key = String(artifact.artifact_key)
        const device = this.getDevice(deviceId)
        if (!device || device.data[key] !== artifact.id) continue
        const deviceData = device.data
        const previous = this.db.prepare("SELECT id FROM artifacts WHERE device_id=? AND artifact_key=? AND run_id<>? AND kind='download' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(deviceId, key, id) as Row | undefined
        this.updateDevice(deviceId, { data: { ...deviceData, [key]: previous ? String(previous.id) : '' } })
      }
      this.db.prepare('DELETE FROM runs WHERE id=?').run(id)
      return artifacts.map((artifact) => String(artifact.path))
    })()
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

  addArtifact(input: { runId: string; deviceId?: string; stepIndex?: number; artifactKey?: string; name: string; path: string; mimeType?: string; kind: Artifact['kind'] }): Artifact {
    const id = randomUUID(); const stamp = now(); const size = existsSync(input.path) ? statSync(input.path).size : 0
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO artifacts (id,run_id,device_id,step_index,artifact_key,name,path,mime_type,size,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.runId, input.deviceId ?? null, input.stepIndex ?? null, input.artifactKey ?? null, input.name, input.path, input.mimeType ?? null, size, input.kind, stamp)
      if (input.kind === 'download' && input.deviceId && input.artifactKey) this.setDeviceFileValue(input.deviceId, input.artifactKey, id)
    })()
    const runName = (this.db.prepare('SELECT pipeline_name FROM runs WHERE id=?').get(input.runId) as Row | undefined)?.pipeline_name
    return { id, runId: input.runId, deviceId: input.deviceId, stepIndex: input.stepIndex, artifactKey: input.artifactKey, runName: runName ? String(runName) : undefined, name: input.name, mimeType: input.mimeType, size, kind: input.kind, createdAt: stamp, downloadUrl: `/api/artifacts/${id}` }
  }

  listArtifacts(runId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at').all(runId) as Row[]).map(this.mapArtifact)
  }

  listArtifactsForDevice(deviceId: string): Artifact[] {
    return (this.db.prepare('SELECT a.*, r.pipeline_name run_name FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.device_id=? ORDER BY a.created_at DESC LIMIT 100').all(deviceId) as Row[]).map(this.mapArtifact)
  }

  listDownloadArtifacts(): Artifact[] {
    return (this.db.prepare("SELECT a.*, r.pipeline_name run_name FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.kind='download' ORDER BY a.created_at DESC").all() as Row[]).map(this.mapArtifact)
  }

  getArtifactRecord(id: string): (Artifact & { path: string }) | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(id) as Row | undefined
    if (!row) return undefined
    return { ...this.mapArtifact(row), path: String(row.path) }
  }

  getDeviceFile(deviceId: string, key: string): (Artifact & { path: string }) | undefined {
    const id = this.getDevice(deviceId)?.data[key]
    const artifact = id ? this.getArtifactRecord(id) : undefined
    return artifact?.deviceId === deviceId && artifact.kind === 'download' ? artifact : undefined
  }

  findArtifactByKey(runId: string, deviceId: string, key: string): (Artifact & { path: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE run_id=? AND device_id=? AND kind='download' AND (artifact_key=? OR (artifact_key IS NULL AND name LIKE ?)) ORDER BY created_at DESC LIMIT 1").get(runId, deviceId, key, `${key}__%`) as Row | undefined
    return row ? { ...this.mapArtifact(row), path: String(row.path) } : undefined
  }

  findLatestArtifactByKey(deviceId: string, key: string): (Artifact & { path: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE device_id=? AND kind='download' AND (artifact_key=? OR (artifact_key IS NULL AND name LIKE ?)) ORDER BY created_at DESC LIMIT 1").get(deviceId, key, `${key}__%`) as Row | undefined
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

  private async readWorkbook(buffer: Buffer) {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
    const sheet = workbook.getWorksheet('Geräte & Daten') ?? workbook.worksheets[0]
    if (!sheet) throw new Error('Die Datei enthält kein Arbeitsblatt.')
    const headers = new Map<number, string>()
    sheet.getRow(1).eachCell((cell, col) => headers.set(col, String(cell.value ?? '').trim()))
    if (![...headers.values()].includes('Name') || ![...headers.values()].includes('Start-URL')) throw new Error('Die Spalten „Name“ und „Start-URL“ fehlen.')
    const existingByName = new Map(this.listDevices().map((device) => [device.name.toLocaleLowerCase('de'), device]))
    const credentialsByName = new Map(this.listCredentials().map((credential) => [credential.name.toLocaleLowerCase('de'), credential]))
    const seenNames = new Set<string>()
    const records: Array<{ name: string; baseUrl: string; existing?: Device; data: Record<string, string>; credentialId?: string; ignoreHttpsErrors?: boolean }> = []
    const warnings: string[] = []
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return
      const values: Record<string, string> = {}
      headers.forEach((header, col) => { values[header] = String(row.getCell(col).text ?? '').trim() })
      if (Object.values(values).every((value) => !value)) return
      if (!values.Name || !values['Start-URL']) throw new Error(`Zeile ${rowNumber}: Name und Start-URL sind erforderlich.`)
      let url: URL
      try { url = new URL(values['Start-URL']) } catch { throw new Error(`Zeile ${rowNumber}: Die Start-URL ist ungültig.`) }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Zeile ${rowNumber}: Nur HTTP- und HTTPS-Adressen sind erlaubt.`)
      const nameKey = values.Name.toLocaleLowerCase('de')
      if (seenNames.has(nameKey)) throw new Error(`Zeile ${rowNumber}: „${values.Name}“ kommt in der Datei mehrfach vor.`)
      seenNames.add(nameKey)
      const existing = existingByName.get(nameKey)
      const reserved = ['Name', 'Start-URL', 'Zugangsdatenprofil', 'HTTPS-Fehler ignorieren']
      const data: Record<string, string> = {}
      for (const [label, value] of Object.entries(values)) {
        if (!label || reserved.includes(label) || value === '') continue
        data[label] = value
      }
      const credentialName = values['Zugangsdatenprofil']
      const credential = credentialName ? credentialsByName.get(credentialName.toLocaleLowerCase('de')) : undefined
      if (credentialName && !credential) warnings.push(`Zeile ${rowNumber}: Profil „${credentialName}“ existiert nicht und wird nicht zugewiesen.`)
      const httpsValue = values['HTTPS-Fehler ignorieren']
      if (httpsValue && !/^(ja|nein|true|false|1|0)$/i.test(httpsValue)) throw new Error(`Zeile ${rowNumber}: Ungültiger Wert für „HTTPS-Fehler ignorieren“. Verwende Ja oder Nein.`)
      records.push({ name: values.Name, baseUrl: values['Start-URL'], existing, data, credentialId: credential?.id, ignoreHttpsErrors: httpsValue ? /^(ja|true|1)$/i.test(httpsValue) : undefined })
    })
    if (!records.length) throw new Error('Die Datei enthält keine Gerätezeilen.')
    return { records, warnings }
  }

  async previewWorkbook(buffer: Buffer): Promise<WorkbookImportPreview> {
    const { records, warnings } = await this.readWorkbook(buffer)
    return {
      created: records.filter((record) => !record.existing).length,
      updated: records.filter((record) => record.existing).length,
      warnings,
      rows: records.map((record) => {
        const changes: string[] = []
        if (record.existing?.baseUrl !== record.baseUrl) changes.push('Start-URL')
        if (record.ignoreHttpsErrors !== undefined && record.existing?.ignoreHttpsErrors !== record.ignoreHttpsErrors) changes.push('HTTPS-Einstellung')
        if (record.credentialId && record.existing?.credentialId !== record.credentialId) changes.push('Zugangsprofil')
        if (Object.keys(record.data).length) changes.push(`${Object.keys(record.data).length} Datenwerte`)
        return { name: record.name, action: record.existing ? 'update' as const : 'create' as const, changes }
      }),
    }
  }

  async importWorkbook(buffer: Buffer): Promise<{ created: number; updated: number }> {
    const { records } = await this.readWorkbook(buffer)
    const transaction = this.db.transaction(() => {
      const fieldsByLabel = new Map(this.listDataFields().map((field) => [field.label.toLocaleLowerCase('de'), field]))
      for (const record of records) {
        const data: Record<string, string> = {}
        for (const [label, value] of Object.entries(record.data)) {
          const key = label.toLocaleLowerCase('de')
          let field = fieldsByLabel.get(key)
          if (!field) { field = this.createDataField({ label }); fieldsByLabel.set(key, field) }
          data[field.key] = value
        }
        if (record.existing) {
          this.updateDevice(record.existing.id, { baseUrl: record.baseUrl, ignoreHttpsErrors: record.ignoreHttpsErrors, credentialId: record.credentialId, data: { ...record.existing.data, ...data } })
        } else {
          this.createDevice({ name: record.name, baseUrl: record.baseUrl, credentialId: record.credentialId, ignoreHttpsErrors: record.ignoreHttpsErrors, data })
        }
      }
    })
    transaction()
    return { created: records.filter((record) => !record.existing).length, updated: records.filter((record) => record.existing).length }
  }

  exportBackup(): Buffer {
    const tableNames = ['credentials', 'app_settings', 'data_fields', 'pipelines', 'pipeline_groups', 'devices', 'runs', 'run_logs', 'artifacts'] as const
    const tables = Object.fromEntries(tableNames.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all()])) as Record<string, Row[]>
    const files: Record<string, { sha256: string; data: string }> = {}
    for (const artifact of tables.artifacts) {
      const path = String(artifact.path)
      if (!existsSync(path)) throw new Error(`Die Datei „${artifact.name}“ fehlt. Das Backup wurde nicht erstellt.`)
      const data = readFileSync(path)
      files[String(artifact.id)] = { sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') }
    }
    return gzipSync(Buffer.from(JSON.stringify({ format: 'autosecurecloud-backup', version: 1, createdAt: now(), tables, files })))
  }

  restoreBackup(buffer: Buffer): { devices: number; pipelines: number; artifacts: number } {
    let backup: { format?: unknown; version?: unknown; tables?: Record<string, unknown>; files?: Record<string, unknown> }
    try { backup = JSON.parse(gunzipSync(buffer, { maxOutputLength: 600 * 1024 * 1024 }).toString('utf8')) }
    catch { throw new Error('Die Backup-Datei ist beschädigt oder hat ein ungültiges Format.') }
    const tableNames = ['credentials', 'app_settings', 'data_fields', 'pipelines', 'pipeline_groups', 'devices', 'runs', 'run_logs', 'artifacts'] as const
    if (!backup || typeof backup !== 'object' || backup.format !== 'autosecurecloud-backup' || backup.version !== 1 || !backup.tables || !backup.files || tableNames.some((table) => !Array.isArray(backup.tables?.[table]))) {
      throw new Error('Dieses Backup-Format wird nicht unterstützt.')
    }
    const tables = backup.tables as Record<(typeof tableNames)[number], Row[]>
    const files = backup.files as Record<string, { sha256?: unknown; data?: unknown }>
    if (tables.app_settings.length !== 1 || tables.app_settings[0]?.id !== 1) {
      throw new Error('Das Backup enthält keine gültigen Anwendungseinstellungen.')
    }
    const restoreDirectory = join(artifactsDirectory, `restore-${randomUUID()}`)
    mkdirSync(restoreDirectory, { recursive: true, mode: 0o700 })
    try {
      for (const artifact of tables.artifacts) {
        if (!artifact || typeof artifact.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(artifact.id) || typeof artifact.name !== 'string') throw new Error('Das Backup enthält ungültige Dateieinträge.')
        const file = files[artifact.id]
        if (!file || typeof file.data !== 'string' || typeof file.sha256 !== 'string') throw new Error(`Die Datei „${artifact.name}“ fehlt im Backup.`)
        const data = Buffer.from(file.data, 'base64')
        if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Die Datei „${artifact.name}“ ist beschädigt.`)
        const path = join(restoreDirectory, `${artifact.id}-${String(artifact.name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)}`)
        writeFileSync(path, data, { mode: 0o600 })
        artifact.path = path
      }
      const transaction = this.db.transaction(() => {
        for (const table of [...tableNames].reverse()) this.db.prepare(`DELETE FROM ${table}`).run()
        for (const table of tableNames) {
          const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((row) => String(row.name))
          for (const row of tables[table]) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Ungültige Einträge in „${table}“ im Backup.`)
            const restoredColumns = columns.filter((column) => Object.hasOwn(row, column))
            const insert = this.db.prepare(`INSERT INTO ${table} (${restoredColumns.join(',')}) VALUES (${restoredColumns.map(() => '?').join(',')})`)
            insert.run(...restoredColumns.map((column) => {
              const value = row[column]
              if (table === 'app_settings' && column === 'logo' && value && typeof value === 'object' && 'data' in value) return Buffer.from((value as { data: number[] }).data)
              return value ?? null
            }))
          }
        }
        this.backfillFileVariables()
        this.db.prepare("UPDATE runs SET status = 'interrupted', error = 'Beim Wiederherstellen eines Backups unterbrochen.', finished_at = ? WHERE status IN ('queued', 'running', 'paused')").run(now())
      })
      transaction()
      return { devices: tables.devices.length, pipelines: tables.pipelines.length, artifacts: tables.artifacts.length }
    } catch (error) {
      rmSync(restoreDirectory, { recursive: true, force: true })
      throw error
    }
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

  private mapPipelineGroup = (row: Row): PipelineGroup => ({
    id: String(row.id), name: String(row.name), description: String(row.description),
    pipelineIds: json<string[]>(row.pipeline_ids_json, []), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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
    stepIndex: row.step_index == null ? undefined : Number(row.step_index), artifactKey: row.artifact_key ? String(row.artifact_key) : undefined,
    runName: row.run_name ? String(row.run_name) : undefined, name: String(row.name),
    mimeType: row.mime_type ? String(row.mime_type) : undefined, size: Number(row.size), kind: row.kind as Artifact['kind'],
    createdAt: String(row.created_at), downloadUrl: `/api/artifacts/${String(row.id)}`,
  })
}

export const appDb = new AppDatabase()
