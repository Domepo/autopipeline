import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileSource, PipelineStep } from '@autosecure/shared'

type MergeStep = Extract<PipelineStep, { type: 'mergeAtv' }>

export function createMergedAtv(step: MergeStep, resolveSource: (source: FileSource) => string, directory: string) {
  const first = resolveSource(step.first)
  const second = resolveSource(step.second)
  if (!first || !existsSync(first)) throw new Error(`ATV-Datei A nicht gefunden: ${first || 'keine Quelle ausgewählt'}`)
  if (!second || !existsSync(second)) throw new Error(`ATV-Datei B nicht gefunden: ${second || 'keine Quelle ausgewählt'}`)
  if (resolve(first) === resolve(second)) throw new Error('Für den ATV-Merge müssen zwei verschiedene Dateien ausgewählt werden.')
  for (const [label, path] of [['A', first], ['B', second]]) {
    if (extname(path).toLowerCase() !== '.atv') throw new Error(`Datei ${label} muss die Endung .atv haben.`)
    if (statSync(path).size > 20 * 1024 * 1024) throw new Error(`ATV-Datei ${label} ist größer als 20 MB.`)
  }
  const outputKey = step.outputKey.trim()
  const outputName = step.outputName.trim()
  if (!outputKey) throw new Error('Für den ATV-Merge fehlt der Ergebnisschlüssel.')
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(outputKey)) throw new Error('Der Name der Ergebnisvariable ist ungültig.')
  if (!outputName || !/\.atv$/i.test(outputName) || /[/\\]/.test(outputName)) throw new Error('Der Ergebnisdateiname muss auf .atv enden und darf keinen Pfad enthalten.')
  const merged = mergeAtvFiles(readFileSync(first), readFileSync(second))
  const safePart = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'datei'
  const path = join(directory, `${safePart(outputKey)}__${randomUUID()}__${safePart(outputName)}`)
  writeFileSync(path, merged.content, { mode: 0o600 })
  return { path, outputKey, outputName, ...merged }
}

/**
 * Provisional ATV merge. Replace this function when the device-specific merge
 * rules are available. Top-level keys are the only semantic boundary here:
 * the second file replaces a matching section, while unique sections survive.
 */
export function mergeAtvFiles(first: Buffer, second: Buffer): { content: Buffer; retained: number; replaced: number; added: number } {
  const base = parseAtv(first, 'Datei A')
  const overlay = parseAtv(second, 'Datei B')
  const secondByKey = new Map(overlay.sections.map((section) => [section.key, section.content]))
  const firstKeys = new Set(base.sections.map((section) => section.key))
  const sections = base.sections.map((section) => secondByKey.has(section.key)
    ? secondByKey.get(section.key)!
    : section.content)
  sections.push(...overlay.sections.filter((section) => !firstKeys.has(section.key)).map((section) => section.content))
  const merged = [base.preamble, ...sections].filter(Boolean).join('\n').trimEnd() + '\n'
  parseAtv(Buffer.from(merged), 'Ergebnis')
  return {
    content: Buffer.from(merged),
    retained: base.sections.length - [...firstKeys].filter((key) => secondByKey.has(key)).length,
    replaced: [...firstKeys].filter((key) => secondByKey.has(key)).length,
    added: overlay.sections.filter((section) => !firstKeys.has(section.key)).length,
  }
}

function parseAtv(buffer: Buffer, label: string): { preamble: string; sections: Array<{ key: string; content: string }> } {
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error(`${label}: ATV-Dateien müssen zwischen 1 Byte und 20 MB groß sein.`)
  let source: string
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { throw new Error(`${label}: Diese ATV-Datei ist kein gültiger UTF-8-Text.`) }
  if (source.includes('\0')) throw new Error(`${label}: Binäre ATV-Dateien werden vom vorläufigen Merger nicht unterstützt.`)
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const sections: Array<{ key: string; content: string }> = []
  const seen = new Set<string>()
  let depth = 0
  let quoted = false
  let escaped = false
  let start = -1
  let key = ''
  let preamble = ''

  const finish = (end: number) => {
    if (start < 0) { preamble = lines.slice(0, end).join('\n').replace(/\n+$/, ''); return }
    sections.push({ key, content: lines.slice(start, end).join('\n').replace(/\n+$/, '') })
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (depth === 0 && !quoted) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
      if (match) {
        finish(index)
        key = match[1]
        if (seen.has(key)) throw new Error(`${label}: Der Hauptabschnitt „${key}“ ist mehrfach vorhanden.`)
        seen.add(key)
        start = index
      } else if (line.trim() && !line.trimStart().startsWith('//')) {
        throw new Error(`${label}: Zeile ${index + 1} liegt außerhalb eines ATV-Abschnitts.`)
      }
    }
    for (let column = 0; column < line.length; column++) {
      const character = line[column]
      if (escaped) { escaped = false; continue }
      if (quoted && character === '\\') { escaped = true; continue }
      if (character === '"') { quoted = !quoted; continue }
      if (quoted) continue
      if (character === '/' && line[column + 1] === '/') break
      if (character === '{') depth++
      if (character === '}') depth--
      if (depth < 0) throw new Error(`${label}: In Zeile ${index + 1} steht eine schließende Klammer ohne Anfang.`)
    }
    if (quoted) throw new Error(`${label}: In Zeile ${index + 1} wurde ein Textwert nicht abgeschlossen.`)
  }
  if (depth !== 0) throw new Error(`${label}: Die geschweiften Klammern sind nicht vollständig geschlossen.`)
  finish(lines.length)
  if (!sections.length) throw new Error(`${label}: Es wurden keine ATV-Einstellungen gefunden.`)
  return { preamble, sections }
}
