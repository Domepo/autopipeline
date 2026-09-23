export type PlaybackSpeed = 'slow' | 'normal' | 'fast'
export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface AppSettings {
  title: string
  subtitle: string
  logoUrl: string | null
  storagePath: string
  actionTimeoutMs: number
  navigationTimeoutMs: number
  downloadTimeoutMs: number
  automaticBackupInterval: 'off' | 'daily' | 'weekly'
  automaticBackupRetention: number
  lastAutomaticBackupAt: string | null
  automaticBackupError: string | null
  backupDirectory: string
}

export interface AutomaticBackup {
  name: string
  createdAt: string
  size: number
}

export interface WorkbookImportPreview {
  created: number
  updated: number
  rows: Array<{ name: string; action: 'create' | 'update'; changes: string[] }>
  warnings: string[]
}
export type LocatorKind = 'role' | 'label' | 'testId' | 'placeholder' | 'text' | 'css'

export interface LocatorCandidate {
  kind: LocatorKind
  value: string
  name?: string
  exact?: boolean
}

export interface LocatorSpec {
  candidates: LocatorCandidate[]
  framePath?: string[]
  pageAlias?: string
  description?: string
}

export interface DiscoveryCollectionLevel {
  id: string
  label: string
  items: LocatorSpec
  itemLabel?: LocatorSpec
  open?: LocatorSpec
  leave: { type: 'back' } | { type: 'click'; locator: LocatorSpec }
}

export interface DiscoveryField {
  key: string
  label: string
  locator: LocatorSpec
  required?: boolean
}

export interface DiscoveryRecordConfig {
  items: LocatorSpec
  name: LocatorSpec
  open: LocatorSpec
  afterOpen: LocatorSpec[]
  fields: DiscoveryField[]
  close?: LocatorSpec
}

export type ValueSource =
  | { type: 'literal'; value: string }
  | { type: 'deviceField'; key: string }
  | { type: 'credentialField'; field: 'username' | 'password'; credentialId?: string }
  | { type: 'runValue'; key: string }

export type DownloadMatchSource = ValueSource | { type: 'stepValue'; stepId: string }

export type FileSource =
  | { type: 'dataFile'; key: string }
  | { type: 'retainedArtifact'; key: string }
  | { type: 'localFile'; path: string }

interface BaseStep {
  id: string
  label?: string
  timeoutMs?: number
  playbackSpeed?: PlaybackSpeed
}

export type PipelineStep =
  | (BaseStep & { type: 'navigate'; url: ValueSource })
  | (BaseStep & { type: 'click'; locator: LocatorSpec })
  | (BaseStep & { type: 'fill'; locator: LocatorSpec; value: ValueSource })
  | (BaseStep & { type: 'select'; locator: LocatorSpec; value: ValueSource })
  | (BaseStep & { type: 'toggle'; locator: LocatorSpec; checked: boolean })
  | (BaseStep & { type: 'press'; locator?: LocatorSpec; key: string })
  | (BaseStep & { type: 'extractText'; locator: LocatorSpec; key: string; persist: boolean })
  | (BaseStep & { type: 'waitFor'; locator?: LocatorSpec; milliseconds?: number })
  | (BaseStep & {
      type: 'download'
      locator: LocatorSpec
      artifactKey: string
      match?: { source: DownloadMatchSource; containerSelector?: string }
    })
  | (BaseStep & { type: 'upload'; locator: LocatorSpec; file: FileSource })
  | (BaseStep & { type: 'mergeAtv'; first: FileSource; second: FileSource; outputKey: string; outputName: string })
  | (BaseStep & { type: 'runPipelines'; pipelineIds: string[] })
  | (BaseStep & { type: 'beginSubflow'; pipelineName: string })
  | (BaseStep & { type: 'endSubflow'; pipelineName: string })
  | (BaseStep & {
      type: 'discoverDevices'
      sourceDeviceId?: string
      collections: DiscoveryCollectionLevel[]
      record: DiscoveryRecordConfig
      addressKey: string
      requiredTypeKey?: string
      requiredTypeValue?: string
      baseUrlTemplate: string
      duplicatePolicy: 'firstWins' | 'lastWins'
      apply: boolean
    })

export interface Credential {
  id: string
  name: string
  username: string
  hasPassword: boolean
  password?: string
  createdAt: string
  updatedAt: string
}

export interface Device {
  id: string
  name: string
  baseUrl: string
  credentialId?: string
  credentialName?: string
  ignoreHttpsErrors: boolean
  data: Record<string, string>
  pipelineIds: string[]
  createdAt: string
  updatedAt: string
}

export type DataFieldType = 'text' | 'number' | 'date' | 'url' | 'file'

export interface DataField {
  id: string
  key: string
  label: string
  type: DataFieldType
  position: number
  createdAt: string
  updatedAt: string
}

export interface Pipeline {
  id: string
  name: string
  description: string
  speed: PlaybackSpeed
  steps: PipelineStep[]
  stages?: PipelineStage[]
  createdAt: string
  updatedAt: string
}

export interface PipelineGroup {
  id: string
  name: string
  description: string
  pipelineIds: string[]
  createdAt: string
  updatedAt: string
}

export interface PipelineStage {
  pipelineId: string
  name: string
  stepCount: number
}

export interface Artifact {
  id: string
  runId: string
  deviceId?: string
  stepIndex?: number
  artifactKey?: string
  runName?: string
  name: string
  kind: 'download' | 'screenshot' | 'other'
  mimeType?: string
  size: number
  createdAt: string
  downloadUrl: string
}

export interface RunLog {
  id: number
  runId: string
  deviceId?: string
  stepIndex?: number
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  createdAt: string
}

export interface Run {
  id: string
  pipelineId: string
  pipelineName: string
  deviceIds: string[]
  status: RunStatus
  currentDeviceId?: string
  currentDeviceName?: string
  currentStep?: number
  totalSteps: number
  stages?: PipelineStage[]
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  logs?: RunLog[]
  artifacts?: Artifact[]
}

export type SocketEvent =
  | { type: 'snapshot'; recording: RecordingStatus | null }
  | { type: 'workspace.restored' }
  | { type: 'workspace.cleared' }
  | { type: 'data.changed' }
  | { type: 'pipeline.updated'; pipeline: Pipeline }
  | { type: 'device.updated'; device: Device }
  | { type: 'recording.status'; recording: RecordingStatus | null }
  | { type: 'run.updated'; run: Run }
  | { type: 'run.log'; log: RunLog }

export interface RecordingStatus {
  pipelineId: string
  deviceId?: string
  active: boolean
  mode: 'record' | 'extract'
  phase: 'opening' | 'replaying' | 'recording'
  replayStep?: number
  replayTotal?: number
  insertAfterStep?: number
  startedAt: string
  url: string
}

export const speedDelay: Record<PlaybackSpeed, number> = {
  slow: 950,
  normal: 500,
  fast: 180,
}

export function makeId(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export const stepNames: Record<PipelineStep['type'], string> = {
  navigate: 'Seite öffnen',
  click: 'Klicken',
  fill: 'Text eingeben',
  select: 'Auswahl setzen',
  toggle: 'Schalter setzen',
  press: 'Taste drücken',
  extractText: 'Text erfassen',
  waitFor: 'Warten',
  download: 'Datei herunterladen',
  upload: 'Datei hochladen',
  mergeAtv: 'ATV-Dateien zusammenführen',
  runPipelines: 'Zwischenablauf ausführen',
  beginSubflow: 'Zwischenablauf starten',
  endSubflow: 'Hauptablauf fortsetzen',
  discoverDevices: 'Geräte entdecken',
}
