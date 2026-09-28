import type { Slot } from "../lib/time";
import { logReturns, rsi, sma, stdev } from "./indicators";

export type Bar = {
  date: string; // YYYY-MM-DD (ET)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type Thresholds = {
  /** การขยับรายวันต้องเกินกี่ σ ของความผันผวนปกติของหุ้นตัวนั้น */
  moveZ: number;
  /** และต้องขยับอย่างน้อยกี่ % (กันหุ้นนิ่งๆ ที่ขยับนิดเดียวแต่ z สูง) */
  minMovePct: number;
  /** การขยับสะสม 5 วัน (หน่วย σ·√5) */
  trendZ: number;
  minTrendPct: number;
  /** วอลุ่มผิดปกติ: กี่เท่าของค่าเฉลี่ย 20 วัน */
  volumeRatio: number;
  /** วอลุ่มผิดปกติต้องมาพร้อมราคาขยับอย่างน้อยกี่ σ */
  volumeMinZ: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  moveZ: 2.5,
  minMovePct: 3,
  trendZ: 2.5,
  minTrendPct: 10,
  volumeRatio: 3,
  volumeMinZ: 1.5,
};

export type SignalKind = "move" | "trend" | "volume" | "breakout" | "sma200" | "level";

export type Signal = {
  /** ใช้กันเตือนซ้ำ (ต่อหุ้น) */
  id: string;
  kind: SignalKind;
  dir: 1 | -1;
  score: number;
  magnitude: number;
  /** 0 = เตือนได้วันละครั้ง, N = เว้นอย่างน้อย N วัน */
  cooldownDays: number;
  /** ถ้าเคยเตือนแล้ว จะเตือนซ้ำได้ก็ต่อเมื่อ magnitude โตขึ้นอย่างน้อยเท่านี้ */
  escalateBy?: number;
  text: string;
};

export type Metrics = {
  date: string;
  price: number;
  prevClose: number;
  changePct: number;
  /** การแกว่งปกติต่อวัน (1σ) หน่วย % */
  sigmaPct: number;
  z: number;
  change5Pct: number | null;
  z5: number | null;
  rvol: number | null;
  rsi14: number | null;
  sma50: number | null;
  sma200: number | null;
  high52: number | null;
  low52: number | null;
};

export type Analysis = { metrics: Metrics; signals: Signal[] };

const MIN_HISTORY = 6; // หุ้นเข้าตลาดใหม่ก็ยังวิเคราะห์ได้ (σ จะหยาบหน่อย)
const MIN_SIGMA = 0.005; // 0.5%/วัน กัน σ เล็กผิดปกติ

