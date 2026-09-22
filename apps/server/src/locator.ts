import type { Frame, Locator, Page } from 'playwright'
import type { LocatorCandidate, LocatorSpec } from '@autosecure/shared'

function fromCandidate(scope: Page | Frame, candidate: LocatorCandidate): Locator {
  switch (candidate.kind) {
    case 'role': return scope.getByRole(candidate.value as Parameters<Page['getByRole']>[0], { name: candidate.name, exact: candidate.exact })
    case 'label': return scope.getByLabel(candidate.value, { exact: candidate.exact })
    case 'testId': return scope.getByTestId(candidate.value)
    case 'placeholder': return scope.getByPlaceholder(candidate.value, { exact: candidate.exact })
    case 'text': return scope.getByText(candidate.value, { exact: candidate.exact })
    default: return scope.locator(candidate.value)
  }
}

export async function resolveLocator(page: Page, spec: LocatorSpec): Promise<Locator> {
  let scope: Page | Frame = page
  if (spec.framePath?.length) {
    for (const frameSelector of spec.framePath) {
      const handle = await scope.locator(frameSelector).elementHandle()
      const frame: Frame | null = handle ? await handle.contentFrame() : null
      if (!frame) throw new Error(`Frame nicht gefunden: ${frameSelector}`)
      scope = frame
    }
  }
  let fallback: Locator | undefined
  for (const candidate of spec.candidates) {
    const locator = fromCandidate(scope, candidate).first()
    fallback ??= locator
    try {
      if (await locator.count()) return locator
    } catch { /* try next locator */ }
  }
  if (!fallback) throw new Error('Dieser Schritt enthält keinen gültigen Selektor.')
  return fallback
}

export function describeLocator(spec: LocatorSpec) {
  return spec.description || spec.candidates[0]?.name || spec.candidates[0]?.value || 'Element'
}
