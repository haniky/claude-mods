# cache-keeper

A Claude Code mod that keeps an eye on the prompt cache of every session.

- **Status band** above the prompt: cache warm/cold with time left (1-hour TTL), context size, the estimated cache-rewrite cost, and your 5-hour and weekly usage. Costs are shown as a % of your plan limit, never dollars.
- **Toast warning** 5 minutes before a session's cache goes cold: session name, cache size and rewrite cost as % of your 5-hour limit. It only warns; it never pings by itself.
- **`/board`** sends one minimal keep-warm ping when you choose to run it.

The rewrite-cost % is learned from how your 5-hour window actually moves, so it reads "calibrating…" at first. It is an estimate.

## Install

```
/plugin install cache-keeper --marketplace haniky/claude-mods
```

From a shell:

```
claude plugin install cache-keeper --marketplace haniky/claude-mods
```

Answer `y` to add the marketplace, then choose the user scope so it applies to all your sessions.
