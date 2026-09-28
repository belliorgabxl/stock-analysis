/**
 * Backtest เกณฑ์แจ้งเตือนกับข้อมูลจริงย้อนหลัง (จำลองรอบ "close" ทุกวันทำการ)
 * ใช้ดูว่าจะได้รับแจ้งเตือนบ่อยแค่ไหน และเตือนเรื่องอะไรบ้าง ก่อนปรับค่าใน wrangler.jsonc
 *
 *   npm run backtest                 # ใช้ WATCHLIST/PRICE_LEVELS จาก wrangler.jsonc + .dev.vars
 *   npm run backtest -- --days 120   # ย้อนหลัง 120 วันทำการ
 *   npm run backtest -- --verbose    # แสดงทุกการแจ้งเตือน
 */
import fs from "node:fs";
import { evaluateSymbols } from "../src/alerts/evaluate";
import { emptyState } from "../src/alerts/state";
import { fetchDailyBars } from "../src/lib/alpaca";
import { loadConfig } from "../src/config";
import type { Env } from "../src/model/config-env";

function readVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  // vars จาก wrangler.jsonc (ตัด comment ออกแบบง่ายๆ)
  const jsonc = fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = jsonc.match(/"vars"\s*:\s*(\{[\s\S]*?\})/);
  if (m) Object.assign(vars, JSON.parse(m[1].replace(/,\s*\}/, "}")));
  // secrets จาก .dev.vars (override)
  if (fs.existsSync(".dev.vars")) {
    for (const line of fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) vars[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return vars;
}

const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const testDays = Number(argVal("--days") ?? 250);
const verbose = args.includes("--verbose");

const env = { ...readVars() } as unknown as Env;
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("BT_")) (env as any)[k.slice(3)] = v; // BT_MOVE_Z=3 npm run backtest
}
const cfg = loadConfig(env);

const { bars, feed } = await fetchDailyBars(cfg.symbols, env, cfg.feed, new Date(), 400 + testDays * 1.5);
console.log(`feed=${feed} symbols=${cfg.symbols.length} thresholds=${JSON.stringify(cfg.thresholds)}`);

const allDates = [...new Set(Object.values(bars).flatMap((b) => b.map((x) => x.date)))].sort();
const dates = allDates.slice(-testDays);
const state = emptyState();

let messages = 0;
let symbolAlerts = 0;
const byKind: Record<string, number> = {};
const bySymbol: Record<string, number> = {};
const perMessage: number[] = [];

for (const date of dates) {
  const barsUpTo: Record<string, typeof bars[string]> = {};
  for (const s of cfg.symbols) {
    const b = bars[s] ?? [];
    const idx = b.findIndex((x) => x.date === date);
    barsUpTo[s] = idx >= 0 ? b.slice(0, idx + 1) : [];
  }
  const now = Date.parse(`${date}T20:20:00Z`);
  const { alerts } = evaluateSymbols({
    symbols: cfg.symbols,
    barsBySymbol: barsUpTo,
    slot: "close",
    volumeFraction: 1,
    thresholds: cfg.thresholds,
    priceLevels: cfg.priceLevels,
    state,
    today: date,
    now,
  });
  if (!alerts.length) continue;

  messages++;
  symbolAlerts += alerts.length;
  perMessage.push(alerts.length);
  const line: string[] = [];
  for (const a of alerts) {
    bySymbol[a.symbol] = (bySymbol[a.symbol] ?? 0) + 1;
    for (const s of a.signals) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    line.push(
      `${a.symbol} ${a.metrics.changePct >= 0 ? "+" : ""}${a.metrics.changePct.toFixed(1)}% [${a.signals.map((s) => s.id).join(",")}]`,
    );
  }
  if (verbose) console.log(`${date}  ${line.join(" | ")}`);
}

const weeks = dates.length / 5;
console.log(`\n=== ${dates.length} วันทำการ (${dates[0]} → ${dates.at(-1)})`);
console.log(`วันที่มีข้อความแจ้งเตือน: ${messages}/${dates.length} (${((messages / dates.length) * 100).toFixed(0)}%) ≈ ${(messages / weeks).toFixed(1)} ข้อความ/สัปดาห์`);
console.log(`หุ้นต่อข้อความ: เฉลี่ย ${(symbolAlerts / Math.max(messages, 1)).toFixed(1)}, สูงสุด ${Math.max(0, ...perMessage)}`);
console.log(`ตามประเภท:`, byKind);
console.log(`ตามหุ้น:`, Object.fromEntries(Object.entries(bySymbol).sort((a, b) => b[1] - a[1])));
