import { randomUUID } from 'node:crypto'
import type { Pipeline, PipelineStep } from '@autosecure/shared'
import { stepNames } from '@autosecure/shared'

/** Replaces Zwischenablauf steps with immutable copies of their target pipelines. */
export function expandPipelineCalls(root: Pipeline, lookup: (id: string) => Pipeline | undefined): Pipeline {
  const expand = (pipeline: Pipeline, stack: Pipeline[]): PipelineStep[] => {
    const idMap = new Map(pipeline.steps.filter((step) => step.type !== 'runPipelines').map((step) => [step.id, randomUUID()]))
    const result: PipelineStep[] = []

    for (const step of pipeline.steps) {
      if (step.type === 'runPipelines') {
        if (!step.pipelineIds.length) throw new Error(`Im Zwischenablauf „${step.label || stepNames.runPipelines}“ wurde keine Automation ausgewählt.`)
        for (const pipelineId of step.pipelineIds) {
          const nested = lookup(pipelineId)
          if (!nested) throw new Error(`Eine eingebettete Automation wurde nicht gefunden: ${pipelineId}`)
          const cycleAt = stack.findIndex((item) => item.id === nested.id)
          if (cycleAt >= 0) {
            const cycle = [...stack.slice(cycleAt), nested].map((item) => item.name).join(' → ')
            throw new Error(`Automationen können sich nicht gegenseitig aufrufen: ${cycle}`)
          }
          result.push({ id: randomUUID(), type: 'beginSubflow', pipelineName: nested.name, label: `${pipeline.name} pausieren · ${nested.name} starten` })
          result.push(...expand(nested, [...stack, nested]).map((nestedStep) => ({
            ...nestedStep,
            label: `${nested.name} · ${nestedStep.label || stepNames[nestedStep.type]}`,
          } as PipelineStep)))
          result.push({ id: randomUUID(), type: 'endSubflow', pipelineName: nested.name, label: `${nested.name} beendet · ${pipeline.name} fortsetzen` })
        }
        continue
      }

      const cloned = { ...structuredClone(step), id: idMap.get(step.id)!, playbackSpeed: step.playbackSpeed ?? pipeline.speed } as PipelineStep
      if (cloned.type === 'download' && cloned.match?.source.type === 'stepValue') {
        const mapped = idMap.get(cloned.match.source.stepId)
        if (mapped) cloned.match = { ...cloned.match, source: { ...cloned.match.source, stepId: mapped } }
      }
      result.push(cloned)
    }
    return result
  }

  return { ...structuredClone(root), steps: expand(root, [root]), updatedAt: new Date().toISOString() }
}
