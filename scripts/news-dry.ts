/**
 * ทดสอบ News Radar + Heat Index กับข้อมูลจริงในเครื่อง (ไม่ส่ง Discord ไม่แตะ KV จริง)
 *
 *   npm run news:dry                                   # ดึงข่าว 12 ชม.ล่าสุด + Heat Index
 *   SEC_USER_AGENT="MyBot me@example.com" npm run news:dry
 *   npm run news:dry -- --state state.json             # ใช้ state จริง (export ด้วย wrangler kv key get)
 *
 * ถ้ามี ANTHROPIC_API_KEY (ใน .dev.vars หรือ env) จะเรียก AI จริง (เสียเงินเล็กน้อย)
 */
import fs from "node:fs";
import { runWeekly } from "../src/market/weekly";
import type { Env } from "../src/model/config-env";
import { runNewsRadar } from "../src/news/radar";

function readVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  const jsonc = fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = jsonc.match(/"vars"\s*:\s*(\{[\s\S]*?\})/);
  if (m) Object.assign(vars, JSON.parse(m[1].replace(/,\s*\}/, "}")));
  if (fs.existsSync(".dev.vars")) {
    for (const line of fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0) vars[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
  }
  return vars;
}

const args = process.argv.slice(2);
const stateFile = args.includes("--state") ? args[args.indexOf("--state") + 1] : null;

// KV จำลองในหน่วยความจำ (อ่าน state จริงจากไฟล์ได้ถ้าส่ง --state)
const store = new Map<string, string>();
if (stateFile) store.set("state:v2", fs.readFileSync(stateFile, "utf8"));
const kv = {
  async get(key: string, type?: string) {
    const v = store.get(key);
    return v == null ? null : type === "json" ? JSON.parse(v) : v;
  },
  async put(key: string, value: string) {
    store.set(key, value);
  },
} as unknown as KVNamespace;

const env = { ...readVars(), STOCK_STATE: kv } as unknown as Env;
for (const k of ["SEC_USER_AGENT", "ANTHROPIC_API_KEY", "NEWS_AI_MODEL", "NEWS_EXTRA_SYMBOLS", "WATCHLIST"] as const) {
  if (process.env[k]) (env as any)[k] = process.env[k];
}
const skipAi = !env.ANTHROPIC_API_KEY;

console.log(`\n=== News Radar (AI: ${skipAi ? "off" : "on"}, SEC: ${env.SEC_USER_AGENT ? "on" : "off"}) ===`);
const radar: any = await runNewsRadar(env, { dryRun: true, force: true, ignoreSeen: true, skipAi });
console.log(JSON.stringify({ since: radar.since, fetched: radar.fetched, fresh: radar.fresh, ai: radar.ai }, null, 2));
for (const line of radar.items ?? []) console.log("  ", line.slice(0, 160));
for (const a of radar.assessed ?? []) {
  console.log(`  ${a.impact}★ ${a.direction.padEnd(7)} ${a.symbols.join(",").padEnd(10)} ${a.headline.slice(0, 90)}\n      ${a.why}`);
}
console.log(`alerts: ${radar.alerts?.length ?? 0}`);

console.log("\n=== Weekly: Heat Index + AI review ===");
const weekly: any = await runWeekly(env, { dryRun: true, skipAi });
if (weekly.heat) {
  console.log(`score ${weekly.heat.score} (${weekly.heat.label})`);
  console.log(JSON.stringify({ components: weekly.heat.components, facts: weekly.heat.facts, warnings: weekly.heat.warnings }, null, 2));
  console.log(JSON.stringify(weekly.review, null, 2));
  if (weekly.commentary) console.log("AI:", weekly.commentary);
  for (const e of weekly.payload.embeds) console.log(`\n--- ${e.title}\n${e.description}`);
} else {
  console.log(weekly);
}
