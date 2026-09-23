import { describe, expect, it } from 'vitest'
import type { Device, Pipeline } from '@autosecure/shared'
import { inspectDevicePlan, inspectRun } from '../apps/web/src/run-preflight.ts'

const device: Device = { id: 'device', name: 'Firewall', baseUrl: 'https://fw.local', ignoreHttpsErrors: false, data: {}, pipelineIds: ['pipeline'], createdAt: '', updatedAt: '' }
const pipeline: Pipeline = { id: 'pipeline', name: 'Anmeldung', description: '', speed: 'normal', createdAt: '', updatedAt: '', steps: [
  { id: 'user', type: 'fill', locator: { candidates: [{ kind: 'css', value: '#user' }] }, value: { type: 'credentialField', field: 'username' } },
  { id: 'token', type: 'fill', locator: { candidates: [{ kind: 'css', value: '#token' }] }, value: { type: 'deviceField', key: 'token' } },
] }

describe('Prüfung vor einem Lauf', () => {
  it('nennt fehlende Zugangsdaten und Gerätewerte vor dem Start', () => {
    expect(inspectRun(pipeline, device, [pipeline], [], [])).toEqual([
      'Ein Schritt benötigt Zugangsdaten, aber dem Gerät ist kein passendes Profil zugewiesen.',
      'Der Gerätewert „token“ ist leer.',
    ])
  })

  it('prüft den gesamten Geräteablauf mit verschachtelten Automationen', () => {
    const wrapper: Pipeline = { ...pipeline, id: 'wrapper', name: 'Gesamt', steps: [{ id: 'nested', type: 'runPipelines', pipelineIds: ['pipeline'] }] }
    expect(inspectDevicePlan({ ...device, pipelineIds: ['wrapper'] }, [wrapper, pipeline], [], [])).toContain('Der Gerätewert „token“ ist leer.')
  })

  it('erkennt ATV-Dateien aus vorherigen Downloads und das Ergebnis für einen späteren Upload', () => {
    const locator = { candidates: [{ kind: 'css' as const, value: '#file' }] }
    const merge: Pipeline = { ...pipeline, steps: [
      { id: 'first', type: 'download', locator, artifactKey: 'config-a' },
      { id: 'second', type: 'download', locator, artifactKey: 'config-b' },
      { id: 'merge', type: 'mergeAtv', first: { type: 'retainedArtifact', key: 'config-a' }, second: { type: 'retainedArtifact', key: 'config-b' }, outputKey: 'combined', outputName: 'combined.atv' },
      { id: 'upload', type: 'upload', locator, file: { type: 'retainedArtifact', key: 'combined' } },
    ] }
    expect(inspectRun(merge, device, [merge], [], [])).toEqual([
      'Der ATV-Merger nutzt derzeit eine vorläufige Abschnittslogik. Prüfe die Ergebnisdatei vor dem Upload.',
    ])
  })
})
