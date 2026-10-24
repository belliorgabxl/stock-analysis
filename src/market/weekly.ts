import Anthropic from "@anthropic-ai/sdk";

import { fallbackOptions } from "../ai/news-analyst";
import { loadState } from "../alerts/state";
import { loadConfig } from "../config";
import { fetchDailyBars } from "../lib/alpaca";
import { sendDiscord, thaiDate } from "../lib/discord";
import { etParts } from "../lib/time";
import type { Env } from "../model/config-env";
import { loadNewsState, pruneNewsState, saveNewsState } from "../news/state";
import { computeHeat, type HeatResult } from "./heat";
import { reviewAccuracy, reviewSymbols, type BucketStats, type ReviewResult } from "./review";

export type WeeklyOptions = { now?: Date; dryRun?: boolean; force?: boolean; skipAi?: boolean };

/** รอบรายสัปดาห์: เช้าวันเสาร์ (ET ≥ 09:00) ครั้งเดียว */
export function weeklyDue(now: Date, lastSent: string | null): boolean {
  const et = etParts(now);
  return et.weekday === 6 && et.hour >= 9 && lastSent !== et.date;
}

export async function computeMarketReport(env: Env, now: Date) {
  const cfg = loadConfig(env);
  const et = etParts(now);
  const [newsState, alertState] = await Promise.all([loadNewsState(env.STOCK_STATE), loadState(env.STOCK_STATE)]);

  const reviewSyms = reviewSymbols(alertState.aiLog, newsState.log);
  const [qqq, others] = await Promise.all([
    fetchDailyBars(["QQQ"], env, cfg.feed, now, 400),
    fetchDailyBars([...new Set([...cfg.heat.basket, ...reviewSyms])], env, cfg.feed, now, 130),
  ]);

  const basket = Object.fromEntries(cfg.heat.basket.filter((s) => others.bars[s]).map((s) => [s, others.bars[s]]));
  const last7 = Object.entries(newsState.sentiment)
    .filter(([d]) => Date.parse(et.date) - Date.parse(d) < 7 * 86_400_000)
    .map(([, s]) => s);

  const heat = computeHeat(qqq.bars.QQQ ?? [], basket, last7);
  const review = reviewAccuracy(alertState.aiLog, newsState.log, { ...others.bars, QQQ: qqq.bars.QQQ ?? [] }, et.date);
  const prev = newsState.heatHistory.filter((h) => h.date < et.date).at(-1) ?? null;
  return { cfg, et, newsState, heat, review, prev };
}

export async function runWeekly(env: Env, opts: WeeklyOptions = {}) {
  const now = opts.now ?? new Date();
  if (!opts.force && !opts.dryRun && !weeklyDue(now, (await loadNewsState(env.STOCK_STATE)).weeklySent)) {
    return { status: "skipped", reason: "not weekly time" };
  }
  const { cfg, et, newsState, heat, review, prev } = await computeMarketReport(env, now);
  if (!heat) return { status: "error", reason: "not enough QQQ data" };

  const commentary =
    env.ANTHROPIC_API_KEY && !opts.skipAi ? await heatCommentary(env.ANTHROPIC_API_KEY, cfg.ai.model, heat, prev?.score ?? null) : "";
  const payload = buildWeeklyMessage(et.date, heat, prev?.score ?? null, review, commentary);

  if (!opts.dryRun) {
    await sendDiscord(cfg.news.webhook, payload);
    newsState.heatHistory.push({ date: et.date, score: heat.score, components: heat.components });
    newsState.weeklySent = et.date;
    pruneNewsState(newsState, now.getTime());
    await saveNewsState(env.STOCK_STATE, newsState);
  }
  return { status: "ok", heat, prevScore: prev?.score ?? null, review, commentary, ...(opts.dryRun ? { payload } : {}) };
}

// ---------- ข้อความ ----------

const n0 = (x: number | null, suffix = "") => (x == null ? "n/a" : `${x.toFixed(0)}${suffix}`);
const sp = (x: number | null) => (x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);

