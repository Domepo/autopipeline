export type PlaybackSpeed = 'slow' | 'normal' | 'fast'
export type RunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted'
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

export type ValueSource =
  | { type: 'literal'; value: string }
  | { type: 'deviceField'; key: string }
  | { type: 'credentialField'; field: 'username' | 'password'; credentialId?: string }
  | { type: 'runValue'; key: string }

export type FileSource =
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
  | (BaseStep & { type: 'download'; locator: LocatorSpec; artifactKey: string })
  | (BaseStep & { type: 'upload'; locator: LocatorSpec; file: FileSource })

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

export type DataFieldType = 'text' | 'number' | 'date' | 'url'

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
}
