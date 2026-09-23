import { chromium } from 'playwright'
import { chromiumExecutablePath } from './config.ts'

export const launchChromium = () => chromium.launch({
  headless: false,
  ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
})
