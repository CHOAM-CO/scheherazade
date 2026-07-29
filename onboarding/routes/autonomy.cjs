// onboarding/routes/autonomy.cjs -- autonomous-cycle consent/window/cap routes (group 6)
// (issue #9 PR-2 route grouping).
//
// Route BODIES ONLY, moved verbatim (comments included) from
// onboarding/http-server.cjs's old handleApi if-chain. Helper functions,
// constants, and mutable singletons STAY in http-server.cjs with exactly one
// owner; this file binds what its bodies need ONCE from staticCtx (one
// destructuring statement, below). Per-call values -- agentControls,
// onOnboardingComplete, the live askpassToken getter -- arrive via callCtx
// on every request (see http-server.cjs handleApi). The returned array's
// order IS the dispatch order and preserves the old chain's intra-group
// order exactly.
'use strict'

function createRoutes(staticCtx) {
  const {
    sendJson, readJsonBody, readAgentConfig, writeAgentConfig, autonomyBudget, autonomyCycle,
    readAutonomyState, DATA_HOME,
  } = staticCtx
  return [
    // ── autonomous cycle (v0.0.6) ─────────────────────────────────────────────
    // GET returns consent + window + cap + TODAY'S REAL TOKEN COUNT, read from
    // the same meter the watcher enforces against. The user is shown the exact
    // number the cap is enforced on -- not a friendlier one. Two numbers under
    // one name is how a meter starts lying.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/autonomy',
      handler: async (req, res, callCtx) => {
        const cfg = readAgentConfig()
        const cap = Number(cfg.AUTONOMY_TOKEN_CAP || autonomyBudget.DEFAULT_DAILY_CAP)
        const state = readAutonomyState()

        // TWO different numbers, and they are never allowed to wear one name:
        //
        //   today  -- everything spent today, including the user's own conversations.
        //             This is what the owner actually wants to know ("what did today
        //             cost me"), and it is NOT what the cap is enforced against.
        //   cap    -- a PER-NIGHT ceiling, enforced over [cycleStart, now]. It has to
        //             be per-night: a 23:00-05:00 window measured per calendar day
        //             got a fresh budget at midnight and could spend the cap twice.
        //
        // ok === false means the meter cannot see the transcripts. That is reported
        // as blindness, never as zero: "nothing was spent" and "I cannot tell you
        // what was spent" are different sentences, and only one of them is a relief.
        const today = autonomyBudget.usageForDay(DATA_HOME)
        const lastCycleUsage = state && state.cycleStartedAt && Number.isFinite(Date.parse(state.cycleStartedAt))
          ? autonomyBudget.usageSince(DATA_HOME, Date.parse(state.cycleStartedAt))
          : null

        sendJson(res, 200, {
          enabled: String(cfg.AUTONOMY || '').toLowerCase() === 'yes',
          windowStart: cfg.AUTONOMY_WINDOW_START || autonomyCycle.DEFAULTS.windowStart,
          windowEnd: cfg.AUTONOMY_WINDOW_END || autonomyCycle.DEFAULTS.windowEnd,
          cap,
          defaultCap: autonomyBudget.DEFAULT_DAILY_CAP,
          today,
          lastCycle: state && state.cycleDay
            ? {
              day: state.cycleDay,
              startedAt: state.cycleStartedAt,
              stopped: state.stoppedDay === state.cycleDay,
              briefed: state.briefDay === state.cycleDay,
              used: lastCycleUsage && lastCycleUsage.ok ? lastCycleUsage.total : null,
            }
            : null,
          lastSkip: state ? state.lastSkip || null : null,
        })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/autonomy',
      handler: async (req, res, callCtx) => {
        const body = await readJsonBody(req)
        const fields = {}

        if (body.enabled !== undefined) {
          // Consent is a boolean the user typed, not a value we infer. There is no
          // path here that turns autonomy on as a side effect of something else.
          fields.AUTONOMY = body.enabled === true ? 'yes' : 'no'
        }
        for (const [key, field] of [['windowStart', 'AUTONOMY_WINDOW_START'], ['windowEnd', 'AUTONOMY_WINDOW_END']]) {
          if (body[key] === undefined) continue
          const v = typeof body[key] === 'string' ? body[key].trim() : ''
          if (autonomyCycle.parseHM(v) === null) {
            sendJson(res, 400, { error: `invalid ${key} (expected HH:MM)` })
            return
          }
          fields[field] = v
        }
        if (body.cap !== undefined) {
          const cap = Number(body.cap)
          // No unlimited. A cap of 0 disables the cycle rather than freeing it --
          // the absence of a number means no, never yes, for a feature that spends
          // someone else's money while they sleep.
          if (!Number.isFinite(cap) || cap < 0 || cap > 1e12) {
            sendJson(res, 400, { error: 'invalid token cap' })
            return
          }
          fields.AUTONOMY_TOKEN_CAP = String(Math.floor(cap))
        }
        if (Object.keys(fields).length === 0) {
          sendJson(res, 400, { error: 'nothing to change' })
          return
        }
        // A zero-length window would be rejected by the watcher every poll and the
        // user would never learn why. Reject it at the surface where they can see it.
        const merged = { ...readAgentConfig(), ...fields }
        const w = autonomyCycle.windowState(
          new Date(),
          merged.AUTONOMY_WINDOW_START || autonomyCycle.DEFAULTS.windowStart,
          merged.AUTONOMY_WINDOW_END || autonomyCycle.DEFAULTS.windowEnd,
        )
        if (!w.ok) {
          sendJson(res, 400, { error: w.reason })
          return
        }

        writeAgentConfig(fields)
        // No restart. The watcher re-reads .agent-config on every poll precisely so
        // that turning this OFF takes effect within the minute instead of at the
        // next restart -- withdrawal of consent must be faster than granting it.
        sendJson(res, 200, { ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
