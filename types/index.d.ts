export type Compaction = {
  /** ms since epoch */
  at: number
  /** manual | auto | plugin (plugin = this mod, or another mod) */
  trigger: string
  /** why cache-keeper compacted, when it was cache-keeper */
  reason?: string
  before?: number
  after?: number
}

export type Background = 'none' | 'running' | 'unknown'

export type KeeperState = {
  isTurnRunning: boolean
  turnStartedAt: number | null
  lastTurnEndAt: number | null
  /** best known context size; set from usage at turn end, and from the compaction result */
  contextTokens: number | null
  /** an automatic compaction was attempted since the last turn ended */
  attemptedThisIdle: boolean
  isCompacting: boolean
  /** what the Stop hook reported for background work, and when */
  stopBackground: Background
  stopAt: number | null
  lastCompaction: Compaction | null
  lastAttempt: { at: number; reason: string; outcome: string } | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { info: Shaped<KeeperState> }
  }
}
