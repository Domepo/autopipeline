import type { Frame, Locator, Page } from 'playwright'
import type { LocatorCandidate, LocatorSpec } from '@autosecure/shared'

type LocatorScope = Page | Frame | Locator

function fromCandidate(scope: LocatorScope, candidate: LocatorCandidate): Locator {
  switch (candidate.kind) {
    case 'role': return scope.getByRole(candidate.value as Parameters<Page['getByRole']>[0], { name: candidate.name, exact: candidate.exact })
    case 'label': return scope.getByLabel(candidate.value, { exact: candidate.exact })
    case 'testId': return scope.getByTestId(candidate.value)
    case 'placeholder': return scope.getByPlaceholder(candidate.value, { exact: candidate.exact })
    case 'text': return scope.getByText(candidate.value, { exact: candidate.exact })
    default: return scope.locator(candidate.value)
  }
}

async function withFrame(page: Page, spec: LocatorSpec): Promise<Page | Frame> {
  let scope: Page | Frame = page
  if (spec.framePath?.length) {
    for (const frameSelector of spec.framePath) {
      const handle = await scope.locator(frameSelector).elementHandle()
      const frame: Frame | null = handle ? await handle.contentFrame() : null
      if (!frame) throw new Error(`Frame nicht gefunden: ${frameSelector}`)
      scope = frame
    }
  }
  return scope
}

async function firstAvailable(scope: LocatorScope, spec: LocatorSpec, first: boolean): Promise<Locator> {
  let fallback: Locator | undefined
  for (const candidate of spec.candidates) {
    // Zielseiten behalten Dialoge, Tabs und Karten oft unsichtbar im DOM. Für
    // sichtbare Automation darf ein solches Duplikat nie vor dem sichtbaren
    // Element gewinnen.
    const matches = fromCandidate(scope, candidate).filter({ visible: true })
    const locator = first ? matches.first() : matches
    fallback ??= locator
    try {
      if (await locator.count()) return locator
    } catch { /* try next locator */ }
  }
  if (!fallback) throw new Error('Dieser Schritt enthält keinen gültigen Selektor.')
  return fallback
}

export async function resolveLocator(page: Page, spec: LocatorSpec): Promise<Locator> {
  return firstAvailable(await withFrame(page, spec), spec, true)
}

export async function resolveLocatorAll(page: Page, spec: LocatorSpec): Promise<Locator> {
  return firstAvailable(await withFrame(page, spec), spec, false)
}

export async function resolveLocatorWithin(scope: Locator, spec: LocatorSpec): Promise<Locator> {
  if (spec.framePath?.length) throw new Error('Relative Selektoren können keinen zusätzlichen Frame öffnen.')
  return firstAvailable(scope, spec, true)
}

function relativeToContainer(spec: LocatorSpec): LocatorSpec {
  return {
    ...spec,
    candidates: spec.candidates.map((candidate) => {
      if (candidate.kind !== 'css') return candidate
      const parts = candidate.value.split(/\s*>\s*/)
      let rowIndex = -1
      for (let index = parts.length - 1; index >= 0; index--) {
        if (/^tr(?:$|[.#:\[])/i.test(parts[index].trim())) { rowIndex = index; break }
      }
      if (rowIndex < 0 || rowIndex === parts.length - 1) return candidate
      return { ...candidate, value: parts.slice(rowIndex + 1).join(' > ') }
    }),
  }
}

/** Finds the recorded action inside the list/table entry containing matchText. */
export async function resolveLocatorInMatchingContainer(page: Page, spec: LocatorSpec, matchText: string, containerSelector = 'tr, [role="row"], li, article'): Promise<Locator> {
  const normalized = matchText.trim()
  if (!normalized) throw new Error('Der Vergleichswert für den dynamischen Download ist leer.')
  const scope = await withFrame(page, spec)
  const containers = scope.locator(containerSelector).filter({ visible: true })
  const relativeSpec = relativeToContainer({ ...spec, framePath: undefined })
  const count = await containers.count()

  const tryContainer = async (container: Locator) => {
    const exactText = container.getByText(normalized, { exact: true }).filter({ visible: true })
    if (!await exactText.count()) return undefined
    const target = await firstAvailable(container, relativeSpec, true)
    return await target.count() ? target : undefined
  }

  for (let index = 0; index < count; index++) {
    const target = await tryContainer(containers.nth(index))
    if (target) return target
  }

  // Some old appliance UIs render the name as an input value instead of text.
  // The fallback still scopes the action to the matching row/container.
  for (let index = 0; index < count; index++) {
    const container = containers.nth(index)
    if (!(await container.innerText()).includes(normalized)) continue
    const target = await firstAvailable(container, relativeSpec, true)
    if (await target.count()) return target
  }

  throw new Error(`Kein Eintrag mit „${normalized}“ für den Download gefunden.`)
}

export function describeLocator(spec: LocatorSpec) {
  return spec.description || spec.candidates[0]?.name || spec.candidates[0]?.value || 'Element'
}
