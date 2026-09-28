import type { Bar } from "../analysis/signals";
import { loadConfig, parseSymbols } from "../config";
import { fetchDailyBars, fetchNews, type NewsItem } from "../lib/alpaca";
import { buildMessage, sendDiscord } from "../lib/discord";
import { etParts, sessionVolumeFraction, slotForTime, type Slot } from "../lib/time";
import type { Env } from "../model/config-env";
import { evaluateSymbols } from "./evaluate";
import { loadState, pruneState, saveState } from "./state";

export type RunOptions = {
  /** ไม่ใส่ = เลือกจากเวลาปัจจุบัน (ใช้กับ cron) */
  slot?: Slot;
  /** ข้ามการกันซ้ำ/วันหยุด */
  force?: boolean;
  /** วิเคราะห์อย่างเดียว ไม่ส่ง Discord ไม่บันทึก state */
  dryRun?: boolean;
  symbols?: string[];
  now?: Date;
};

export async function runAlerts(env: Env, opts: RunOptions = {}) {
  const cfg = loadConfig(env);
  const now = opts.now ?? new Date();
  const et = etParts(now);

  const slot = opts.slot ?? slotForTime(et);
  if (!slot) return { status: "skipped", reason: `not an alert slot (ET ${et.hour}:${et.minute})` };
  if (!opts.force && !opts.dryRun && !cfg.slots.includes(slot)) {
    return { status: "skipped", reason: `slot "${slot}" disabled by ALERT_SLOTS` };
  }

  const symbols = opts.symbols?.length ? parseSymbols(opts.symbols.join(",")) : cfg.symbols;
  const state = await loadState(env.STOCK_STATE);
  const runId = `${et.date}:${slot}`;
  if (!opts.force && !opts.dryRun && state.runs[runId]) {
    return { status: "skipped", reason: `already ran ${runId}` };
  }

  const { bars, feed, asOf } = await fetchDailyBars(symbols, env, cfg.feed, now);

  // ตลาดเปิดวันนี้ไหม (วันหยุดตลาด US จะไม่มีแท่งของวันนี้)
  const tradingToday = Object.values(bars).some((b) => b.at(-1)?.date === et.date);
  if (!tradingToday && !opts.force && !opts.dryRun) {
    return { status: "skipped", reason: `market closed on ${et.date}` };
  }

  // หุ้นที่วันนี้ยังไม่มีการซื้อขาย (เช่นถูกพักการซื้อขาย) ห้ามเอาแท่งเมื่อวานมาคิดซ้ำ
  const barsBySymbol: Record<string, Bar[]> = {};
  for (const s of symbols) {
    const b = bars[s] ?? [];
    if (!tradingToday || b.at(-1)?.date === et.date) barsBySymbol[s] = b;
  }
  const evalDate = tradingToday
    ? et.date
    : (Object.values(bars).map((b) => b.at(-1)?.date ?? "").sort().at(-1) ?? et.date);

  const workState = opts.dryRun ? structuredClone(state) : state;
  const { alerts, metrics } = evaluateSymbols({
    symbols,
    barsBySymbol,
    slot,
    volumeFraction: slot === "close" || !tradingToday ? 1 : sessionVolumeFraction(asOf),
    thresholds: cfg.thresholds,
    priceLevels: cfg.priceLevels,
    state: workState,
    today: evalDate,
    now: now.getTime(),
    ignoreCooldown: opts.force,
  });

  let news: Record<string, NewsItem[]> = {};
  if (alerts.length) {
    news = await fetchNews(
      alerts.map((a) => a.symbol),
      env,
      new Date(now.getTime() - 36 * 3_600_000),
    ).catch((err) => {
      console.warn("[news] failed", err);
      return {};
    });
  }

  const payload = alerts.length
    ? buildMessage(alerts, news, { slot, date: evalDate, feed, asOf })
    : null;

  if (!opts.dryRun) {
    if (payload) await sendDiscord(env.DISCORD_WEBHOOK_URL, payload);
    state.runs[runId] = now.getTime();
    pruneState(state, now.getTime());
    await saveState(env.STOCK_STATE, state);
  }

  return {
    status: "ok",
    slot,
    date: evalDate,
    feed,
    asOf: asOf.toISOString(),
    sent: Boolean(payload && !opts.dryRun),
    alerts: alerts.map((a) => ({
      symbol: a.symbol,
      score: Number(a.score.toFixed(2)),
      signals: a.signals.map((s) => s.text),
    })),
    watchlist: Object.fromEntries(
      Object.entries(metrics).map(([s, m]) => [
        s,
        m && {
          price: m.price,
          changePct: round(m.changePct),
          z: round(m.z),
          sigmaPct: round(m.sigmaPct),
          rvol: m.rvol == null ? null : round(m.rvol),
          rsi14: m.rsi14 == null ? null : round(m.rsi14, 0),
          levels: cfg.priceLevels[s],
        },
      ]),
    ),
    ...(opts.dryRun ? { payload } : {}),
  };
}

const round = (x: number, d = 2) => Number(x.toFixed(d));
