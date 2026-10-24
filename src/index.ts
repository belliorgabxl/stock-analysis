import { Hono, type Context, type Next } from "hono";

import { runAlerts } from "./alerts/runner";
import { handleInteraction, verifyDiscordRequest } from "./discord/interactions";
import { sendDiscord } from "./lib/discord";
import { runWeekly } from "./market/weekly";
import type { Env } from "./model/config-env";
import { runNewsRadar } from "./news/radar";

const NEWS_CRON = "5,35 * * * *";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

// endpoint ด้านล่างต้องใส่ header x-trigger-token (กันคนอื่นยิง Discord/Alpaca ของเรา)
app.use("/run", auth);
app.use("/trigger-alerts", auth);
app.use("/test-discord", auth);
app.use("/news", auth);
app.use("/weekly", auth);

async function auth(c: Context<{ Bindings: Env }>, next: Next) {
  const token = c.req.header("x-trigger-token");
  if (!token || token !== c.env.TRIGGER_TOKEN) return c.text("Unauthorized", 401);
  await next();
}

app.post("/test-discord", async (c) => {
  await sendDiscord(c.env.DISCORD_WEBHOOK_URL, {
    content: "✅ Discord webhook works! (from Cloudflare Workers)",
  });
  return c.text("OK");
});

// body (ทุกช่องไม่บังคับ): { slot?: "midday"|"close", dryRun?: boolean, force?: boolean, symbols?: string[] }
// dryRun = ดูผลวิเคราะห์ + ข้อความที่จะส่ง โดยไม่ส่งจริงและไม่แตะ state
const runHandler = async (c: Context<{ Bindings: Env }>) => {
  const body = await c.req.json().catch(() => ({}) as any);
  const result = await runAlerts(c.env, {
    slot: body?.slot === "midday" ? "midday" : "close",
    dryRun: Boolean(body?.dryRun),
    force: Boolean(body?.force),
    symbols: Array.isArray(body?.symbols) ? body.symbols : undefined,
  });
  return c.json(result);
};
app.post("/run", runHandler);
app.post("/trigger-alerts", runHandler);

// News Radar — body: { dryRun?: bool, force?: bool, ignoreSeen?: bool, skipAi?: bool }
app.post("/news", async (c) => {
  const body = await c.req.json().catch(() => ({}) as any);
  return c.json(
    await runNewsRadar(c.env, {
      dryRun: Boolean(body?.dryRun),
      force: Boolean(body?.force),
      ignoreSeen: Boolean(body?.ignoreSeen),
      skipAi: Boolean(body?.skipAi),
    }),
  );
});

// Heat Index + ความแม่นของ AI — body: { dryRun?: bool, force?: bool, skipAi?: bool }
app.post("/weekly", async (c) => {
  const body = await c.req.json().catch(() => ({}) as any);
  return c.json(await runWeekly(c.env, { dryRun: Boolean(body?.dryRun), force: Boolean(body?.force), skipAi: Boolean(body?.skipAi) }));
});

// Discord slash commands (ตั้ง Interactions Endpoint URL ใน Discord Developer Portal เป็น https://<worker>/interactions)
app.post("/interactions", async (c) => {
  if (!c.env.DISCORD_PUBLIC_KEY) return c.text("DISCORD_PUBLIC_KEY not set", 501);
  const body = await c.req.text();
  const ok = await verifyDiscordRequest(
    body,
    c.req.header("x-signature-ed25519") ?? "",
    c.req.header("x-signature-timestamp") ?? "",
    c.env.DISCORD_PUBLIC_KEY,
  );
  if (!ok) return c.text("invalid request signature", 401);
  const { response, background } = handleInteraction(c.env, JSON.parse(body));
  if (background) c.executionCtx.waitUntil(background);
  return c.json(response);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // cron ของ News Radar (ดู wrangler.jsonc) — รัน radar ก่อน แล้วค่อยเช็กรอบรายสัปดาห์ (ใช้ KV key เดียวกัน ห้ามรันพร้อมกัน)
    if (controller.cron === NEWS_CRON) {
      ctx.waitUntil(
        runNewsRadar(env)
          .then((r) => console.log("[cron:news]", JSON.stringify(r)))
          .catch((err) => console.error("[cron:news] failed", err))
          .then(() => runWeekly(env))
          .then((r) => r.status !== "skipped" && console.log("[cron:weekly]", JSON.stringify(r)))
          .catch((err) => console.error("[cron:weekly] failed", err)),
      );
      return;
    }
    ctx.waitUntil(
      runAlerts(env)
        .then((r) => console.log("[cron]", JSON.stringify(r)))
        .catch((err) => console.error("[cron] failed", err)),
    );
  },
};
