import type { NewsAssessment } from "../ai/news-analyst";
import type { Snapshot } from "../lib/alpaca";
import { thaiDate } from "../lib/discord";
import { etParts, hhmm } from "../lib/time";
import type { DailySentiment, NewsLogEntry } from "./state";

const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const YELLOW = 0xf1c40f;
const MAX_EMBEDS = 10;

export const DIR_EMOJI: Record<NewsAssessment["direction"], string> = {
  bullish: "🟢",
  bearish: "🔴",
  mixed: "🟡",
  neutral: "⚪",
};
const DIR_TH: Record<NewsAssessment["direction"], string> = {
  bullish: "ข่าวบวก",
  bearish: "ข่าวลบ",
  mixed: "ผสม",
  neutral: "กลาง",
};
const CATEGORY_TH: Record<NewsAssessment["category"], string> = {
  earnings: "งบการเงิน",
  guidance: "คาดการณ์ผลประกอบการ",
  dilution: "ออกหุ้นเพิ่ม (dilution)",
  mna: "ควบรวม/ซื้อกิจการ",
  contract: "สัญญา/ลูกค้า",
  product: "ผลิตภัณฑ์",
  regulatory: "กฎระเบียบ",
  legal: "คดี/กฎหมาย",
  management: "ผู้บริหาร",
  insider: "คนในซื้อ/ขาย",
  analyst: "นักวิเคราะห์",
  macro: "เศรษฐกิจมหภาค",
  sector: "ทั้งกลุ่มอุตสาหกรรม",
  other: "อื่นๆ",
};
const CONF_TH = { low: "ต่ำ", medium: "กลาง", high: "สูง" } as const;
const HORIZON_TH = { intraday: "ภายในวัน", days: "ไม่กี่วัน", weeks: "หลายสัปดาห์", months: "หลายเดือน" } as const;

export const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
const pct = (x: number | null) => (x == null ? "" : ` (${x >= 0 ? "+" : ""}${x.toFixed(1)}%)`);

function priceLine(symbols: string[], snapshots: Record<string, Snapshot>): string {
  return symbols
    .filter((s) => snapshots[s])
    .map((s) => `${s} $${snapshots[s].price}${pct(snapshots[s].changePct)}`)
    .join(" · ");
}

function newsEmbed(a: NewsAssessment, snapshots: Record<string, Snapshot>, icon: string) {
  const syms = a.symbols.length ? a.symbols : a.item.symbols;
  const t = etParts(new Date(a.item.publishedAt));
  const prices = priceLine(syms, snapshots);
  const lines = [
    `${icon} **${a.why || DIR_TH[a.direction]}**`,
    "",
    `📰 [${a.item.headline.slice(0, 200)}](${a.item.url})`,
    `-# ${a.item.source} · ${hhmm(t)} ET · ผลกระทบ ${stars(a.impact)} · มั่นใจ${CONF_TH[a.confidence]} · กรอบเวลา: ${HORIZON_TH[a.horizon]}`,
  ];
  if (prices) lines.push(`-# ราคาตอนนี้ (IEX): ${prices}`);
  return {
    title: `${DIR_EMOJI[a.direction]} ${syms.join(", ") || "ตลาด"} — ${DIR_TH[a.direction]} · ${CATEGORY_TH[a.category]}`.slice(0, 250),
    url: a.item.url,
    color: a.direction === "bullish" ? GREEN : a.direction === "bearish" ? RED : YELLOW,
    description: lines.join("\n").slice(0, 4000),
  };
}

export function buildNewsAlertMessage(
  alerts: NewsAssessment[],
  snapshots: Record<string, Snapshot>,
  summary: string,
  mode: "ai" | "rules" = "ai",
) {
  const sorted = [...alerts].sort((a, b) => b.impact - a.impact);
  let content = `📡 **News Radar** — ข่าวที่อาจทำให้ราคาขยับแรง (${alerts.length} ข่าว)`;
  if (summary) content += `\n🤖 ${summary}`;
  content +=
    mode === "ai"
      ? "\n-# AI ประเมินจากพาดหัว/สรุปข่าวเท่านั้น ไม่ใช่คำแนะนำการลงทุน"
      : "\n-# คัดด้วยคีย์เวิร์ดในพาดหัว/เอกสาร SEC (ไม่ได้อ่านเนื้อข่าว) อาจตีความผิดได้ — ไม่ใช่คำแนะนำการลงทุน";
  return {
    content,
    embeds: sorted.slice(0, MAX_EMBEDS).map((a) => newsEmbed(a, snapshots, mode === "ai" ? "🤖" : "📌")),
    allowed_mentions: { parse: [] },
  };
}

export function buildDigestMessage(date: string, entries: NewsLogEntry[], sentiment: DailySentiment | undefined) {
  const top = [...entries].sort((a, b) => b.impact - a.impact || b.at - a.at).slice(0, 15);
  const s = sentiment;
  const mood = s
    ? `อารมณ์ข่าววันนี้: 🟢 ${s.bull} · 🔴 ${s.bear} · 🟡 ${s.mixed} · ⚪ ${s.neutral} (ข่าวที่เกี่ยวข้อง ${s.total} ข่าว${s.hype ? `, เชิงเก็งกำไร/hype ${s.hype}` : ""})`
    : "";
  const lines = top.map(
    (e) =>
      `${DIR_EMOJI[e.direction]} **${e.symbols.join(",") || "ตลาด"}** ${stars(e.impact)} [${e.headline.slice(0, 120)}](${e.url})${e.why ? `\n-# ${e.why}` : ""}`,
  );
  return {
    content: `🗞️ **สรุปข่าวประจำวัน — ${thaiDate(date)}**${mood ? `\n${mood}` : ""}`,
    embeds: lines.length ? [{ description: lines.join("\n").slice(0, 4000), color: YELLOW }] : [],
    allowed_mentions: { parse: [] },
  };
}
