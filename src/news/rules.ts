import type { NewsAssessment } from "../ai/news-analyst";
import type { RawItem } from "./sources";
import type { NewsLogEntry } from "./state";

/**
 * คัดข่าวด้วยกฎ/คีย์เวิร์ด (ไม่ใช้ AI, ฟรี) — ให้ผลลัพธ์รูปเดียวกับ AI เพื่อใช้ร่วมกับระบบเตือน/สรุป/Heat Index
 *
 * หลักการ:
 * - เจอคีย์เวิร์ดใน "พาดหัว" = มั่นใจกลาง (เตือนได้) · เจอแค่ใน "สรุปข่าว" = มั่นใจต่ำ (ไม่เตือน ไปอยู่ในสรุปรายวัน)
 * - บทความความเห็น / "5 หุ้นที่ควรซื้อ" / ข่าวสำนักงานกฎหมายชวนฟ้อง = ลดความสำคัญ
 * - เจอทั้งคำบวกและคำลบ = "ผสม"
 * - เอกสาร SEC ให้คะแนนจากประเภทแบบฟอร์ม และ Item ของ 8-K
 */

type Direction = NewsAssessment["direction"];
type Rule = {
  re: RegExp;
  direction: Direction;
  impact: number;
  category: NewsAssessment["category"];
  horizon: NewsAssessment["horizon"];
  /** คำอธิบายภาษาไทย ({m} = คำที่เจอ) */
  why: string;
  /** ต้องมีคำว่า stock/shares ด้วย (กัน "AI adoption soars" ถูกนับเป็นราคาหุ้นพุ่ง) */
  needsStockWord?: boolean;
};

const STOCK_WORD = /\b(stocks?|shares)\b/;

