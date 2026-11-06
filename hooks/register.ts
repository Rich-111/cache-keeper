// Claude Code wiring for cache-keeper. The decision itself lives in ./decide.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Background, Compaction, KeeperState } from '../types'
import {
  DEFAULT_CONFIG,
  cacheMinutesLeft,
  compactReason,
  formatTokens,
  parseConfig,
} from './decide'
import type { CompactReason, Config, DecisionState } from './decide'

const MINUTE = 60_000
const CONFIG_FILE = 'cache-keeper.json'

const INITIAL: KeeperState = {
  isTurnRunning: false,
  turnStartedAt: null,
  lastTurnEndAt: null,
  contextTokens: null,
  attemptedThisIdle: false,
  isCompacting: false,
  stopBackground: 'unknown',
  stopAt: null,
  lastCompaction: null,
  lastAttempt: null,
}

// Session state survives hot reloads; bump the shape tag when KeeperState changes.
const info = atom({ plugin: 'cache-keeper', key: 'info' } as const, INITIAL, {
  shape: 'info-1',
})

// Module variables reset on reload; they only hold derivable things.
let config: Config = { ...DEFAULT_CONFIG }
let configPath: string | null = null
let configProblem: string | null = null
let taskEndTimer: { cancel: () => void } | null = null

async function resolveConfigPath($: EngineInterface): Promise<string | null> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return `${dir.replace(/\/+$/, '')}/${CONFIG_FILE}`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (!home) return null
  return `${home.replace(/[\\/]+$/, '')}/.claude/${CONFIG_FILE}`
}

async function loadConfig($: EngineInterface, createIfMissing = false): Promise<Config> {
  configPath ??= await resolveConfigPath($)
  if (configPath === null) {
    configProblem = 'no HOME; using defaults'
    return (config = { ...DEFAULT_CONFIG })
  }
  let text: string
  try {
    text = await $.fs.read(configPath)
  } catch {
    configProblem = null
    if (createIfMissing) {
      try {
        await $.fs.write(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
      } catch {
        // Not fatal: defaults still apply.
      }
    }
    return (config = { ...DEFAULT_CONFIG })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    if (configProblem !== 'invalid JSON') $.ui.log(`cache-keeper: ${configPath} is not valid JSON; using defaults`)
    configProblem = 'invalid JSON'
    return (config = { ...DEFAULT_CONFIG })
  }
  const parsed = parseConfig(raw)
  const problem = parsed.problems.join('; ') || null
  if (problem && problem !== configProblem) $.ui.log(`cache-keeper: ${configPath}: ${problem}`)
  configProblem = problem
  return (config = parsed.config)
}

async function setState($: EngineInterface, fn: (s: KeeperState) => KeeperState) {
  await update($, info, s => fn(s ?? INITIAL))
}

async function refreshStatus($: EngineInterface) {
  const s = await read($, info)
  const now = await $.clock.now()
  const ctx = `ctx ${formatTokens(s.contextTokens)}`
  let cache: string
  if (s.isCompacting) cache = 'compacting...'
  else if (s.isTurnRunning) cache = 'turn running'
  else {
    const left = cacheMinutesLeft(now, s.lastTurnEndAt, config)
    cache = left === null ? 'cache ?' : left > 0 ? `cache warm ${left}m left` : 'cache cold'
  }
  $.ui.status(`${ctx} | ${cache}`)
}

/** Is any subagent or background task still running? Unknown when we can't tell. */
async function backgroundWork($: EngineInterface, s: KeeperState): Promise<Background> {
  // The Stop hook's `background_tasks` for THIS turn (reported after it started).
  const fromStop: Background =
    s.stopAt !== null && s.turnStartedAt !== null && s.stopAt >= s.turnStartedAt
      ? s.stopBackground
      : 'unknown'
  let fromAgents: Background
  try {
    const agents = await $.agent.list()
    fromAgents = agents.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
      ? 'running'
      : 'none'
  } catch {
    fromAgents = 'unknown'
  }
  if (fromStop === 'running' || fromAgents === 'running') return 'running'
  if (fromStop === 'none' && fromAgents === 'none') return 'none'
  return 'unknown'
}

async function decide($: EngineInterface, event: DecisionState['event']): Promise<CompactReason | null> {
  const s = await read($, info)
  const now = await $.clock.now()
  const backgroundWorkNow = event === 'turn-end' ? await backgroundWork($, s) : 'unknown'
  return compactReason(
    {
      event,
      now,
      isTurnRunning: s.isTurnRunning,
      isCompacting: s.isCompacting,
      lastTurnEndAt: s.lastTurnEndAt,
      contextTokens: s.contextTokens,
      attemptedThisIdle: s.attemptedThisIdle,
      backgroundWork: backgroundWorkNow,
    },
    config,
  )
}

async function estimateTokens($: EngineInterface): Promise<number | undefined> {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    return u.context.breakdown?.totalTokens
  } catch {
    return undefined
  }
}

