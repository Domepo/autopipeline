import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineStep } from '../packages/shared/src/index.ts'
import { createMergedAtv, mergeAtvFiles } from '../apps/server/src/atv-merge.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('vorläufiger ATV-Merger', () => {
  it('behält einzelne Abschnitte, ersetzt gleiche Schlüssel und ergänzt neue Abschnitte', () => {
    const first = Buffer.from('// Basis\nFIRST = "a"\nSHARED = {\n  { rid = "1"\n    VALUE = "alt"\n  }\n}\n')
    const second = Buffer.from('SHARED = {\n  { rid = "2"\n    VALUE = "neu"\n  }\n}\nSECOND = "b"\n')

    const result = mergeAtvFiles(first, second)

    expect(result).toMatchObject({ retained: 1, replaced: 1, added: 1 })
    expect(result.content.toString()).toBe('// Basis\nFIRST = "a"\nSHARED = {\n  { rid = "2"\n    VALUE = "neu"\n  }\n}\nSECOND = "b"\n')
    expect(first.toString()).toContain('VALUE = "alt"')
  })

  it('lehnt unvollständige oder binäre Dateien ab', () => {
    expect(() => mergeAtvFiles(Buffer.from('BLOCK = {\n'), Buffer.from('OTHER = "x"\n'))).toThrow('nicht vollständig geschlossen')
    expect(() => mergeAtvFiles(Buffer.from([0, 1, 2]), Buffer.from('OTHER = "x"\n'))).toThrow('Binäre ATV-Dateien')
  })

  it('schreibt eine neue ATV-Datei, ohne die Eingaben zu verändern', () => {
    const directory = mkdtempSync(join(tmpdir(), 'asc-atv-'))
    directories.push(directory)
    const first = join(directory, 'first.atv')
    const second = join(directory, 'second.atv')
    writeFileSync(first, 'ONE = "1"\n')
    writeFileSync(second, 'TWO = "2"\n')
    const step: Extract<PipelineStep, { type: 'mergeAtv' }> = {
      id: 'merge', type: 'mergeAtv', first: { type: 'localFile', path: first }, second: { type: 'localFile', path: second }, outputKey: 'merged', outputName: 'result.atv',
    }

    const result = createMergedAtv(step, (file) => file.type === 'localFile' ? file.path : '', directory)

    expect(result.path).not.toBe(first)
    expect(result.path).not.toBe(second)
    expect(readFileSync(result.path, 'utf8')).toBe('ONE = "1"\nTWO = "2"\n')
    expect(readFileSync(first, 'utf8')).toBe('ONE = "1"\n')
    expect(readFileSync(second, 'utf8')).toBe('TWO = "2"\n')
    expect(() => createMergedAtv({ ...step, second: step.first }, (file) => file.type === 'localFile' ? file.path : '', directory)).toThrow('zwei verschiedene Dateien')
  })
})