export function heatBar(score: number): string {
  const filled = Math.round(score / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

export function heatEmbed(date: string, heat: HeatResult, prevScore: number | null, commentary = "") {
  const f = heat.facts;
  const c = heat.components;
  const delta = prevScore == null ? "" : ` · สัปดาห์ก่อน ${prevScore} (${heat.score - prevScore >= 0 ? "▲" : "▼"}${Math.abs(heat.score - prevScore)})`;
  const lines = [
    `${heatBar(heat.score)} **${heat.score}/100**${delta}`,
    "",
    `• แนวโน้ม — QQQ $${f.qqqPrice.toFixed(2)} เทียบ SMA200 ${sp(f.qqqVsSma200Pct)}, ห่างจุดสูงสุด 52w ${sp(f.fromHigh52Pct)}: **${n0(c.trend)}**`,
    `• โมเมนตัม — RSI14 ${n0(f.rsi14)}: **${n0(c.momentum)}**`,
    `• Breadth — หุ้นใหญ่ ${n0(f.breadthPct, "%")} จาก ${f.breadthCount} ตัว อยู่เหนือ SMA50: **${n0(c.breadth)}**`,
    `• ความชะล่าใจ — ผันผวน 20 วัน ${n0(f.vol20Pct, "%")}/ปี (สูงกว่า ${n0(f.volPercentile, "%")} ของรอบปี): **${n0(c.complacency)}**`,
    c.news == null
      ? `• ข่าว — ข้อมูลยังไม่พอ (${f.newsCount} ข่าว, ต้องรัน News Radar สักพัก)`
      : `• ข่าว — บวก ${n0((f.bullShare ?? 0) * 100, "%")} ของข่าวที่มีทิศทาง, hype ${n0((f.hypeShare ?? 0) * 100, "%")} (${f.newsCount} ข่าว 7 วัน): **${n0(c.news)}**`,
  ];
  if (heat.warnings.length) lines.push("", ...heat.warnings.map((w) => `⚠️ ${w}`));
  if (commentary) lines.push("", `🤖 ${commentary}`);
  lines.push("", "-# วัดความร้อนแรงของตลาดจากข้อมูลจริง ไม่ใช่ความน่าจะเป็นที่ฟองสบู่จะแตก — ตลาดร้อนอยู่ได้นาน");
  return {
    title: `🌡️ Market Heat Index — ${heat.label}`,
    color: heat.score >= 70 ? 0xe74c3c : heat.score >= 50 ? 0xf39c12 : heat.score >= 30 ? 0x95a5a6 : 0x3498db,
    description: lines.join("\n").slice(0, 4000),
    footer: { text: `ข้อมูลถึง ${thaiDate(date)}` },
  };
}

function bucketLine(name: string, s: BucketStats, hitLabel: string): string {
  if (!s.n) return `• ${name}: ยังไม่มีข้อมูล`;
  return `• ${name} (${s.n} ครั้ง): ${hitLabel} 1 วัน ${n0(s.hitRate1, "%")} · 5 วัน ${n0(s.hitRate5, "%")} · ขยับเฉลี่ย 5 วัน ±${s.avgAbsMove5?.toFixed(1) ?? "n/a"}% · ถ้าตามทิศ ${sp(s.avgDirectional5)}`;
}

export function reviewEmbed(review: ReviewResult) {
  const lines = [
    "**แจ้งเตือนราคา** (ราคาไปต่อทางเดียวกับวันที่เตือนไหม แยกตาม ★ ของ AI)",
    ...Object.entries(review.priceAlerts).map(([k, s]) => bucketLine(k, s, "ไปต่อ")),
    "",
    "**News Radar** (ราคาไปตามทิศที่ประเมินไว้ไหม)",
    ...Object.entries(review.news).map(([k, s]) => bucketLine(k, s, "ทายถูก")),
    "",
    `-# ย้อนหลัง ${review.windowDays} วัน · รอผล ${review.pending} รายการ · 50% = เดาสุ่ม ต้องมีหลายสิบครั้งขึ้นไปถึงจะเชื่อถือได้`,
  ];
  return { title: "🎯 ระบบเตือนแม่นแค่ไหน (เทียบกับราคาจริง)", color: 0x9b59b6, description: lines.join("\n").slice(0, 4000) };
}

export function buildWeeklyMessage(date: string, heat: HeatResult, prevScore: number | null, review: ReviewResult, commentary: string) {
  return {
    content: `📅 **สรุปรายสัปดาห์ — ${thaiDate(date)}**`,
    embeds: [heatEmbed(date, heat, prevScore, commentary), reviewEmbed(review)],
    allowed_mentions: { parse: [] },
  };
}

/** ให้ Claude อธิบายตัวเลข Heat Index 2 ประโยค (ไม่สำเร็จ = ข้าม) */
async function heatCommentary(apiKey: string, model: string, heat: HeatResult, prevScore: number | null): Promise<string> {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 2000,
      ...fallbackOptions(model),
      output_config: { effort: "low" },
      system:
        "คุณคือผู้ช่วยวิเคราะห์ตลาดหุ้น US สำหรับนักลงทุนรายย่อยชาวไทย อธิบายตัวเลข Market Heat Index ที่ให้มาเป็นภาษาไทยไม่เกิน 2 ประโยค: ภาพรวมตอนนี้คืออะไรและควรระวังอะไร ใช้เฉพาะตัวเลขที่ให้มา ห้ามบอกเป็นความน่าจะเป็นหรือทำนายว่าฟองสบู่จะแตกเมื่อไร ไม่ให้คำแนะนำซื้อขาย ตอบเป็นข้อความล้วน ไม่มีหัวข้อหรือ bullet",
      messages: [{ role: "user", content: JSON.stringify({ ...heat, prevScore }) }],
    });
    if (response.stop_reason === "refusal") return "";
    return response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    console.error("[heat-ai] failed", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
    return "";
  }
}
