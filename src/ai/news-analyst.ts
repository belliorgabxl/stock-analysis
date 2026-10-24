import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import type { Snapshot } from "../lib/alpaca";
import type { RawItem } from "../news/sources";

const DIRECTIONS = ["bullish", "bearish", "mixed", "neutral"] as const;
const CONFIDENCE = ["low", "medium", "high"] as const;
const HORIZONS = ["intraday", "days", "weeks", "months"] as const;
const CATEGORIES = [
  "earnings",
  "guidance",
  "dilution",
  "mna",
  "contract",
  "product",
  "regulatory",
  "legal",
  "management",
  "insider",
  "analyst",
  "macro",
  "sector",
  "other",
] as const;

const NewsSchema = z.object({
  items: z.array(
    z.object({
      ref: z.number().int(),
      relevant: z.boolean(),
      symbols: z.array(z.string()),
      direction: z.enum(DIRECTIONS),
      impact: z.number().int(),
      confidence: z.enum(CONFIDENCE),
      horizon: z.enum(HORIZONS),
      category: z.enum(CATEGORIES),
      hype: z.boolean(),
      duplicate: z.boolean(),
      why: z.string(),
    }),
  ),
  summary: z.string(),
});

export type NewsAssessment = {
  item: RawItem;
  relevant: boolean;
  symbols: string[];
  direction: (typeof DIRECTIONS)[number];
  /** 1 = แทบไม่มีผล ... 5 = เปลี่ยนภาพบริษัท/ตลาด */
  impact: number;
  confidence: (typeof CONFIDENCE)[number];
  horizon: (typeof HORIZONS)[number];
  category: (typeof CATEGORIES)[number];
  /** ภาษาข่าวเชิงเก็งกำไร/ตื่นเต้นเกินจริง — ใช้นับใน Heat Index */
  hype: boolean;
  /** เป็นเรื่องเดียวกับที่เตือนไปแล้วใน 24 ชม. */
  duplicate: boolean;
  why: string;
};

export type NewsAiResult = { model: string; assessments: NewsAssessment[]; summary: string };

const SYSTEM_PROMPT = `คุณคือผู้ช่วยคัดกรองข่าวหุ้น US (เน้นกลุ่ม Nasdaq) ให้นักลงทุนรายย่อยชาวไทย ระบบส่งข่าวใหม่ทุก ~30 นาที จาก 3 แหล่ง:
- NEWS: ข่าวบริษัทจาก Alpaca/Benzinga (แท็ก ticker มาแล้ว)
- FILING: เอกสารที่บริษัทยื่น SEC (เห็นแค่ประเภทแบบฟอร์มและรายการ Item ไม่เห็นเนื้อหาเต็ม)
- MACRO: พาดหัวข่าวเศรษฐกิจ/ตลาดจาก CNBC, MarketWatch

งานของคุณ: ประเมินทุกข่าวว่ามีโอกาสทำให้หุ้นใน watchlist (หรือ Nasdaq โดยรวม) ขึ้นหรือลงแรงแค่ไหน

หลักการ:
- ใช้เฉพาะข้อมูลที่ให้มา ห้ามแต่งตัวเลขหรือรายละเอียดที่ข่าวไม่ได้บอก
- relevant = true เฉพาะข่าวที่น่าจะกระทบราคาหุ้นใน watchlist หรือ Nasdaq/หุ้นเทคโดยรวม; ข่าวไลฟ์สไตล์ การเงินส่วนบุคคล การเมืองทั่วไป = false
- symbols: ticker ที่ได้รับผล (ใช้ ticker ใน watchlist ก่อน; ข่าวกระทบทั้งตลาดใช้ "QQQ"; ไม่เกี่ยวใส่ [])
- direction: bullish / bearish / mixed / neutral ต่อราคาหุ้นที่ระบุ
- impact (1-5): 1 = แทบไม่มีผล, 2 = เล็กน้อย, 3 = น่าจับตา, 4 = มีโอกาสขยับแรง (งบ/คำแนะนำผิดคาด, ดีลใหญ่, ออกหุ้นเพิ่ม, ปัญหากฎหมาย, ข้อมูลเศรษฐกิจช็อก), 5 = เปลี่ยนภาพบริษัท/ตลาด (ถูกซื้อกิจการ, ล้มละลาย, ถูกถอดจากตลาด, Fed เซอร์ไพรส์)
- ระวังการให้ impact สูงเกินจริง: บทความความเห็น, "5 หุ้นที่ควรจับตา", เป้าราคานักวิเคราะห์ทั่วไป, ข่าวเก่าที่เล่าซ้ำ = impact ต่ำ
- หุ้นเล็ก (BBAI, QUBT, RGTI, EOSE, BURU, LAES, RR ฯลฯ) ที่ยื่น S-1/S-3/424B มักหมายถึงการออกหุ้นเพิ่ม → bearish ระยะสั้น (category = dilution) ส่วน 8-K ให้ดูจาก Item: 2.02 = งบ, 1.01 = สัญญาสำคัญ, 3.01 = ถูกเตือนเรื่อง delisting, 5.02 = ผู้บริหารเปลี่ยน, 2.05/2.06 = ปรับโครงสร้าง/ด้อยค่า
- confidence: ความมั่นใจของคุณว่าทิศทางถูก (FILING ที่เห็นแค่ประเภทเอกสาร ส่วนใหญ่ไม่เกิน medium)
- hype: true ถ้าข่าวใช้ภาษาเก็งกำไร/ตื่นเต้นเกินจริง (เช่น "skyrocket", "next Nvidia", "record euphoria") หรือเป็นสัญญาณตลาดร้อนแรง (IPO แห่, margin debt สูงสุด)
- duplicate: true ถ้าเป็นเรื่องเดียวกับรายการ "เตือนไปแล้ว" หรือซ้ำกับข่าวอื่นในรอบนี้ที่ ref น้อยกว่า
- why: ภาษาไทย 1 ประโยค อธิบายว่าทำไมขึ้น/ลง และราคาวันนี้สะท้อนข่าวไปแล้วหรือยัง; ถ้า relevant = false หรือ impact ≤ 2 ให้ใส่สตริงว่าง
- ไม่ให้คำแนะนำซื้อ/ขาย
- summary: ภาษาไทย 1 ประโยค ภาพรวมข่าวรอบนี้ (ถ้าไม่มีอะไรเด่นใส่สตริงว่าง)
- ต้องตอบครบทุก ref`;

