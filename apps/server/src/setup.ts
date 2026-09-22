import { appDb } from './database.ts'
import { dataDirectory } from './config.ts'

appDb.close()
console.log(`AutoSecureCloud wurde vorbereitet: ${dataDirectory}`)
