import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheSnap, Limits } from '../types'

const cache = atom({ plugin: 'cache-keeper', key: 'cache' } as const, null, { shape: 'cache-1' })
const tick = atom({ plugin: 'cache-keeper', key: 'tick' } as const, 0)
const limits = atom({ plugin: 'cache-keeper', key: 'limits' } as const, { five: null, week: null })
const name = atom({ plugin: 'cache-keeper', key: 'name' } as const, 'session')

const HOUR = 3_600_000
const WARN_MS = 5 * 60_000
// Relative weights of token kinds against the plan limit. Absolute scale is
// learned from observed 5-hour movement (see calibrate), so only ratios matter.
const W_INPUT = 1
const W_READ = 0.1
const W_WRITE_5M = 1.25
const W_WRITE_1H = 2
const W_OUTPUT = 5

type Calib = { pctSum: number; unitSum: number }

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`
}
const fmtTok = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const fmtPct = (p: number) => (p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`)

type Eng = EngineInterface
const local = { warnedFor: -1 }

async function readCalib($: Eng): Promise<Calib> {
  return   ((await $.store.get('calib')) as Calib | undefined) ?? { pctSum: 0, unitSum: 0 }
}

/** % of the 5-hour limit one weighted token costs; null until learned. */
async function pctPerUnit($: Eng): Promise<number | null> {
  const c = await readCalib($)
  return c.pctSum >= 3 && c.unitSum > 0 ? c.pctSum / c.unitSum : null
}

async function rewritePct($: Eng, snap: CacheSnap): Promise<number | null> {
  const k = await pctPerUnit($)
  return k === null ? null : snap.tokens * W_WRITE_1H * k
}

async function refreshLimits($: Eng) {
  const u = await $.session.usage()
  const five = u.rateLimits.find((r: any) => r.kind === 'five_hour')?.percentUsed ?? null
  const week = u.rateLimits.find((r: any) => r.kind === 'seven_day')?.percentUsed ?? null
  await update($, limits, (): Limits => ({ five, week }))
}

async function check($: Eng) {
  const now = await $.clock.now()
  await update($, tick, n => n + 1)
  await refreshLimits($)
  const snap = await read($, cache)
  if (!snap) return
  const left = snap.at + snap.ttlMs - now
  if (left > 0 && left <= WARN_MS && local.warnedFor !== snap.at) {
    local.warnedFor = snap.at
    const pct = await rewritePct($, snap)
    const cost = pct === null ? 'cost still calibrating' : `rewrite ≈ ${fmtPct(pct)} of your 5h limit`
    $.ui.toast(
      `Cache going cold in ${fmtTime(left)} — ${await read($, name)}: ${fmtTok(snap.tokens)} tokens cached, ${cost}. /board keeps it warm.`,
      { timeoutMs: 15000 },
    )
  }
}


