import { chromium } from 'playwright'
import type { Credential } from '@autosecure/shared'
import { chromiumExecutablePath } from './config.ts'

export const launchChromium = () => chromium.launch({
  headless: false,
  ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
})

export const httpCredentialsForUrl = (url: string, credential?: Credential) => {
  if (!credential || (!credential.username && !credential.password)) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return {
      origin: parsed.origin,
      username: credential.username,
      password: credential.password ?? '',
    }
  } catch {
    return undefined
  }
}
