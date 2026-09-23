import type { Artifact, Credential, Device, FileSource, Pipeline, PipelineStep, ValueSource } from '@autosecure/shared'

export function inspectRun(pipeline: Pipeline, device: Device, pipelines: Pipeline[], credentials: Credential[], artifacts: Artifact[], downloadsInRun = new Set<string>()): string[] {
  const warnings = new Set<string>()
  const visited = new Set<string>()

  const checkFile = (file: FileSource, label: string) => {
    if (file.type === 'localFile' && !file.path.trim()) warnings.add(`Für ${label} fehlt der lokale Dateipfad.`)
    if (file.type === 'dataFile' && !downloadsInRun.has(file.key) && !artifacts.some((artifact) => artifact.id === device.data[file.key] && artifact.deviceId === device.id)) warnings.add(`Die Dateivariable „${file.key || 'ohne Namen'}“ ist für dieses Gerät leer oder die Datei fehlt.`)
    if (file.type === 'retainedArtifact' && !downloadsInRun.has(file.key) && !artifacts.some((artifact) => artifact.deviceId === device.id && artifact.artifactKey === file.key)) warnings.add(`Die Datei „${file.key || 'ohne Schlüssel'}“ ist für dieses Gerät nicht vorhanden.`)
  }

  const checkValue = (source: ValueSource) => {
    if (source.type === 'credentialField') {
      const credential = credentials.find((item) => item.id === (source.credentialId || device.credentialId))
      if (!credential) warnings.add('Ein Schritt benötigt Zugangsdaten, aber dem Gerät ist kein passendes Profil zugewiesen.')
      else if (source.field === 'password' && !credential.hasPassword) warnings.add(`Im Profil „${credential.name}“ fehlt das Passwort.`)
    }
    if (source.type === 'deviceField' && !['name', 'baseUrl'].includes(source.key) && !device.data[source.key]) warnings.add(`Der Gerätewert „${source.key}“ ist leer.`)
    if (source.type === 'literal') {
      for (const match of source.value.matchAll(/\{\{data\.([^}]+)\}\}/g)) {
        if (!device.data[match[1]]) warnings.add(`Der Gerätewert „${match[1]}“ ist leer.`)
      }
    }
  }

  const checkStep = (step: PipelineStep) => {
    if (step.type === 'navigate') checkValue(step.url)
    if (step.type === 'fill' || step.type === 'select') checkValue(step.value)
    if (step.type === 'download') {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(step.artifactKey)) warnings.add('Der Dateivariable fehlt ein gültiger Name.')
      if (step.match && step.match.source.type !== 'stepValue') checkValue(step.match.source)
      downloadsInRun.add(step.artifactKey)
    }
    if (step.type === 'upload') {
      checkFile(step.file, 'einen Upload-Schritt')
    }
    if (step.type === 'mergeAtv') {
      checkFile(step.first, 'ATV-Datei A')
      checkFile(step.second, 'ATV-Datei B')
      if (JSON.stringify(step.first) === JSON.stringify(step.second)) warnings.add('Für den ATV-Merge müssen zwei verschiedene Dateien gewählt werden.')
      if (!step.outputKey.trim()) warnings.add('Für den ATV-Merge fehlt der Ergebnisschlüssel.')
      else if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(step.outputKey)) warnings.add('Der Name der Ergebnisvariable ist ungültig.')
      if (!/\.atv$/i.test(step.outputName)) warnings.add('Der Ergebnisdateiname muss auf .atv enden.')
      downloadsInRun.add(step.outputKey)
      warnings.add('Der ATV-Merger nutzt derzeit eine vorläufige Abschnittslogik. Prüfe die Ergebnisdatei vor dem Upload.')
    }
    if (step.type === 'discoverDevices' && !step.sourceDeviceId) warnings.add('Im Suchschritt fehlt das Quellgerät.')
    if (step.type === 'runPipelines') for (const id of step.pipelineIds) {
      const nested = pipelines.find((item) => item.id === id)
      if (nested) checkPipeline(nested)
      else warnings.add(`Eine verknüpfte Automation wurde nicht gefunden (${id}).`)
    }
  }

  const checkPipeline = (current: Pipeline) => {
    if (visited.has(current.id)) return
    visited.add(current.id)
    if (!current.steps.length) warnings.add(`„${current.name}“ enthält keine Schritte.`)
    current.steps.forEach(checkStep)
  }

  try {
    const url = new URL(device.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) warnings.add('Die Start-URL muss mit http:// oder https:// beginnen.')
  } catch { warnings.add('Die Start-URL des Geräts ist ungültig.') }
  checkPipeline(pipeline)
  return [...warnings]
}

export function inspectDevicePlan(device: Device, pipelines: Pipeline[], credentials: Credential[], artifacts: Artifact[]): string[] {
  const warnings = new Set<string>()
  const downloadsInRun = new Set<string>()
  if (!device.pipelineIds.length) warnings.add('Dem Gerät ist noch keine Automation zugewiesen.')
  for (const id of device.pipelineIds) {
    const pipeline = pipelines.find((item) => item.id === id)
    if (!pipeline) warnings.add(`Eine zugeordnete Automation wurde nicht gefunden (${id}).`)
    else inspectRun(pipeline, device, pipelines, credentials, artifacts, downloadsInRun).forEach((warning) => warnings.add(warning))
  }
  return [...warnings]
}
