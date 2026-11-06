import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, cacheMinutesLeft, compactReason, parseConfig } from '../hooks/decide'
import type { DecisionState } from '../hooks/decide'

const MIN = 60_000
const NOW = 1_800_000_000_000

/** An idle main session, 56 minutes after its last turn, with a 120k context. */
function idle(over: Partial<DecisionState> = {}): DecisionState {
  return {
    event: 'tick',
    now: NOW,
    isTurnRunning: false,
    isCompacting: false,
    lastTurnEndAt: NOW - 56 * MIN,
    contextTokens: 120_000,
    attemptedThisIdle: false,
    backgroundWork: 'unknown',
    ...over,
  }
}

/** Right after a main turn ended, with a 600k context and nothing running. */
function turnEnd(over: Partial<DecisionState> = {}): DecisionState {
  return idle({ event: 'turn-end', lastTurnEndAt: NOW, contextTokens: 600_000, backgroundWork: 'none', ...over })
}

describe('compactReason: idle compaction', () => {
  test('busy turn: never compacts mid-turn', () => {
    expect(compactReason(idle({ isTurnRunning: true }), DEFAULT_CONFIG)).toBe(null)
    expect(compactReason(turnEnd({ isTurnRunning: true }), DEFAULT_CONFIG)).toBe(null)
  })

  test('short idle: 54 minutes is not enough', () => {
    expect(compactReason(idle({ lastTurnEndAt: NOW - 54 * MIN }), DEFAULT_CONFIG)).toBe(null)
  })

  test('small context: under 80k is left alone', () => {
    expect(compactReason(idle({ contextTokens: 79_999 }), DEFAULT_CONFIG)).toBe(null)
  })

  test('idle over 55 minutes with a big context compacts', () => {
    expect(compactReason(idle(), DEFAULT_CONFIG)).toBe('idle')
    // exactly at the thresholds counts
    expect(compactReason(idle({ lastTurnEndAt: NOW - 55 * MIN, contextTokens: 80_000 }), DEFAULT_CONFIG)).toBe('idle')
  })

  test('already compacted (or attempted) this idle stretch: no second try', () => {
    expect(compactReason(idle({ attemptedThisIdle: true }), DEFAULT_CONFIG)).toBe(null)
    expect(compactReason(turnEnd({ attemptedThisIdle: true }), DEFAULT_CONFIG)).toBe(null)
  })

  test('unknown size or no finished turn yet: does nothing', () => {
    expect(compactReason(idle({ contextTokens: null }), DEFAULT_CONFIG)).toBe(null)
    expect(compactReason(idle({ lastTurnEndAt: null }), DEFAULT_CONFIG)).toBe(null)
  })

  test('a compaction already in flight blocks another', () => {
    expect(compactReason(idle({ isCompacting: true }), DEFAULT_CONFIG)).toBe(null)
  })

  test('thresholds come from the config', () => {
    const cfg = { ...DEFAULT_CONFIG, idleMinutes: 30, minTokens: 200_000 }
    expect(compactReason(idle({ lastTurnEndAt: NOW - 31 * MIN }), cfg)).toBe(null) // 120k < 200k
    expect(compactReason(idle({ lastTurnEndAt: NOW - 31 * MIN, contextTokens: 250_000 }), cfg)).toBe('idle')
  })
})

describe('compactReason: task-end compaction', () => {
  test('background work running: does not compact', () => {
    expect(compactReason(turnEnd({ backgroundWork: 'running' }), DEFAULT_CONFIG)).toBe(null)
  })

  test('unknown background work: fails safe, does not compact', () => {
    expect(compactReason(turnEnd({ backgroundWork: 'unknown' }), DEFAULT_CONFIG)).toBe(null)
  })

  test('nothing running and context at least 500k: compacts straight away', () => {
    expect(compactReason(turnEnd(), DEFAULT_CONFIG)).toBe('task-end')
    expect(compactReason(turnEnd({ contextTokens: 500_000 }), DEFAULT_CONFIG)).toBe('task-end')
  })

  test('nothing running but context under 500k: waits for the idle rule', () => {
    expect(compactReason(turnEnd({ contextTokens: 499_999 }), DEFAULT_CONFIG)).toBe(null)
  })

  test('switched off in config: does not compact', () => {
    expect(compactReason(turnEnd(), { ...DEFAULT_CONFIG, taskEndEnabled: false })).toBe(null)
  })
})

describe('helpers', () => {
  test('cache minutes left counts down from the last turn end', () => {
    expect(cacheMinutesLeft(NOW, NOW - 18 * MIN, DEFAULT_CONFIG)).toBe(42)
    expect(cacheMinutesLeft(NOW, NOW - 61 * MIN, DEFAULT_CONFIG)).toBe(0)
    expect(cacheMinutesLeft(NOW, null, DEFAULT_CONFIG)).toBe(null)
  })

  test('config: partial file keeps defaults, bad fields are reported', () => {
    const { config, problems } = parseConfig({ idleMinutes: 50, taskEndEnabled: 'yes' })
    expect(config.idleMinutes).toBe(50)
    expect(config.minTokens).toBe(80000)
    expect(config.taskEndEnabled).toBe(true)
    expect(problems.length).toBe(1)
  })
})
