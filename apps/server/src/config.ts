import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const isProduction = process.env.NODE_ENV === 'production'
export const port = Number(process.env.PORT ?? 4310)
export const host = '127.0.0.1'
export const dataDirectory = resolve(process.env.ASC_DATA_DIR ?? join(homedir(), '.autosecurecloud'))
export const databasePath = join(dataDirectory, 'autosecurecloud.db')
export const artifactsDirectory = join(dataDirectory, 'artifacts')
