import { describe, expect, it } from 'vitest'
import { makeId, speedDelay, stepNames } from '../packages/shared/src/index.ts'

describe('gemeinsame Pipeline-Typen', () => {
  it('stellt die sichtbaren Wiedergabegeschwindigkeiten bereit', () => {
    expect(speedDelay.slow).toBeGreaterThan(speedDelay.normal)
    expect(speedDelay.normal).toBeGreaterThan(speedDelay.fast)
    expect(speedDelay.normal).toBe(500)
  })

  it('liefert eindeutige IDs und deutsche Schrittnamen', () => {
    expect(makeId('step')).not.toBe(makeId('step'))
    expect(stepNames.extractText).toBe('Text erfassen')
    expect(stepNames.download).toBe('Datei herunterladen')
  })
})
