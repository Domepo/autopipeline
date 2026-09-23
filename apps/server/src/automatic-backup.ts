import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomaticBackup } from '@autosecure/shared'
import { backupsDirectory } from './config.ts'
import type { AppDatabase } from './database.ts'

const backupName = /^autosecurecloud-auto-[\dT-]+Z-[a-f0-9-]+\.asc\.gz$/
const intervals = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 }

export class AutomaticBackupService {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastAttemptAt = 0

  constructor(private db: AppDatabase, private isWorkspaceBusy: () => boolean) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), 60_000)
    this.check()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  resetRetryDelay() { this.lastAttemptAt = 0 }

  check() {
    const settings = this.db.getSettings()
    if (settings.automaticBackupInterval === 'off' || this.running || this.isWorkspaceBusy()) return
    const period = intervals[settings.automaticBackupInterval]
    const last = settings.lastAutomaticBackupAt ? Date.parse(settings.lastAutomaticBackupAt) : 0
    if (Number.isFinite(last) && Date.now() - last < period) return
    if (Date.now() - this.lastAttemptAt < 5 * 60_000) return
    this.running = true
    this.lastAttemptAt = Date.now()
    try {
      const data = this.db.exportBackup()
      mkdirSync(backupsDirectory, { recursive: true, mode: 0o700 })
      chmodSync(backupsDirectory, 0o700)
      const name = `autosecurecloud-auto-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.asc.gz`
      const path = join(backupsDirectory, name)
      const temporary = `${path}.tmp`
      try {
        writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
      this.db.recordAutomaticBackup(null, new Date().toISOString())
      this.prune(settings.automaticBackupRetention)
      this.lastAttemptAt = 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.recordAutomaticBackup(message)
    } finally {
      this.running = false
    }
  }

  list(): AutomaticBackup[] {
    if (!existsSync(backupsDirectory)) return []
    return readdirSync(backupsDirectory)
      .filter((name) => backupName.test(name) && lstatSync(join(backupsDirectory, name)).isFile())
      .map((name) => {
        const stats = statSync(join(backupsDirectory, name))
        return { name, createdAt: stats.mtime.toISOString(), size: stats.size }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  prune(retention: number) {
    for (const old of this.list().slice(retention)) rmSync(join(backupsDirectory, old.name))
  }

  read(name: string): Buffer | null {
    if (!backupName.test(name)) return null
    const path = join(backupsDirectory, name)
    return existsSync(path) && lstatSync(path).isFile() ? readFileSync(path) : null
  }
}