const COMPANY_RULES: Rule[] = [
  // ---- ลบ ----
  { re: /\b(chapter 11|files? for bankruptcy|bankruptcy (filing|protection)|going concern)\b/, direction: "bearish", impact: 5, category: "legal", horizon: "months", why: "สัญญาณปัญหาการเงินรุนแรง (\"{m}\")" },
  { re: /\b(public offering|registered direct|at[- ]the[- ]market (offering|program)|atm (offering|program)|(prices?|priced|pricing of|announces?) (an? )?(upsized |proposed )?(\$[\d.,]+ ?(million|billion|m|b) )?(underwritten )?(stock |share |equity |common stock )?offering|private placement|equity offering|stock offering|share offering|convertible (senior )?notes? offering|shelf registration)\b/, direction: "bearish", impact: 4, category: "dilution", horizon: "days", why: "ออกหุ้น/หุ้นกู้แปลงสภาพเพิ่ม (\"{m}\") — มักกดดันราคาระยะสั้นจากการ dilution" },
  { re: /\b(delist(ing|ed)?|nasdaq (deficiency|notice|notification)|minimum bid (price)?|non-?compliance)\b/, direction: "bearish", impact: 4, category: "regulatory", horizon: "weeks", why: "เสี่ยงถูกถอดออกจากตลาด (\"{m}\")" },
  { re: /\breverse (stock )?split\b/, direction: "bearish", impact: 3, category: "other", horizon: "days", why: "ประกาศ reverse split (\"{m}\") — มักเกิดกับหุ้นที่ราคาตกต่ำ ตลาดมักมองลบ" },
  { re: /\b(miss(es|ed)? (on )?(estimates|expectations|consensus|forecasts?)|(revenue|earnings|eps|profit|sales) (miss(es)?|falls? short|below (estimates|expectations))|disappointing (results|quarter))\b/, direction: "bearish", impact: 4, category: "earnings", horizon: "days", why: "ผลประกอบการต่ำกว่าคาด (\"{m}\")" },
  { re: /\b((cuts?|lowers?|slashes?|reduces?|withdraws?|suspends?) (its |full[- ]year |annual |fy\d* )?(guidance|outlook|forecasts?)|weak (guidance|outlook|forecast)|guidance cut)\b/, direction: "bearish", impact: 4, category: "guidance", horizon: "weeks", why: "ลดคาดการณ์ผลประกอบการ (\"{m}\")" },
  { re: /\b(sec (probe|investigation|charges|subpoena)|doj (probe|investigation)|subpoena|accounting (irregularities|probe)|fraud|short[- ]seller|short report)\b/, direction: "bearish", impact: 4, category: "legal", horizon: "weeks", why: "ประเด็นกฎหมาย/การสอบสวน (\"{m}\")" },
  { re: /\b(terminat(es|ed|ion of) (the |its )?(merger|agreement|contract|deal|partnership)|(contract|deal|merger) (cancel(l)?ed|terminated|collapses?|falls? through))\b/, direction: "bearish", impact: 4, category: "contract", horizon: "weeks", why: "ยกเลิกสัญญา/ดีล (\"{m}\")" },
  { re: /\b((ceo|cfo|chief executive|chief financial officer|founder) (resigns?|steps? down|to step down|departs?|exits?|ousted|fired|leaves)|(resignation|departure|ouster) of (its )?(ceo|cfo|chief executive))\b/, direction: "bearish", impact: 3, category: "management", horizon: "weeks", why: "ผู้บริหารระดับสูงลาออก (\"{m}\")" },
  { re: /\b(downgrade[sd]?\b|(cuts|lowers|slashes) (its |the )?price target)/, direction: "bearish", impact: 3, category: "analyst", horizon: "days", why: "นักวิเคราะห์ลดคำแนะนำ (\"{m}\")" },
  { re: /\b(recalls?|trading halt(ed)?|halts? (production|shipments|trading)|data breach|cyberattack|explosion|grounded|launch failure|anomaly)\b/, direction: "bearish", impact: 3, category: "product", horizon: "days", why: "เหตุการณ์เชิงลบด้านปฏิบัติการ (\"{m}\")" },
  { re: /\b(layoffs?|job cuts|restructuring|impairment|write[- ]?downs?|write[- ]?offs?)\b/, direction: "bearish", impact: 3, category: "other", horizon: "weeks", why: "ปรับโครงสร้าง/ด้อยค่า (\"{m}\")" },
  { re: /\b(export (bans?|restrictions?|controls?)|sanctions?|antitrust (suit|probe|lawsuit))\b/, direction: "bearish", impact: 3, category: "regulatory", horizon: "weeks", why: "ความเสี่ยงด้านกฎระเบียบ (\"{m}\")" },
  { re: /\b(plunge[sd]|plummet(s|ed)|tank(s|ed)|crash(es|ed)|tumble[sd]|sinks|sank|crater(s|ed)|nosedives?d?|slump(s|ed))\b/, direction: "bearish", impact: 3, category: "other", horizon: "intraday", needsStockWord: true, why: "ราคากำลังร่วงแรง (\"{m}\") — ข่าวนี้อธิบายการขยับที่เกิดขึ้นแล้ว" },

  // ---- บวก ----
  { re: /\b((agrees? )?to be acquired|buyout (offer|deal)|takeover (offer|bid)|go(es|ing)?[- ]private|tender offer|acquisition (offer|proposal) (for|from))\b/, direction: "bullish", impact: 5, category: "mna", horizon: "days", why: "มีข้อเสนอซื้อกิจการ (\"{m}\") — ราคามักวิ่งเข้าหาราคาเสนอซื้อ" },
  { re: /\b(merger agreement|to acquire|acquires|acquisition of|to merge with|definitive agreement)\b/, direction: "mixed", impact: 3, category: "mna", horizon: "weeks", why: "ดีลควบรวม/ซื้อกิจการ (\"{m}\") — ผู้ถูกซื้อมักบวก ผู้ซื้อมักผสม" },
  { re: /\b((beats?|tops?|exceeds?|surpass(es)?|crushes) (on )?(estimates|expectations|consensus|forecasts?|views)|(record|blowout) (revenue|quarter|results|earnings|sales))\b/, direction: "bullish", impact: 4, category: "earnings", horizon: "days", why: "ผลประกอบการดีกว่าคาด (\"{m}\")" },
  { re: /\b((raises?|lifts?|boosts?|hikes?|increases?|ups) (its |full[- ]year |annual |fy\d* )?(guidance|outlook|forecasts?)|strong (guidance|outlook))\b/, direction: "bullish", impact: 4, category: "guidance", horizon: "weeks", why: "เพิ่มคาดการณ์ผลประกอบการ (\"{m}\")" },
  { re: /\b(fda (approval|approves|clearance)|regulatory approval|faa (approval|certification|license)|fcc (approval|grants?|authorization)|receives? (final )?approval)\b/, direction: "bullish", impact: 4, category: "regulatory", horizon: "weeks", why: "ได้รับอนุมัติจากหน่วยงานกำกับ (\"{m}\")" },
  { re: /\b(join(s|ing)? the s&p 500|added to (the )?(s&p 500|nasdaq[- ]100)|(s&p 500|nasdaq[- ]100) inclusion)\b/, direction: "bullish", impact: 4, category: "other", horizon: "days", why: "ถูกเพิ่มเข้าดัชนี (\"{m}\") — กองทุนดัชนีต้องซื้อ" },
  { re: /\b((awarded|wins?|won|secures?|lands?|receives?) (an? |its )?(first |largest |new )?(\$[\d.,]+ ?(million|billion|m|b|bn) |multi[- ]?(million|billion)[- ](dollar )?|major |large |government |defense |military |nasa )?(contract|order|award|deal)|(contract|order|deal) (worth|valued at))\b/, direction: "bullish", impact: 3, category: "contract", horizon: "weeks", why: "ได้สัญญา/คำสั่งซื้อใหม่ (\"{m}\")" },
  { re: /\b(upgrade[sd]?\b(?=.*\b(buy|outperform|overweight|neutral|hold|equal[- ]weight|market perform|analyst|price target)\b)|(raises|lifts|boosts|hikes) (its |the )?price target)/, direction: "bullish", impact: 3, category: "analyst", horizon: "days", why: "นักวิเคราะห์เพิ่มคำแนะนำ (\"{m}\")" },
  { re: /\b(buyback|share repurchase|repurchase program|special dividend|raises (its )?(quarterly )?dividend|dividend (increase|hike))\b/, direction: "bullish", impact: 3, category: "other", horizon: "weeks", why: "ซื้อหุ้นคืน/เพิ่มปันผล (\"{m}\")" },
  { re: /\b(insider (buying|buys|purchase)|(ceo|cfo|director|chairman) (buys|bought|purchases))\b/, direction: "bullish", impact: 3, category: "insider", horizon: "weeks", why: "ผู้บริหารซื้อหุ้นเพิ่ม (\"{m}\")" },
  { re: /\b(soar(s|ed|ing)|surge[sd]|surging|skyrocket(s|ed|ing)|jump(s|ed)|rocket(s|ed|ing)(?! lab)|spike[sd]|rallie[sd]|zoom(s|ed))\b/, direction: "bullish", impact: 3, category: "other", horizon: "intraday", needsStockWord: true, why: "ราคากำลังพุ่งแรง (\"{m}\") — ข่าวนี้อธิบายการขยับที่เกิดขึ้นแล้ว" },
  { re: /\b(partnership|partners with|collaboration|strategic alliance|teams up with|expands? partnership)\b/, direction: "bullish", impact: 2, category: "contract", horizon: "weeks", why: "จับมือพันธมิตร (\"{m}\") — ข่าวประเภทนี้มีบ่อย ผลมักจำกัด" },
];

