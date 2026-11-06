// Pure decision logic for cache-keeper. No `$`, no I/O: easy to test.

export type Config = {
  /** Compact when idle at least this long (minutes). */
  idleMinutes: number
  /** ...and the context is at least this many tokens. */
  minTokens: number
  /** Compact straight after a turn when the context is at least this big. */
  taskEndTokens: number
  /** On/off switch for task-end compaction. */
  taskEndEnabled: boolean
  /** Prompt cache lifetime used for the "minutes left" display (minutes). */
  cacheMinutes: number
}

export const DEFAULT_CONFIG: Config = {
  idleMinutes: 55,
  minTokens: 80000,
  taskEndTokens: 500000,
  taskEndEnabled: true,
  cacheMinutes: 60,
}

export type BackgroundWork = 'none' | 'running' | 'unknown'

export type DecisionState = {
  /** 'tick' = the once-a-minute idle check; 'turn-end' = right after a main turn ended. */
  event: 'tick' | 'turn-end'
  now: number
  isTurnRunning: boolean
  isCompacting: boolean
  lastTurnEndAt: number | null
  contextTokens: number | null
  /** An automatic compaction was already attempted in this idle stretch. */
  attemptedThisIdle: boolean
  /** Subagents / background tasks still running. 'unknown' fails safe (no task-end compact). */
  backgroundWork: BackgroundWork
}

export type CompactReason = 'idle' | 'task-end'

const MINUTE = 60_000

export function compactReason(
  state: DecisionState,
  config: Config,
): CompactReason | null {
  if (state.isTurnRunning || state.isCompacting) return null
  if (state.attemptedThisIdle) return null
  if (state.contextTokens === null) return null

  if (state.event === 'turn-end') {
    if (!config.taskEndEnabled) return null
    if (state.contextTokens < config.taskEndTokens) return null
    if (state.backgroundWork !== 'none') return null
    return 'task-end'
  }

  if (state.lastTurnEndAt === null) return null
  const idleMs = state.now - state.lastTurnEndAt
  if (idleMs < config.idleMinutes * MINUTE) return null
  if (state.contextTokens < config.minTokens) return null
  return 'idle'
}

/** Minutes until the prompt cache expires, counted from the end of the last turn; 0 when expired. */
export function cacheMinutesLeft(
  now: number,
  lastTurnEndAt: number | null,
  config: Config,
): number | null {
  if (lastTurnEndAt === null) return null
  const left = config.cacheMinutes - (now - lastTurnEndAt) / MINUTE
  return Math.max(0, Math.floor(left))
}

/** Merge a parsed JSON object over the defaults, keeping only well-typed fields. */
export function parseConfig(raw: unknown): { config: Config; problems: string[] } {
  const config: Config = { ...DEFAULT_CONFIG }
  const problems: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, problems: ['config is not a JSON object; using defaults'] }
  }
  const obj = raw as Record<string, unknown>
  for (const key of ['idleMinutes', 'minTokens', 'taskEndTokens', 'cacheMinutes'] as const) {
    if (!(key in obj)) continue
    const v = obj[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) config[key] = v
    else problems.push(`${key} must be a non-negative number`)
  }
  if ('taskEndEnabled' in obj) {
    if (typeof obj.taskEndEnabled === 'boolean') config.taskEndEnabled = obj.taskEndEnabled
    else problems.push('taskEndEnabled must be true or false')
  }
  return { config, problems }
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${Math.round(n / 1000)}k`
}
