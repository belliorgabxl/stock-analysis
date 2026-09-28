import { Hono, type Context, type Next } from "hono";

import { runAlerts } from "./alerts/runner";
import { sendDiscord } from "./lib/discord";
import type { Env } from "./model/config-env";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

// endpoint ด้านล่างต้องใส่ header x-trigger-token (กันคนอื่นยิง Discord/Alpaca ของเรา)
app.use("/run", auth);
app.use("/trigger-alerts", auth);
app.use("/test-discord", auth);

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

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runAlerts(env)
        .then((r) => console.log("[cron]", JSON.stringify(r)))
        .catch((err) => console.error("[cron] failed", err)),
    );
  },
};
