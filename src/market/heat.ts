import { logReturns, rsi, sma, stdev } from "../analysis/indicators";
import type { Bar } from "../analysis/signals";
import type { DailySentiment } from "../news/state";

/**
 * Market Heat Index 0-100: ตลาด "ร้อน" แค่ไหน จากข้อมูลที่วัดได้จริง
 * ไม่ใช่ความน่าจะเป็นที่ฟองสบู่จะแตก — ตลาดร้อนอยู่ได้นานหลายเดือน
 */
export type HeatComponents = {
  /** QQQ ยืดห่างจาก SMA200 แค่ไหน */
  trend: number;
  /** RSI14 ของ QQQ */
  momentum: number;
  /** % ของหุ้นใหญ่ในตะกร้าที่อยู่เหนือ SMA50 */
  breadth: number | null;
  /** ความผันผวน 20 วันต่ำเทียบกับทั้งปี = ตลาดชะล่าใจ */
  complacency: number;
  /** สัดส่วนข่าวบวก + ข่าวเชิง hype 7 วันล่าสุด */
  news: number | null;
};

export type HeatResult = {
  score: number;
  label: string;
  components: HeatComponents;
  facts: {
    qqqPrice: number;
    qqqVsSma200Pct: number | null;
    rsi14: number | null;
    fromHigh52Pct: number;
    breadthPct: number | null;
    breadthCount: number;
    vol20Pct: number | null;
    volPercentile: number | null;
    newsCount: number;
    bullShare: number | null;
    hypeShare: number | null;
  };
  warnings: string[];
};

const WEIGHTS: Record<keyof HeatComponents, number> = {
  trend: 0.25,
  momentum: 0.15,
  breadth: 0.2,
  complacency: 0.2,
  news: 0.2,
};

const clamp = (x: number) => Math.max(0, Math.min(100, x));
/** แปลงค่า x ในช่วง [lo, hi] เป็น 0-100 แบบเส้นตรง */
const scale = (x: number, lo: number, hi: number) => clamp(((x - lo) / (hi - lo)) * 100);

export function heatLabel(score: number): string {
  if (score >= 85) return "ร้อนจัด (เสี่ยงฟองสบู่)";
  if (score >= 70) return "ร้อน";
  if (score >= 50) return "อุ่น";
  if (score >= 30) return "ปกติ";
  return "เย็น (ตลาดกลัว)";
}

function realizedVol(closes: number[]): number | null {
  const s = stdev(logReturns(closes));
  return s == null ? null : s * Math.sqrt(252) * 100;
}

export function computeHeat(qqq: Bar[], basket: Record<string, Bar[]>, sentiment: DailySentiment[]): HeatResult | null {
  const closes = qqq.map((b) => b.c);
  if (closes.length < 60) return null;
  const price = closes.at(-1)!;

  const sma200 = sma(closes, 200);
  const vsSma200 = sma200 ? (price / sma200 - 1) * 100 : null;
  const rsi14 = rsi(closes.slice(-120), 14);
  const high52 = Math.max(...qqq.slice(-252).map((b) => b.h));
  const fromHigh52Pct = (price / high52 - 1) * 100;

  // breadth: หุ้นในตะกร้าที่ราคาปิดล่าสุดอยู่เหนือ SMA50
  let above = 0;
  let counted = 0;
  for (const bars of Object.values(basket)) {
    const c = bars.map((b) => b.c);
    const s50 = sma(c, 50);
    if (s50 == null) continue;
    counted++;
    if (c.at(-1)! > s50) above++;
  }
  const breadthPct = counted >= 10 ? (above / counted) * 100 : null;

  // ความผันผวน 20 วันปัจจุบัน เทียบกับทุกช่วง 20 วันในรอบปี
  const vol20 = realizedVol(closes.slice(-21));
  const history: number[] = [];
  for (let end = Math.max(21, closes.length - 252); end <= closes.length; end++) {
    const v = realizedVol(closes.slice(end - 21, end));
    if (v != null) history.push(v);
  }
  const volPercentile = vol20 != null && history.length > 20 ? (history.filter((v) => v < vol20).length / history.length) * 100 : null;

  // ข่าว 7 วันล่าสุด
  const sum = sentiment.reduce(
    (acc, d) => ({ bull: acc.bull + d.bull, bear: acc.bear + d.bear, hype: acc.hype + d.hype, total: acc.total + d.total }),
    { bull: 0, bear: 0, hype: 0, total: 0 },
  );
  const directional = sum.bull + sum.bear;
  const bullShare = directional >= 10 ? sum.bull / directional : null;
  const hypeShare = sum.total >= 10 ? sum.hype / sum.total : null;

  const components: HeatComponents = {
    trend: vsSma200 == null ? scale(fromHigh52Pct, -20, 0) : scale(vsSma200, -5, 20),
    momentum: rsi14 == null ? 50 : scale(rsi14, 30, 80),
    breadth: breadthPct,
    complacency: volPercentile == null ? 50 : 100 - volPercentile,
    // hype 1 ใน 3 ของข่าว = เต็ม
    news: bullShare == null ? null : clamp(0.7 * bullShare * 100 + 0.3 * Math.min(1, (hypeShare ?? 0) * 3) * 100),
  };

  let weighted = 0;
  let totalWeight = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as Array<[keyof HeatComponents, number]>) {
    const v = components[k];
    if (v == null) continue;
    weighted += v * w;
    totalWeight += w;
  }
  const score = Math.round(weighted / totalWeight);

  const warnings: string[] = [];
  if (fromHigh52Pct > -3 && breadthPct != null && breadthPct < 50) {
    warnings.push(`QQQ ใกล้จุดสูงสุด 52 สัปดาห์ แต่หุ้นใหญ่แค่ ${breadthPct.toFixed(0)}% ยืนเหนือ SMA50 — ตลาดพึ่งหุ้นไม่กี่ตัว (เปราะบาง)`);
  }
  if (vsSma200 != null && vsSma200 > 15) warnings.push(`QQQ ยืดห่าง SMA200 ถึง +${vsSma200.toFixed(0)}% — อดีตมักพักฐาน/ย่อตัวกลับ`);
  if (rsi14 != null && rsi14 >= 75) warnings.push(`RSI14 ของ QQQ = ${rsi14.toFixed(0)} (overbought)`);
  if (volPercentile != null && volPercentile < 15 && vsSma200 != null && vsSma200 > 8) {
    warnings.push("ความผันผวนต่ำผิดปกติขณะราคาสูง — สัญญาณตลาดชะล่าใจ");
  }
  if (hypeShare != null && hypeShare > 0.15) warnings.push(`ข่าวเชิง hype/เก็งกำไร ${(hypeShare * 100).toFixed(0)}% ของข่าวทั้งหมดสัปดาห์นี้`);
  if (vsSma200 != null && vsSma200 < 0 && fromHigh52Pct < -15) warnings.push("QQQ หลุด SMA200 และลงจากจุดสูงสุดเกิน 15% — ตลาดอยู่ในช่วงขาลง");

  return {
    score,
    label: heatLabel(score),
    components,
    facts: {
      qqqPrice: price,
      qqqVsSma200Pct: vsSma200,
      rsi14,
      fromHigh52Pct,
      breadthPct,
      breadthCount: counted,
      vol20Pct: vol20,
      volPercentile,
      newsCount: sum.total,
      bullShare,
      hypeShare,
    },
    warnings,
  };
}