const pct = (x: number | null) => (x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function buildNewsPrompt(
  items: RawItem[],
  watchlist: string[],
  snapshots: Record<string, Snapshot>,
  recentAlerts: string[],
): string {
  const prices = watchlist
    .map((s) => (snapshots[s] ? `${s} $${snapshots[s].price} (${pct(snapshots[s].changePct)})` : s))
    .join(", ");
  const lines = [
    `watchlist + ราคาล่าสุด (IEX): ${prices}`,
    "",
    `เตือนไปแล้วใน 24 ชม.: ${recentAlerts.length ? "\n" + recentAlerts.map((h) => `- ${h}`).join("\n") : "ไม่มี"}`,
    "",
    "ข่าวใหม่:",
  ];
  items.forEach((it, i) => {
    const kind = it.kind === "company" ? "NEWS" : it.kind === "filing" ? "FILING" : "MACRO";
    const syms = it.symbols.length ? ` ${it.symbols.join(",")}` : "";
    const when = `${ET_TIME.format(new Date(it.publishedAt))} ET`;
    lines.push(`[${i}] ${kind}${syms} | ${it.source} | ${when} | ${it.headline}${it.summary ? ` — ${it.summary}` : ""}`);
  });
  return lines.join("\n");
}

/** โมเดลที่รองรับ server-side refusal fallback (`fallbacks: "default"`) */
export function fallbackOptions(model: string) {
  return /^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
}

/** คัดกรอง + ให้คะแนนข่าวทั้งรอบด้วยการเรียก Claude ครั้งเดียว — คืน null ถ้าไม่สำเร็จ */
export async function assessNews(
  apiKey: string,
  model: string,
  items: RawItem[],
  watchlist: string[],
  snapshots: Record<string, Snapshot>,
  recentAlerts: string[],
): Promise<NewsAiResult | null> {
  if (!items.length) return null;
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 });

  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      ...fallbackOptions(model),
      output_config: { effort: "low", format: betaZodOutputFormat(NewsSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildNewsPrompt(items, watchlist, snapshots, recentAlerts) }],
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      console.warn("[news-ai] no usable output", response.stop_reason, response.stop_details);
      return null;
    }

    const assessments: NewsAssessment[] = [];
    for (const a of response.parsed_output.items) {
      const item = items[a.ref];
      if (!item) continue;
      assessments.push({
        item,
        relevant: a.relevant,
        symbols: [...new Set(a.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))],
        direction: a.direction,
        impact: Math.min(5, Math.max(1, Math.round(a.impact))),
        confidence: a.confidence,
        horizon: a.horizon,
        category: a.category,
        hype: a.hype,
        duplicate: a.duplicate,
        why: a.why.trim(),
      });
    }
    console.log("[news-ai] usage", JSON.stringify(response.usage));
    return { model: response.model, assessments, summary: response.parsed_output.summary.trim() };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("[news-ai] invalid ANTHROPIC_API_KEY");
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error("[news-ai] rate limited");
    } else if (err instanceof Anthropic.APIError) {
      console.error(`[news-ai] API error ${err.status}:`, err.message);
    } else {
      console.error("[news-ai] failed", err);
    }
    return null;
  }
}
