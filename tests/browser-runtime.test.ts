import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { recorderClientScript, visualizerClientScript } from '../apps/server/src/browser-scripts.ts'
import { resolveLocatorInMatchingContainer } from '../apps/server/src/locator.ts'

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser.close() })

describe('Playwright-Browserintegration', () => {
  it('zeigt Zielrahmen und Fortschritt auch nach einem Dokumentwechsel', async () => {
    const context = await browser.newContext()
    await context.addInitScript({ content: visualizerClientScript })
    const page = await context.newPage()
    await page.setContent('<button id="target">Anmelden</button>')
    await page.locator('#target').evaluate((element) => {
      const win = window as unknown as { __ascVisualize: (element: Element, info: unknown) => void }
      win.__ascVisualize(element, { action: 'click', device: 'Testgerät', index: 2, total: 5, label: 'Anmelden' })
    })
    const state = await page.evaluate(() => ({
      installed: Boolean((window as unknown as { __ascVisualizerInstalled?: boolean }).__ascVisualizerInstalled),
      hostConnected: Boolean(document.querySelector('#__asc-visualizer')?.isConnected),
    }))
    expect(state).toEqual({ installed: true, hostConnected: true })
    await context.close()
  })

  it('zeichnet Klicks auf Textfelder nicht doppelt auf und maskiert Passwörter', async () => {
    const events: Array<Record<string, unknown>> = []
    const context = await browser.newContext()
    await context.exposeBinding('__ascEmit', (_source, payload) => { events.push(payload as Record<string, unknown>) })
    await context.addInitScript({ content: recorderClientScript })
    const page = await context.newPage()
    await page.goto(`data:text/html,${encodeURIComponent('<label for="user">Benutzername</label><input id="user"><label for="pass">Passwort</label><input id="pass" type="password"><button>Anmelden</button>')}`)
    await page.locator('#user').click()
    await page.locator('#user').fill('admin')
    await page.locator('#pass').click()
    await page.locator('#pass').fill('geheim')
    await page.getByRole('button', { name: 'Anmelden' }).click()
    await page.waitForTimeout(50)

    expect(events.filter((event) => event.type === 'click')).toHaveLength(1)
    const passwordEvent = events.find((event) => event.type === 'fill' && event.password === true)
    expect(passwordEvent).toMatchObject({ type: 'fill', value: '', password: true })
    await context.close()
  })

  it('findet einen Download anhand des Profilnamens statt anhand der Zeilennummer', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent(`<table><tbody>
      <tr><td>Profil 1</td><td><button class="download" data-id="one">Herunterladen</button></td></tr>
      <tr><td>Profil 2</td><td><button class="download" data-id="two">Herunterladen</button></td></tr>
      <tr><td>Mein neues Profil</td><td><button class="download" data-id="new">Herunterladen</button></td></tr>
    </tbody></table>`)
    const locator = await resolveLocatorInMatchingContainer(page, {
      description: 'Herunterladen',
      candidates: [{ kind: 'css', value: 'table > tbody > tr:nth-of-type(1) > td:nth-of-type(2) > button.download' }],
    }, 'Mein neues Profil', 'tr')

    expect(await locator.getAttribute('data-id')).toBe('new')
    await context.close()
  })
})