const pct = (x: number, digits = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;

/**
 * วิเคราะห์แท่งสุดท้ายของ bars (อาจเป็นแท่งของวันนี้ที่ยังไม่ปิด)
 * เทียบกับประวัติก่อนหน้า
 */
export function analyze(
  bars: Bar[],
  slot: Slot,
  volumeFraction: number,
  t: Thresholds,
): Analysis | null {
  if (bars.length < MIN_HISTORY) return null;

  const today = bars[bars.length - 1];
  const hist = bars.slice(0, -1);
  const histCloses = hist.map((b) => b.c);
  const price = today.c;
  const prevClose = histCloses[histCloses.length - 1];
  if (!(price > 0) || !(prevClose > 0)) return null;

  // ความผันผวนปกติ: ผสม 20 วัน (ภาวะล่าสุด) กับ 60 วัน (ภาพกว้าง)
  const rets = logReturns(histCloses);
  const s20 = stdev(rets.slice(-20)) ?? 0;
  const s60 = stdev(rets.slice(-60)) ?? s20;
  // ประวัติสั้น (หุ้นใหม่) ประเมิน σ ต่ำเกินจริงได้ง่าย → ตั้งพื้นไว้ 3%/วัน
  const sigmaFloor = rets.length < 20 ? 0.03 : MIN_SIGMA;
  const sigma = Math.max(Math.sqrt((s20 ** 2 + s60 ** 2) / 2), sigmaFloor);

  const r = Math.log(price / prevClose);
  const z = r / sigma;
  const changePct = (price / prevClose - 1) * 100;

  let change5Pct: number | null = null;
  let z5: number | null = null;
  let priorShare = 0; // สัดส่วนของการขยับ 5 วันที่เกิดก่อนวันนี้
  if (histCloses.length >= 5) {
    const base = histCloses[histCloses.length - 5];
    const r5 = Math.log(price / base);
    priorShare = r5 !== 0 ? Math.log(prevClose / base) / r5 : 0;
    change5Pct = (price / base - 1) * 100;
    z5 = r5 / (sigma * Math.sqrt(5));
  }

  // วอลุ่มเทียบค่าเฉลี่ย 20 วัน (ช่วงกลางวันจะคาดการณ์ทั้งวันจากเส้นวอลุ่มปกติ)
  let rvol: number | null = null;
  const avgVol = hist.slice(-20).reduce((a, b) => a + b.v, 0) / Math.min(20, hist.length);
  if (avgVol > 0 && volumeFraction >= 0.15 && hist.length >= 10) {
    rvol = today.v / (avgVol * volumeFraction);
  }

  const closes = [...histCloses, price];
  const year = hist.slice(-252);
  const hasYear = hist.length >= 200;
  const high52 = hasYear ? Math.max(...year.map((b) => b.h)) : null;
  const low52 = hasYear ? Math.min(...year.map((b) => b.l)) : null;

  const metrics: Metrics = {
    date: today.date,
    price,
    prevClose,
    changePct,
    sigmaPct: sigma * 100,
    z,
    change5Pct,
    z5,
    rvol,
    rsi14: rsi(closes.slice(-120), 14),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    high52,
    low52,
  };

  const signals: Signal[] = [];
  const dirOf = (x: number): 1 | -1 => (x >= 0 ? 1 : -1);

  // 1) ขยับแรงผิดปกติในวันเดียว
  if (Math.abs(z) >= t.moveZ && Math.abs(changePct) >= t.minMovePct) {
    const up = z > 0;
    signals.push({
      id: `move:${up ? "up" : "down"}`,
      kind: "move",
      dir: dirOf(z),
      score: Math.abs(z),
      magnitude: Math.abs(z),
      cooldownDays: 0,
      escalateBy: 1.5,
      text: `${up ? "📈 ขึ้นแรง" : "📉 ลงแรง"} ${pct(changePct)} วันนี้ — ${Math.abs(z).toFixed(1)}σ (ปกติแกว่ง ±${metrics.sigmaPct.toFixed(1)}%/วัน)`,
    });
  }

  // 2) แนวโน้มแรงสะสม 5 วัน (ค่อยๆ ไหลลง/ขึ้นต่อเนื่อง ที่รายวันอาจไม่ถึงเกณฑ์)
  //    ถ้าส่วนใหญ่มาจากวันนี้วันเดียว สัญญาณ move บอกไปแล้ว ไม่ต้องซ้ำ
  if (
    z5 != null &&
    priorShare >= 0.5 &&
    change5Pct != null &&
    Math.abs(z5) >= t.trendZ &&
    Math.abs(change5Pct) >= t.minTrendPct
  ) {
    const up = z5 > 0;
    signals.push({
      id: `trend5:${up ? "up" : "down"}`,
      kind: "trend",
      dir: dirOf(z5),
      score: Math.abs(z5) * 0.8,
      magnitude: Math.abs(z5),
      cooldownDays: 5,
      text: `${up ? "🚀" : "🧊"} 5 วันทำการ ${pct(change5Pct)} (${Math.abs(z5).toFixed(1)}σ)`,
    });
  }

  // 3) วอลุ่มผิดปกติ + ราคาขยับจริง (มีเงินใหญ่เข้า/ออก)
  if (rvol != null && rvol >= t.volumeRatio && Math.abs(z) >= t.volumeMinZ) {
    signals.push({
      id: "volume",
      kind: "volume",
      dir: dirOf(z),
      score: Math.min(rvol / 2, 4),
      magnitude: rvol,
      cooldownDays: 0,
      escalateBy: 2,
      text: `🔊 วอลุ่ม ${rvol.toFixed(1)}x ของค่าเฉลี่ย 20 วัน${slot === "midday" ? " (คาดการณ์ทั้งวัน)" : ""}`,
    });
  }

  // สัญญาณเชิงเทคนิคดูเฉพาะราคาปิด (กันหลอกระหว่างวัน)
  if (slot === "close") {
    // 4) ทำจุดสูงสุด/ต่ำสุดใหม่รอบ 52 สัปดาห์
    if (high52 != null && price > high52) {
      signals.push({
        id: "high52",
        kind: "breakout",
        dir: 1,
        score: 2.5,
        magnitude: price / high52,
        cooldownDays: 20,
        text: `🏔️ ปิดทำ New High รอบ 52 สัปดาห์ (เดิม $${fmtPrice(high52)})`,
      });
    }
    if (low52 != null && price < low52) {
      signals.push({
        id: "low52",
        kind: "breakout",
        dir: -1,
        score: 2.5,
        magnitude: low52 / price,
        cooldownDays: 20,
        text: `🕳️ ปิดทำ New Low รอบ 52 สัปดาห์ (เดิม $${fmtPrice(low52)})`,
      });
    }

    // 5) ตัดเส้น SMA200 (แนวโน้มใหญ่เปลี่ยน) — ต้องอยู่อีกฝั่งมาต่อเนื่อง 10 วัน และทะลุชัดเจน
    //    (กันราคาเลียเส้นแล้วตัดขึ้น-ลงสลับกันทุกวัน)
    const prevSma200 = sma(histCloses, 200);
    if (metrics.sma200 != null && prevSma200 != null) {
      const margin = Math.max(0.01, sigma * 0.5);
      const last10 = histCloses.slice(-10);
      const crossedUp =
        last10.every((c) => c < prevSma200) && price >= metrics.sma200 * (1 + margin);
      const crossedDown =
        last10.every((c) => c > prevSma200) && price <= metrics.sma200 * (1 - margin);
      if (crossedUp || crossedDown) {
        signals.push({
          id: `sma200:${crossedUp ? "up" : "down"}`,
          kind: "sma200",
          dir: crossedUp ? 1 : -1,
          score: 1.5,
          magnitude: 1,
          cooldownDays: 20,
          text: `${crossedUp ? "✅ ปิดเหนือ" : "⚠️ ปิดหลุด"} เส้น SMA200 ($${fmtPrice(metrics.sma200)}) — แนวโน้มระยะยาวเปลี่ยน`,
        });
      }
    }
  }

  return { metrics, signals };
}

export type LevelRules = { below?: number; above?: number };
export type LevelState = {
  below?: boolean;
  above?: boolean;
  /** เป้าที่ใช้คำนวณสถานะ — ถ้าผู้ใช้เปลี่ยนเป้า จะเริ่มนับใหม่ */
  belowLvl?: number;
  aboveLvl?: number;
};

/**
 * เป้าราคาที่ผู้ใช้ตั้ง แบบมี hysteresis:
 * เตือนตอน "เข้า" โซนครั้งแรก และจะเตือนอีกได้ก็ต่อเมื่อราคาออกจากโซนไปไกลกว่า hysteresisPct ก่อน
 * (กันราคาแกว่งรอบเป้าแล้วเตือนรัวๆ — ควรส่ง hysteresisPct ตามความผันผวนของหุ้น)
 *
 * เป้าที่เพิ่งตั้ง/เพิ่งเปลี่ยน: บันทึกสถานะเงียบๆ ก่อน (ไม่เตือนสิ่งที่เป็นอยู่แล้ว)
 */
export function evalLevels(
  price: number,
  rules: LevelRules,
  prev: LevelState,
  hysteresisPct = 3,
): { signals: Signal[]; next: LevelState } {
  const signals: Signal[] = [];
  const next: LevelState = {};
  const h = hysteresisPct / 100;

  if (rules.below != null) {
    const known = prev.belowLvl === rules.below;
    const inZone = known && prev.below ? price <= rules.below * (1 + h) : price <= rules.below;
    if (known && inZone && !prev.below) {
      signals.push({
        id: "level:below",
        kind: "level",
        dir: -1,
        score: 3,
        magnitude: 1,
        cooldownDays: 3,
        text: `🎯 ลงมาถึงเป้าซื้อ/จุดเฝ้าระวังที่ตั้งไว้ ≤ $${fmtPrice(rules.below)}`,
      });
    }
    next.below = inZone;
    next.belowLvl = rules.below;
  }

  if (rules.above != null) {
    const known = prev.aboveLvl === rules.above;
    const inZone = known && prev.above ? price >= rules.above * (1 - h) : price >= rules.above;
    if (known && inZone && !prev.above) {
      signals.push({
        id: "level:above",
        kind: "level",
        dir: 1,
        score: 3,
        magnitude: 1,
        cooldownDays: 3,
        text: `🎯 ขึ้นมาถึงเป้าที่ตั้งไว้ ≥ $${fmtPrice(rules.above)}`,
      });
    }
    next.above = inZone;
    next.aboveLvl = rules.above;
  }

  return { signals, next };
}

/** คะแนนรวมของหุ้น: สัญญาณแรงสุด + โบนัสเล็กน้อยจากสัญญาณอื่นที่มาพร้อมกัน */
export function symbolScore(signals: Signal[]): number {
  if (!signals.length) return 0;
  const scores = signals.map((s) => s.score).sort((a, b) => b - a);
  return scores[0] + 0.3 * scores.slice(1).reduce((a, b) => a + b, 0);
}

export function fmtPrice(p: number): string {
  return p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(4);
}
