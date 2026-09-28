import {
  analyze,
  evalLevels,
  symbolScore,
  type Bar,
  type LevelRules,
  type Metrics,
  type Signal,
  type Thresholds,
} from "../analysis/signals";
import type { Slot } from "../lib/time";
import { recordSent, shouldSend, type AlertState } from "./state";

export type SymbolAlert = {
  symbol: string;
  metrics: Metrics;
  signals: Signal[];
  score: number;
};

export type EvaluateInput = {
  symbols: string[];
  barsBySymbol: Record<string, Bar[]>;
  slot: Slot;
  volumeFraction: number;
  thresholds: Thresholds;
  priceLevels: Record<string, LevelRules>;
  /** จะถูกอัปเดต (levels + sent) */
  state: AlertState;
  today: string;
  now: number;
  ignoreCooldown?: boolean;
};

export type EvaluateResult = {
  alerts: SymbolAlert[];
  metrics: Record<string, Metrics | null>;
};

export function evaluateSymbols(input: EvaluateInput): EvaluateResult {
  const { state, today, now } = input;
  const alerts: SymbolAlert[] = [];
  const metrics: Record<string, Metrics | null> = {};

  for (const symbol of input.symbols) {
    const bars = input.barsBySymbol[symbol] ?? [];
    const analysis = analyze(bars, input.slot, input.volumeFraction, input.thresholds);
    metrics[symbol] = analysis?.metrics ?? null;
    if (!analysis) continue;

    const signals = [...analysis.signals];

    const rules = input.priceLevels[symbol];
    if (rules) {
      // แถบ hysteresis กว้างตามความผันผวน: ต้องออกจากโซน ≥ max(3%, 2σ) ก่อนถึงจะเตือนใหม่ได้
      const hysteresisPct = Math.max(3, analysis.metrics.sigmaPct * 2);
      const lv = evalLevels(analysis.metrics.price, rules, state.levels[symbol] ?? {}, hysteresisPct);
      state.levels[symbol] = lv.next;
      signals.push(...lv.signals);
    }

    const fresh = input.ignoreCooldown
      ? signals
      : signals.filter((s) => shouldSend(state, symbol, s, today, now));
    if (!fresh.length) continue;

    for (const s of fresh) recordSent(state, symbol, s, today, now);
    alerts.push({ symbol, metrics: analysis.metrics, signals: fresh, score: symbolScore(fresh) });
  }

  alerts.sort((a, b) => b.score - a.score);
  return { alerts, metrics };
}
