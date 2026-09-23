import { describe, expect, it } from 'vitest'
import type { Pipeline, PipelineStep } from '../packages/shared/src/index.ts'
import { expandPipelineCalls } from '../apps/server/src/pipeline-expansion.ts'

const pipeline = (id: string, name: string, steps: PipelineStep[]): Pipeline => ({
  id, name, description: '', speed: 'normal', steps,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('Zwischenabläufe', () => {
  it('führt eingebettete Automationen an der gewählten Stelle aus und setzt danach fort', () => {
    const login = pipeline('login', 'Anmeldung', [
      { id: 'open', type: 'navigate', url: { type: 'deviceField', key: 'baseUrl' } },
      { id: 'pause', type: 'runPipelines', pipelineIds: ['license', 'upload'] },
      { id: 'logout', type: 'click', label: 'Abmelden', locator: { candidates: [{ kind: 'text', value: 'Abmelden' }] } },
    ])
    const license = pipeline('license', 'Lizenz erzeugen', [{ id: 'create', type: 'click', label: 'Erzeugen', locator: { candidates: [{ kind: 'text', value: 'Erzeugen' }] } }])
    const upload = pipeline('upload', 'Lizenz hochladen', [{ id: 'upload-file', type: 'upload', locator: { candidates: [{ kind: 'css', value: 'input[type=file]' }] }, file: { type: 'retainedArtifact', key: 'lizenz' } }])
    const lookup = new Map([login, license, upload].map((item) => [item.id, item]))

    const expanded = expandPipelineCalls(login, (id) => lookup.get(id))

    expect(expanded.steps.map((step) => step.type)).toEqual(['navigate', 'beginSubflow', 'click', 'endSubflow', 'beginSubflow', 'upload', 'endSubflow', 'click'])
    expect(expanded.steps.map((step) => step.label)).toEqual([
      undefined,
      'Anmeldung pausieren · Lizenz erzeugen starten',
      'Lizenz erzeugen · Erzeugen',
      'Lizenz erzeugen beendet · Anmeldung fortsetzen',
      'Anmeldung pausieren · Lizenz hochladen starten',
      'Lizenz hochladen · Datei hochladen',
      'Lizenz hochladen beendet · Anmeldung fortsetzen',
      'Abmelden',
    ])
  })

  it('behält dynamische Schrittverknüpfungen nach dem Einbetten bei', () => {
    const child = pipeline('child', 'Profil laden', [
      { id: 'name', type: 'fill', locator: { candidates: [{ kind: 'css', value: '#name' }] }, value: { type: 'literal', value: 'Profil A' } },
      { id: 'download', type: 'download', locator: { candidates: [{ kind: 'text', value: 'Herunterladen' }] }, artifactKey: 'profil', match: { source: { type: 'stepValue', stepId: 'name' }, containerSelector: 'tr' } },
    ])
    const root = pipeline('root', 'Hauptablauf', [{ id: 'call', type: 'runPipelines', pipelineIds: ['child'] }])
    const expanded = expandPipelineCalls(root, (id) => id === child.id ? child : undefined)
    const fill = expanded.steps.find((step) => step.type === 'fill')!
    const download = expanded.steps.find((step) => step.type === 'download')!

    expect(download.type).toBe('download')
    if (download.type !== 'download' || download.match?.source.type !== 'stepValue') throw new Error('Download wurde nicht korrekt erweitert.')
    expect(download.match.source.stepId).toBe(fill.id)
    expect(download.match.source.stepId).not.toBe('name')
  })

  it('verhindert gegenseitige Aufrufe', () => {
    const first = pipeline('first', 'Automation A', [{ id: 'call-b', type: 'runPipelines', pipelineIds: ['second'] }])
    const second = pipeline('second', 'Automation B', [{ id: 'call-a', type: 'runPipelines', pipelineIds: ['first'] }])
    const lookup = new Map([first, second].map((item) => [item.id, item]))

    expect(() => expandPipelineCalls(first, (id) => lookup.get(id))).toThrow('Automation A → Automation B → Automation A')
  })
})