/**
 * ข่าวมหภาค: ถ้าไม่เข้ากฎข้อไหนเลย = ไม่เกี่ยวข้อง
 * สูงสุด ★3 = เข้าสรุปรายวัน + Heat Index แต่ไม่เตือนทันที (คีย์เวิร์ดแยกไม่ออกว่าเป็นข่าว US หรือประเทศอื่น)
 */
const MACRO_RULES: Rule[] = [
  { re: /\b(rate hike|raises? (interest )?rates|hawkish)\b/, direction: "bearish", impact: 3, category: "macro", horizon: "weeks", why: "ดอกเบี้ยขาขึ้น/ท่าทีเข้มงวด (\"{m}\") — กดดันหุ้นเติบโตอย่าง Nasdaq" },
  { re: /\b((inflation|cpi|pce|prices?) (jumps?|accelerates?|hotter|surges?|rises? more|higher than expected|heats? up)|hot(ter)?[- ](than[- ]expected )?(inflation|cpi))\b/, direction: "bearish", impact: 3, category: "macro", horizon: "weeks", why: "เงินเฟ้อสูงกว่าคาด (\"{m}\") — ลดโอกาสลดดอกเบี้ย" },
  { re: /\b(recession|market (rout|crash|selloff|sell-off)|stocks? (plunge|tumble|sink|slide|crash)|bear market|correction territory|sell-?off)\b/, direction: "bearish", impact: 3, category: "macro", horizon: "days", why: "แรงขายทั้งตลาด/ความกังวลเศรษฐกิจ (\"{m}\")" },
  { re: /\b(tariffs?|trade war|export controls?|chip (ban|curbs|restrictions)|ai (bubble|rout|selloff|sell-off)|credit risks?|turmoil)\b/, direction: "bearish", impact: 3, category: "sector", horizon: "weeks", why: "ความเสี่ยงต่อกลุ่มเทค/ชิป/AI (\"{m}\")" },
  { re: /\b(rate cuts?|cuts? (interest )?rates|dovish|(inflation|cpi|pce) (cools|eases|slows|softer|lower than expected))\b/, direction: "bullish", impact: 3, category: "macro", horizon: "weeks", why: "ดอกเบี้ยขาลง/เงินเฟ้อชะลอ (\"{m}\") — หนุนหุ้นเติบโต" },
  { re: /\b(record highs?|all-time highs?|stocks? (rally|surge|soar|jump)|ai (boom|rally|trade))\b/, direction: "bullish", impact: 2, category: "macro", horizon: "days", why: "ตลาดคึกคัก (\"{m}\")" },
  { re: /\b(fed|fomc|powell|federal reserve|jobs report|payrolls|unemployment|gdp|treasury yields?|bond yields?)\b/, direction: "mixed", impact: 2, category: "macro", horizon: "days", why: "ข่าวเศรษฐกิจ/ดอกเบี้ยที่ตลาดจับตา (\"{m}\")" },
  { re: /\b(nvidia|semiconductor|chip ?(stocks|makers?)|ai (stocks|spending|capex|buildout|data cent(er|re)s?)|nasdaq|big tech|magnificent seven)\b/, direction: "neutral", impact: 2, category: "sector", horizon: "days", why: "ข่าวกลุ่มเทค/AI (\"{m}\")" },
];

