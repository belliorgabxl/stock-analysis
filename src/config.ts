import { DEFAULT_THRESHOLDS, type LevelRules, type Thresholds } from "./analysis/signals";
import type { Feed } from "./lib/alpaca";
import type { Slot } from "./lib/time";
import type { Env } from "./model/config-env";

export const DEFAULT_AI_MODEL = "claude-opus-5-5";

export type Config = {
  symbols: string[];
  priceLevels: Record<string, LevelRules>;
  slots: Slot[];
  feed: Feed;
  thresholds: Thresholds;
  ai: { model: string; minImportance: number };
};

export function parseSymbols(input: string | undefined): string[] {
  return [
    ...new Set(
      (input ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export function parsePriceLevels(input: string): Record<string, LevelRules> {
  // format: AAPL:below=170,above=200;TSLA:below=180,above=260
  const out: Record<string, LevelRules> = {};
  for (const chunk of (input ?? "").split(";")) {
    const [symRaw, rulesRaw] = chunk.split(":");
    const symbol = (symRaw ?? "").trim().toUpperCase();
    if (!symbol || !rulesRaw) continue;

    const rules: LevelRules = {};
    for (const kv of rulesRaw.split(",")) {
      const [k, v] = kv.split("=").map((x) => x.trim());
      const num = Number(v);
      if (!v || !Number.isFinite(num)) continue;
      if (k === "below") rules.below = num;
      if (k === "above") rules.above = num;
    }
    out[symbol] = rules;
  }
  return out;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: Env): Config {
  const slots = parseSymbols(env.ALERT_SLOTS ?? "midday,close")
    .map((s) => s.toLowerCase())
    .filter((s): s is Slot => s === "midday" || s === "close");

  return {
    symbols: parseSymbols(env.WATCHLIST),
    priceLevels: parsePriceLevels(env.PRICE_LEVELS ?? ""),
    slots: slots.length ? slots : ["midday", "close"],
    feed: env.ALPACA_FEED?.toLowerCase() === "iex" ? "iex" : "sip",
    thresholds: {
      moveZ: num(env.MOVE_Z, DEFAULT_THRESHOLDS.moveZ),
      minMovePct: num(env.MIN_MOVE_PCT, DEFAULT_THRESHOLDS.minMovePct),
      trendZ: num(env.TREND_Z, DEFAULT_THRESHOLDS.trendZ),
      minTrendPct: num(env.MIN_TREND_PCT, DEFAULT_THRESHOLDS.minTrendPct),
      volumeRatio: num(env.VOLUME_RATIO, DEFAULT_THRESHOLDS.volumeRatio),
      volumeMinZ: DEFAULT_THRESHOLDS.volumeMinZ,
    },
    ai: {
      model: env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
      minImportance: num(env.AI_MIN_IMPORTANCE, 0),
    },
  };
}
