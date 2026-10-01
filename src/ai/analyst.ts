import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { fmtPrice, type Metrics } from "../analysis/signals";
import type { SymbolAlert } from "../alerts/evaluate";
import type { NewsItem } from "../lib/alpaca";

const DRIVERS = ["company_news", "earnings", "sector", "market", "technical", "unknown"] as const;
export type Driver = (typeof DRIVERS)[number];

const AssessmentSchema = z.object({
  assessments: z.array(
    z.object({
      symbol: z.string(),
      why: z.string(),
      driver: z.enum(DRIVERS),
      importance: z.number().int(),
      watch: z.string(),
    }),
  ),
  market_note: z.string(),
});

export type Assessment = {
  symbol: string;
  /** สาเหตุที่หุ้นขยับ (ภาษาไทย 1-2 ประโยค) */
  why: string;
  driver: Driver;
  /** 1 = noise, 5 = สำคัญมาก */
  importance: number;
  /** สิ่งที่ควรจับตาต่อ */
  watch: string;
};

export type AiResult = {
  model: string;
  assessments: Record<string, Assessment>;
  marketNote: string;
};

const SYSTEM_PROMPT = `คุณคือผู้ช่วยวิเคราะห์หุ้น US ให้นักลงทุนรายย่อยชาวไทย ระบบคำนวณสัญญาณเชิงสถิติมาแล้ว (การขยับเทียบความผันผวนปกติ σ, วอลุ่ม, จุดสูง/ต่ำ 52 สัปดาห์, SMA200, เป้าราคาที่ผู้ใช้ตั้ง) งานของคุณคืออธิบายว่าทำไมแต่ละตัวขยับ และประเมินว่ามีนัยยะแค่ไหน

หลักการ:
- ใช้เฉพาะข้อมูลที่ให้มา (ตัวเลข, พาดหัวข่าว, การขยับของหุ้นตัวอื่นใน watchlist) ห้ามแต่งข่าวหรือตัวเลขขึ้นเอง
- ถ้าข่าวที่ให้มาอธิบายการขยับไม่ได้ ให้บอกตรงๆ ว่า "ไม่พบข่าวที่อธิบายได้ชัดเจน" และใช้ driver = "unknown" หรือ "technical"
- ถ้าหุ้นกลุ่มเดียวกันใน watchlist ขยับไปทางเดียวกัน (เช่น quantum computing: IONQ, QUBT, RGTI) ให้ระบุว่าเป็นการขยับตามกลุ่ม (driver = "sector") ถ้าทั้งตลาดขยับ ใช้ "market"
- importance: 1 = noise/ขยับตามกลุ่มทั่วไป, 2 = น่าสังเกต, 3 = มีนัยยะ, 4 = สำคัญ (ข่าวพื้นฐานเปลี่ยน), 5 = สำคัญมาก (เปลี่ยนภาพบริษัท เช่น งบช็อก, ดีลใหญ่, ปัญหาทางกฎหมาย/การเงิน)
- why: ภาษาไทย 1-2 ประโยค กระชับ อ้างอิงข่าวที่เกี่ยวข้อง
- watch: ภาษาไทย 1 ประโยค สิ่งที่ควรจับตาต่อ (เช่น ยืนเหนือแนวได้ไหม, วันประกาศงบ, ข่าวต่อเนื่อง)
- ไม่ให้คำแนะนำซื้อ/ขาย
- market_note: ภาษาไทย 1 ประโยค ภาพรวมของ watchlist วันนี้ (ถ้าไม่มีอะไรเด่นให้ใส่สตริงว่าง)
- ต้องมี assessment ครบทุกหุ้นที่ถูกแจ้งเตือน`;

const pct = (x: number | null, d = 1) => (x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`);

function describeAlert(a: SymbolAlert, news: NewsItem[]): string {
  const m = a.metrics;
  const lines = [
    `## ${a.symbol}`,
    `ราคา $${fmtPrice(m.price)} (${pct(m.changePct)} วันนี้, ${m.z.toFixed(1)}σ; ปกติแกว่ง ±${m.sigmaPct.toFixed(1)}%/วัน), 5 วัน ${pct(m.change5Pct)}`,
    `RSI14 ${m.rsi14?.toFixed(0) ?? "n/a"}, วอลุ่ม ${m.rvol?.toFixed(1) ?? "n/a"}x ค่าเฉลี่ย, เทียบ SMA200 ${m.sma200 ? pct((m.price / m.sma200 - 1) * 100, 0) : "n/a"}`,
    `สัญญาณ: ${a.signals.map((s) => s.text).join(" / ")}`,
  ];
  if (news.length) {
    lines.push("ข่าวล่าสุด:");
    for (const n of news) {
      lines.push(`- [${n.createdAt.slice(0, 16)}Z ${n.source}] ${n.headline}${n.summary ? ` — ${n.summary.slice(0, 300)}` : ""}`);
    }
  } else {
    lines.push("ข่าวล่าสุด: ไม่มี");
  }
  return lines.join("\n");
}

export function buildPrompt(
  alerts: SymbolAlert[],
  news: Record<string, NewsItem[]>,
  watchlist: Record<string, Metrics | null>,
  date: string,
): string {
  const table = Object.entries(watchlist)
    .filter((e): e is [string, Metrics] => e[1] != null)
    .map(([s, m]) => `${s} ${pct(m.changePct)} (${m.z.toFixed(1)}σ)`)
    .join(", ");

  return [
    `วันที่ ${date}`,
    `การขยับของทุกตัวใน watchlist วันนี้ (ไว้ดูว่าขยับตามกลุ่ม/ตลาดหรือไม่): ${table}`,
    "",
    "หุ้นที่ถูกแจ้งเตือน:",
    ...alerts.map((a) => describeAlert(a, news[a.symbol] ?? [])),
  ].join("\n\n");
}

/**
 * ให้ Claude อธิบายสาเหตุ + ให้คะแนนความสำคัญของหุ้นที่ถูกแจ้งเตือน (เรียก 1 ครั้งต่อรอบ)
 * คืน null ถ้าเรียกไม่สำเร็จ — การแจ้งเตือนต้องไม่พังเพราะ AI
 */
export async function assessAlerts(
  apiKey: string,
  model: string,
  alerts: SymbolAlert[],
  news: Record<string, NewsItem[]>,
  watchlist: Record<string, Metrics | null>,
  date: string,
): Promise<AiResult | null> {
  if (!alerts.length) return null;
  const client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });

  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(AssessmentSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(alerts, news, watchlist, date) }],
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      console.warn("[ai] no usable output", response.stop_reason, response.stop_details);
      return null;
    }

    const wanted = new Set(alerts.map((a) => a.symbol));
    const assessments: Record<string, Assessment> = {};
    for (const a of response.parsed_output.assessments) {
      const symbol = a.symbol.trim().toUpperCase();
      if (!wanted.has(symbol)) continue;
      assessments[symbol] = { ...a, symbol, importance: Math.min(5, Math.max(1, Math.round(a.importance))) };
    }
    console.log("[ai] usage", JSON.stringify(response.usage));
    return { model: response.model, assessments, marketNote: response.parsed_output.market_note.trim() };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("[ai] invalid ANTHROPIC_API_KEY");
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error("[ai] rate limited");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[ai] API error ${err.status}:`, err.message);
    } else {
      console.error("[ai] failed", err);
    }
    return null;
  }
}