/** บทความความเห็น/ชวนซื้อ/ขายคอร์ส — ลดความสำคัญ */
const OPINION = /(\bshould you\b|\bis it time\b|\bstocks? to (buy|watch|own)\b|\btop \d+\b|\b\d+ (stocks|reasons|things)\b|\bhere'?s (why|what|how)\b|\bwhat to (know|expect)\b|\bbetter buy\b|\bcould make you\b|\bmillionaire\b|\bprediction:|\bbuy (now|and hold)\b|\bvs\.? |\?$|\bwhy .* (stock|shares) (is|are) (up|down|soaring|falling|trading)\b)/;
/** สำนักงานกฎหมายชวนผู้ถือหุ้นร่วมฟ้อง — มีทุกวัน แทบไม่มีผลต่อราคา */
const LAW_FIRM_SPAM = /(law firm|investors who (lost|purchased)|shareholder (alert|rights)|class action (lawsuit )?(filed|deadline|reminder)|lead plaintiff|encourages .* investors|investigation on behalf of)/;
/** ภาษาเก็งกำไร/ตลาดร้อน (นับใน Heat Index) */
const HYPE = /\b(skyrocket\w*|to the moon|next nvidia|millionaire|explod(e|es|ing)|frenzy|euphori\w*|mania|bubble|meme stocks?|parabolic|fomo|record inflows|retail traders? pile|leveraged etf)\b/;

// ---------- เอกสาร SEC ----------

const FORM_RULES: Array<{ re: RegExp } & Omit<Rule, "re"> & { confidence: NewsAssessment["confidence"] }> = [
  { re: /^(25-NSE|15-12[BG])/, direction: "bearish", impact: 4, category: "regulatory", horizon: "weeks", confidence: "medium", why: "ยื่น {m} ถอดหุ้นออกจากตลาด/ยกเลิกการจดทะเบียน — บางครั้งเป็นแค่การย้ายตลาด (เช่น NYSE → Nasdaq) ควรตรวจสอบ" },
  { re: /^NT 10-[QK]/, direction: "bearish", impact: 4, category: "regulatory", horizon: "weeks", confidence: "high", why: "แจ้งว่าส่งงบไม่ทันกำหนด ({m}) — มักเป็นสัญญาณปัญหาบัญชี/การเงิน" },
  { re: /^S-1/, direction: "bearish", impact: 4, category: "dilution", horizon: "weeks", confidence: "medium", why: "ยื่น {m} เตรียมขายหุ้นใหม่ — มีโอกาส dilution" },
  { re: /^424B[345]/, direction: "bearish", impact: 4, category: "dilution", horizon: "days", confidence: "medium", why: "ยื่น prospectus {m} — มักหมายถึงการขายหุ้น/หุ้นกู้แปลงสภาพจริง (dilution)" },
  { re: /^(S-3|F-3)/, direction: "bearish", impact: 3, category: "dilution", horizon: "weeks", confidence: "medium", why: "ยื่น shelf registration {m} — เปิดทางออกหุ้นเพิ่มในอนาคต" },
  { re: /^(SC 13D|SCHEDULE 13D)/, direction: "mixed", impact: 3, category: "insider", horizon: "weeks", confidence: "medium", why: "ผู้ถือหุ้นรายใหญ่ (≥5%) ที่อาจเข้ามามีบทบาท ยื่น {m}" },
  { re: /^424B/, direction: "neutral", impact: 2, category: "other", horizon: "weeks", confidence: "medium", why: "prospectus {m} (ส่วนใหญ่เป็นตราสารหนี้)" },
  { re: /^(10-Q|10-K|6-K|SC 13G|SCHEDULE 13G)/, direction: "neutral", impact: 2, category: "other", horizon: "weeks", confidence: "medium", why: "ยื่นเอกสารตามรอบ ({m})" },
];

/** 8-K: ให้คะแนนจาก Item ที่สำคัญที่สุด */
const ITEM_RULES: Record<string, Omit<Rule, "re" | "category"> & { category: NewsAssessment["category"]; confidence: NewsAssessment["confidence"] }> = {
  "1.03": { direction: "bearish", impact: 5, category: "legal", horizon: "months", confidence: "high", why: "8-K Item 1.03 ล้มละลาย/พิทักษ์ทรัพย์" },
  "4.02": { direction: "bearish", impact: 5, category: "legal", horizon: "weeks", confidence: "high", why: "8-K Item 4.02 งบการเงินเดิมเชื่อถือไม่ได้ (ต้องแก้งบ)" },
  "3.01": { direction: "bearish", impact: 4, category: "regulatory", horizon: "weeks", confidence: "high", why: "8-K Item 3.01 ถูกแจ้งว่าไม่ผ่านเกณฑ์การจดทะเบียน (เสี่ยง delisting)" },
  "2.02": { direction: "mixed", impact: 3, category: "earnings", horizon: "days", confidence: "medium", why: "8-K Item 2.02 ประกาศผลประกอบการ — ดูตัวเลขเทียบกับที่ตลาดคาด" },
  "3.02": { direction: "bearish", impact: 3, category: "dilution", horizon: "days", confidence: "medium", why: "8-K Item 3.02 ขายหุ้นแบบไม่จดทะเบียน (dilution)" },
  "1.01": { direction: "mixed", impact: 3, category: "contract", horizon: "weeks", confidence: "medium", why: "8-K Item 1.01 ทำสัญญาสำคัญ" },
  "1.02": { direction: "bearish", impact: 3, category: "contract", horizon: "weeks", confidence: "medium", why: "8-K Item 1.02 ยกเลิกสัญญาสำคัญ" },
  "2.05": { direction: "bearish", impact: 3, category: "other", horizon: "weeks", confidence: "medium", why: "8-K Item 2.05 ปรับโครงสร้าง/ปิดกิจการบางส่วน" },
  "2.06": { direction: "bearish", impact: 3, category: "other", horizon: "weeks", confidence: "medium", why: "8-K Item 2.06 ด้อยค่าสินทรัพย์" },
  "5.02": { direction: "mixed", impact: 3, category: "management", horizon: "weeks", confidence: "medium", why: "8-K Item 5.02 เปลี่ยนแปลงผู้บริหาร/กรรมการ" },
  "2.01": { direction: "mixed", impact: 3, category: "mna", horizon: "weeks", confidence: "medium", why: "8-K Item 2.01 ซื้อ/ขายสินทรัพย์สำคัญเสร็จสิ้น" },
};

function base(item: RawItem): NewsAssessment {
  return {
    item,
    relevant: false,
    symbols: item.symbols,
    direction: "neutral",
    impact: 1,
    confidence: "low",
    horizon: "days",
    category: "other",
    hype: false,
    duplicate: false,
    why: "",
  };
}

function classifyFiling(item: RawItem): NewsAssessment {
  const out = { ...base(item), relevant: true, impact: 2, confidence: "medium" as const };
  const form = item.headline.match(/ยื่น (\S+)/)?.[1] ?? "";

  if (/^8-K/.test(form)) {
    const items = [...item.summary.matchAll(/Item (\d\.\d\d)/g)].map((m) => m[1]);
    const hits = items.map((i) => ITEM_RULES[i]).filter(Boolean);
    if (!hits.length) return { ...out, why: `8-K รายงานเหตุการณ์ทั่วไป (Item ${items.join(", ") || "-"})` };
    const top = hits.sort((a, b) => b.impact - a.impact)[0];
    const others = hits.filter((h) => h !== top).map((h) => h.why.replace(/^8-K /, ""));
    return { ...out, ...top, why: top.why + (others.length ? ` + ${others.join(", ")}` : "") };
  }
  for (const r of FORM_RULES) {
    if (r.re.test(form)) {
      return { ...out, direction: r.direction, impact: r.impact, category: r.category, horizon: r.horizon, confidence: r.confidence, why: r.why.replace("{m}", form) };
    }
  }
  return { ...out, why: `ยื่น ${form}` };
}

function firstMatch(rules: Rule[], text: string): { rule: Rule; match: string } | null {
  let best: { rule: Rule; match: string } | null = null;
  for (const rule of rules) {
    if (rule.needsStockWord && !STOCK_WORD.test(text)) continue;
    const m = text.match(rule.re);
    if (m && (!best || rule.impact > best.rule.impact)) best = { rule, match: m[0] };
  }
  return best;
}

function classifyText(item: RawItem, rules: Rule[], macro: boolean): NewsAssessment {
  const out = base(item);
  const headline = item.headline.toLowerCase();
  const summary = item.summary.toLowerCase();
  out.hype = HYPE.test(headline) || HYPE.test(summary);

  if (LAW_FIRM_SPAM.test(headline)) {
    return { ...out, relevant: !macro, impact: 1, category: "legal", why: "" };
  }

  const bull = (t: string) => firstMatch(rules.filter((r) => r.direction === "bullish"), t);
  const bear = (t: string) => firstMatch(rules.filter((r) => r.direction === "bearish"), t);
  const other = (t: string) => firstMatch(rules.filter((r) => r.direction === "mixed" || r.direction === "neutral"), t);

  // พาดหัวมาก่อน (มั่นใจกลาง) ถ้าพาดหัวไม่เจอค่อยดูสรุปข่าว (มั่นใจต่ำ)
  let inHeadline = true;
  let up = bull(headline);
  let down = bear(headline);
  let mid = other(headline);
  if (!up && !down && !mid) {
    inHeadline = false;
    up = bull(summary);
    down = bear(summary);
    mid = other(summary);
  }

  let pick: { rule: Rule; match: string } | null;
  let direction: Direction;
  let impact: number;
  if (up && down) {
    // เจอทั้งบวกและลบ: ใช้ตัวที่หนักกว่าเป็นหลัก แต่ทิศทาง "ผสม" และลดคะแนนลง 1
    pick = up.rule.impact >= down.rule.impact ? up : down;
    direction = "mixed";
    impact = Math.max(2, pick.rule.impact - 1);
  } else {
    pick = up ?? down ?? mid;
    if (!pick) return { ...out, relevant: !macro && item.symbols.length > 0, why: "" };
    direction = pick.rule.direction;
    impact = pick.rule.impact;
  }

  let confidence: NewsAssessment["confidence"] = inHeadline ? "medium" : "low";
  if (OPINION.test(headline)) {
    impact = Math.min(impact, 2);
    confidence = "low";
  }

  return {
    ...out,
    relevant: true,
    symbols: macro ? ["QQQ"] : item.symbols,
    direction,
    impact,
    confidence,
    horizon: pick.rule.horizon,
    category: pick.rule.category,
    why: impact >= 3 ? pick.rule.why.replace("{m}", pick.match) + (inHeadline ? "" : " (เจอในเนื้อข่าว ไม่ใช่พาดหัว)") : "",
  };
}

/**
 * key สำหรับกันซ้ำ: ข่าวบริษัท = หุ้น + ประเภท + ทิศทาง (เช่น เอกสาร 424B5 กับข่าว "prices offering" คือเรื่องเดียวกัน)
 * ข่าวมหภาคผูกกับ QQQ หมด จึงใช้คำอธิบาย (ซึ่งมีคำที่เจอ) แทน
 */
function dedupKeys(a: { symbols: string[]; category: string; direction: string; why: string }): string[] {
  if (a.category === "macro" || a.category === "sector") return [`macro|${a.why}`];
  return a.symbols.map((s) => `${s}|${a.category}|${a.direction}`);
}

/**
 * ให้คะแนนทุกข่าวด้วยกฎ + กันซ้ำ: เรื่องเดียวกันที่เตือนไปแล้วใน 24 ชม. หรือซ้ำในรอบนี้ = duplicate
 */
export function classifyByRules(items: RawItem[], recentLog: NewsLogEntry[], now: number): NewsAssessment[] {
  const alerted = new Set(recentLog.filter((e) => e.alerted && now - e.at < 86_400_000).flatMap(dedupKeys));
  const seenInBatch = new Set<string>();

  return items.map((item) => {
    const a = item.kind === "filing" ? classifyFiling(item) : classifyText(item, item.kind === "macro" ? MACRO_RULES : COMPANY_RULES, item.kind === "macro");
    if (a.relevant && a.impact >= 3) {
      const keys = dedupKeys(a);
      a.duplicate = keys.some((k) => alerted.has(k) || seenInBatch.has(k));
      for (const k of keys) seenInBatch.add(k);
    }
    return a;
  });
}