async function recordCompaction($: EngineInterface, c: Compaction) {
  await setState($, s => ({
    ...s,
    lastCompaction: c,
    // Show the new size, never the stale pre-compact one.
    contextTokens: c.after ?? null,
    // A compaction while idle counts for this idle stretch.
    attemptedThisIdle: s.isTurnRunning ? s.attemptedThisIdle : true,
  }))
}

async function runCompact($: EngineInterface, reason: CompactReason) {
  const callAt = await $.clock.now()
  const before = (await read($, info)).contextTokens
  // Count the attempt first: whatever happens, no retry until the next idle stretch.
  await setState($, s => ({
    ...s,
    attemptedThisIdle: true,
    isCompacting: true,
    lastAttempt: { at: callAt, reason, outcome: 'running' },
  }))
  await refreshStatus($)
  let outcome: string
  try {
    const res = await $.session.compact()
    if (res.skip !== undefined) {
      outcome = `refused: ${res.skip}`
      $.ui.log(`cache-keeper: ${reason} compaction refused (${res.skip}); will retry next idle stretch`)
    } else {
      outcome = 'done'
      // Our own session.compact hook usually records it; if it didn't see this one, record here.
      const s = await read($, info)
      if (!s.lastCompaction || s.lastCompaction.at < callAt) {
        const after = res.tokensAfter ?? (await estimateTokens($))
        await recordCompaction($, {
          at: await $.clock.now(),
          trigger: 'plugin',
          reason,
          before: res.tokensBefore ?? before ?? undefined,
          after,
        })
      }
      const last = (await read($, info)).lastCompaction
      $.ui.log(`cache-keeper: ${reason} compaction ${formatTokens(last?.before)} -> ${formatTokens(last?.after)}`)
    }
  } catch (err) {
    outcome = `failed: ${err instanceof Error ? err.message : String(err)}`
    $.ui.log(`cache-keeper: ${reason} compaction failed (${outcome}); will retry next idle stretch`)
  }
  await setState($, s => ({
    ...s,
    isCompacting: false,
    lastAttempt: { at: callAt, reason, outcome },
  }))
  await refreshStatus($)
}

async function tick($: EngineInterface) {
  await loadConfig($)
  const s = await read($, info)
  if (s.contextTokens === null && !s.isTurnRunning && !s.isCompacting && s.lastCompaction === null) {
    // Fresh load (e.g. a resumed session): seed the size from the live window.
    const tokens = (await $.session.usage()).context.tokens
    if (tokens !== undefined) await setState($, x => ({ ...x, contextTokens: tokens }))
  }
  await refreshStatus($)
  const reason = await decide($, 'tick')
  if (reason) await runCompact($, reason)
}

function scheduleTaskEnd($: EngineInterface) {
  // Stop and turn.complete arrive in either order: wait briefly so both are in.
  taskEndTimer?.cancel()
  taskEndTimer = $.clock.after(1500, () => {
    taskEndTimer = null
    void (async () => {
      const reason = await decide($, 'turn-end')
      if (reason) await runCompact($, reason)
    })()
  })
}

