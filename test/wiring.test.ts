import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const MIN = 60_000
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type World = { tokens: number | undefined; compacts: string[]; statuses: string[]; agents: AgentInfo[] }

// Stands in for the engine beneath the plugin.
function engine(on: On, w: World) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('command.run', () => ({ text: 'unanswered' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('fs.read', (_, e) => ({ value: e.path === '/home/tester/.claude/cache-keeper.json' ? '{"taskEndEnabled": true}' : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'cacheboard' } }))
  on('ui.status', (_, e) => {
    if (e.text !== undefined) w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('agent.list', () => ({ value: w.agents }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: w.tokens, window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.compact', (_, e) => {
    w.compacts.push(e.trigger ?? 'plugin') // the kit leaves a plugin's trigger unset
    const before = w.tokens
    w.tokens = undefined // the live figure is absent until the next response
    return { messages: SUMMARY, tokensBefore: before, tokensAfter: 30_000 }
  })
}

async function endTurn($: any, clock: { advance: (ms: number) => Promise<void> }, id: string, bg: unknown[] | undefined) {
  await $.turn.start({ text: 'go', turnId: id })
  await clock.advance(1000)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: bg })
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: id, reason: 'answer' })
}

test('idle compaction fires once after 55 minutes, and the status shows the new size', async ($, on) => {
  const w: World = { tokens: 120_000, compacts: [], statuses: [], agents: [] }
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  engine(on, w)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await endTurn($, clock, 't1', [])
  await clock.advance(2000)
  expect(w.compacts).toEqual([]) // 120k is under the 500k task-end bar
  expect(w.statuses.at(-1)).toBe('ctx 120k | cache warm 60m left')

  await clock.advance(50 * MIN)
  expect(w.compacts).toEqual([])
  await clock.advance(6 * MIN)
  expect(w.compacts).toEqual(['plugin'])
  expect(w.statuses.at(-1)).toMatch(/^ctx 30k \| /)

  // Once per idle stretch, even if the size were big again.
  w.tokens = 200_000
  await clock.advance(30 * MIN)
  expect(w.compacts).toEqual(['plugin'])

  const { text } = await $.command.run({ command: 'cacheboard' } as Parameters<typeof $.command.run>[0])
  expect(text).toMatch(/120k -> 30k/)
  expect(text).toMatch(/context\s+30k/)
})

test('task-end compaction: only when nothing runs in the background', async ($, on) => {
  const w: World = { tokens: 600_000, compacts: [], statuses: [], agents: [] }
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  engine(on, w)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await endTurn($, clock, 't1', [{ id: 'b1', type: 'shell', status: 'running', description: 'build' }])
  await clock.advance(2000)
  expect(w.compacts).toEqual([])

  w.agents = [{ id: 'a1', description: 'research', type: 'general-purpose', status: 'running' }]
  await endTurn($, clock, 't2', [])
  await clock.advance(2000)
  expect(w.compacts).toEqual([])

  w.agents = []
  await endTurn($, clock, 't3', undefined) // can't tell: fail safe
  await clock.advance(2000)
  expect(w.compacts).toEqual([])

  await endTurn($, clock, 't4', [])
  await clock.advance(2000)
  expect(w.compacts).toEqual(['plugin'])
})

test('a manual /compact is recorded on the board', async ($, on) => {
  const w: World = { tokens: 150_000, compacts: [], statuses: [], agents: [] }
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  engine(on, w)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await endTurn($, clock, 't1', [])
  await clock.advance(2000)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  const { text } = await $.command.run({ command: 'cacheboard' } as Parameters<typeof $.command.run>[0])
  expect(text).toMatch(/manual\) 150k -> 30k/)
})