export const register: Register = on => {
  // calibration anchors, per session instance
  let anchorPct: number | null = null
  let anchorResets: string | undefined
  let anchorUnits = 0

  on('session.start', async ($, e, next) => {
    const base = e.cwd.split('/').filter(Boolean).pop() ?? 'session'
    const id = (await $.session.id()).slice(0, 6)
    await update($, name, () => `${base} (${id})`)
    await $.command.register({
      name: 'board',
      description: 'Send a minimal keep-warm ping to refresh this session’s prompt cache',
    })
    $.clock.every(20_000, () => void check($))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const r = yield* next(e)
    const u = r.usage
    if (!u) return r
    const w1h = u.ephemeral_1h_input_tokens ?? 0
    const w5m = u.ephemeral_5m_input_tokens ?? 0
    const other = Math.max(0, u.cache_creation_input_tokens - w1h - w5m)
    const units =
      u.input_tokens * W_INPUT +
      u.cache_read_input_tokens * W_READ +
      w1h * W_WRITE_1H +
      (w5m + other) * W_WRITE_5M +
      u.output_tokens * W_OUTPUT
    const total = ((await $.store.get('units')) as number | undefined) ?? 0
    await $.store.set('units', total + units)

    if (!e.agentId && u.cache_read_input_tokens + u.cache_creation_input_tokens > 0) {
      const prev = await read($, cache)
      const ttlMs = w1h > 0 ? HOUR : w5m > 0 ? 300_000 : (prev?.ttlMs ?? HOUR)
      await update($, cache, (): CacheSnap => ({
        at: sentAt,
        ttlMs,
        tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      }))
    }
    return r
  })

  // Learn % of the 5h limit per weighted token from how the window actually moves.
  on('session.measure', async ($, e, next) => {
    const five = e.rateLimits.find(r => r.kind === 'five_hour')
    if (five) {
      const units = ((await $.store.get('units')) as number | undefined) ?? 0
      if (anchorPct !== null && anchorResets === five.resetsAt && five.percentUsed > anchorPct) {
        const dUnits = units - anchorUnits
        if (dUnits > 0) {
          const c = await readCalib($)
          await $.store.set('calib', {
            pctSum: c.pctSum + (five.percentUsed - anchorPct),
            unitSum: c.unitSum + dUnits,
          })
        }
      }
      anchorPct = five.percentUsed
      anchorResets = five.resetsAt
      anchorUnits = units
    }
    await refreshLimits($)
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    const snap = await read($, cache)
    const now = await $.clock.now()
    const wasCold = !snap || snap.at + snap.ttlMs <= now
    const r = await $.model.fork({
      prompt: 'Keep-warm ping. Reply with just "ok" immediately: no tools, no thinking.',
    })
    if (!r.isAnswered) {
      return { text: `Ping did not complete (${r.reason}).` }
    }
    const u = r.usage
    await update($, cache, (prev): CacheSnap => ({
      at: now,
      ttlMs: prev?.ttlMs ?? HOUR,
      tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
    }))
    local.warnedFor = -1
    const pct =
      (u.cache_creation_input_tokens * W_WRITE_1H + u.cache_read_input_tokens * W_READ + u.input_tokens + u.output_tokens * W_OUTPUT) *
      ((await pctPerUnit($)) ?? 0)
    const cost = (await pctPerUnit($)) === null ? '' : ` Cost ≈ ${fmtPct(pct)} of your 5h limit.`
    return {
      text:
        (wasCold
          ? 'Cache had gone cold, so this ping rewrote it. '
          : 'Cache refreshed. ') +
        `${fmtTok(u.cache_read_input_tokens)} read, ${fmtTok(u.cache_creation_input_tokens)} written.${cost}`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, tick) // redraw on every tick
    const snap = await read($, cache)
    const lim = await read($, limits)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const usage = [
      lim.five !== null ? `5h ${Math.round(lim.five)}%` : null,
      lim.week !== null ? `week ${Math.round(lim.week)}%` : null,
    ]
      .filter(Boolean)
      .join(' · ')

    if (!snap) {
      return (
        <Box>
          <Text dimColor>Cache: no data yet{usage ? ` · ${usage}` : ''}</Text>
        </Box>
      )
    }
    const left = snap.at + snap.ttlMs - now
    const ctx = (await $.session.usage()).context
    const pct = await rewritePct($, snap)
    const warm = left > 0
    const soon = warm && left <= WARN_MS
    const status = warm ? `Cache warm ${fmtTime(left)} left` : 'Cache COLD'
    const rewrite = pct === null ? 'rewrite cost calibrating…' : `rewrite ≈ ${fmtPct(pct)} of 5h`
    return (
      <Box>
        <Text color={!warm ? 'red' : soon ? 'yellow' : 'green'}>{status}</Text>
        <Text dimColor>
          {' · '}ctx {fmtTok(snap.tokens)}
          {ctx.percent !== undefined ? ` (${ctx.percent}%)` : ''}
          {' · '}
          {rewrite}
          {usage ? ` · ${usage}` : ''}
        </Text>
      </Box>
    )
  })
}