function fmtDuration(ms: number): string {
  const m = Math.floor(ms / MINUTE)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function fmtTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function board($: EngineInterface): Promise<string> {
  await loadConfig($)
  const s = await read($, info)
  const now = await $.clock.now()
  const idle = s.isTurnRunning
    ? 'turn running'
    : s.lastTurnEndAt === null
      ? 'unknown (no turn ended yet)'
      : fmtDuration(now - s.lastTurnEndAt)
  const left = cacheMinutesLeft(now, s.lastTurnEndAt, config)
  const cache = s.isTurnRunning
    ? 'warm (turn running)'
    : left === null
      ? 'unknown'
      : left > 0
        ? `${left}m left`
        : 'expired'
  const c = s.lastCompaction
  const last = c
    ? `${fmtTime(c.at)} (${fmtDuration(now - c.at)} ago, ${c.trigger}${c.reason ? `: ${c.reason}` : ''}) ` +
      `${formatTokens(c.before)} -> ${formatTokens(c.after)}`
    : 'none this session'
  const a = s.lastAttempt
  const lines = [
    'cache-keeper',
    `  context          ${formatTokens(s.contextTokens)} tokens${s.contextTokens !== null ? ` (${s.contextTokens})` : ''}`,
    `  idle             ${idle}`,
    `  cache            ${cache}`,
    `  last compaction  ${last}`,
  ]
  if (a) lines.push(`  last auto try    ${fmtTime(a.at)} ${a.reason}: ${a.outcome}`)
  lines.push(
    `  this idle        ${s.attemptedThisIdle ? 'already compacted/attempted' : 'not yet compacted'}`,
    `  config           ${configPath ?? '(no path)'}${configProblem ? ` [${configProblem}]` : ''}`,
    `                   idle ${config.idleMinutes}m, min ${formatTokens(config.minTokens)}, ` +
      `task-end ${formatTokens(config.taskEndTokens)} (${config.taskEndEnabled ? 'on' : 'off'}), cache ${config.cacheMinutes}m`,
  )
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await loadConfig($, true)
    await $.command.register({
      name: 'cacheboard',
      description: 'cache-keeper: context size, idle time, cache minutes left, last compaction',
    })
    $.clock.every(MINUTE, () => void tick($))
    void tick($)
    return ran
  })

  on('command.run', { command: 'cacheboard' }, async $ => ({ text: await board($) }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    taskEndTimer?.cancel()
    taskEndTimer = null
    // A new turn ends the idle stretch: the next one starts fresh.
    await setState($, s => ({ ...s, isTurnRunning: true, turnStartedAt: now, attemptedThisIdle: false }))
    await refreshStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    const now = await $.clock.now()
    let tokens: number | undefined
    try {
      tokens = (await $.session.usage()).context.tokens
    } catch {
      tokens = undefined
    }
    await setState($, s => ({
      ...s,
      isTurnRunning: false,
      lastTurnEndAt: now,
      contextTokens: tokens ?? s.contextTokens,
      attemptedThisIdle: false,
    }))
    await refreshStatus($)
    scheduleTaskEnd($)
    return ran
  })

  // The Stop hook carries the authoritative list of in-flight background work.
  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) {
      const now = await $.clock.now()
      const bg: Background =
        e.background_tasks === undefined ? 'unknown' : e.background_tasks.length > 0 ? 'running' : 'none'
      await setState($, s => ({ ...s, stopBackground: bg, stopAt: now }))
    }
    return next(e)
  })

  // Record every compaction of the main conversation: ours, auto, /compact, other mods.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const trigger: string = e.trigger ?? 'plugin'
    const s0 = await read($, info)
    const before = s0.contextTokens
    const ownReason =
      trigger === 'plugin' && s0.lastAttempt?.outcome === 'running' ? s0.lastAttempt.reason : undefined
    await setState($, s => ({ ...s, isCompacting: true }))
    try {
      const res = await next(e)
      if (res.skip === undefined) {
        const after = res.tokensAfter ?? (await estimateTokens($))
        await recordCompaction($, {
          at: await $.clock.now(),
          trigger,
          reason: ownReason,
          before: res.tokensBefore ?? before ?? undefined,
          after,
        })
      }
      return res
    } finally {
      await setState($, s => ({ ...s, isCompacting: ownReason ? s.isCompacting : false }))
      await refreshStatus($)
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // /clear: a new, empty conversation. Keep only the compaction history.
      await setState($, s => ({ ...INITIAL, lastCompaction: s.lastCompaction }))
      await refreshStatus($)
    }
    return next(e)
  })
}
