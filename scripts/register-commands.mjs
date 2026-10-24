/**
 * ลงทะเบียน Discord slash commands (/analyze /news /heat /review) — รันครั้งเดียว หรือเมื่อแก้รายการคำสั่ง
 *
 *   ใส่ใน .dev.vars:  DISCORD_APPLICATION_ID=...  DISCORD_BOT_TOKEN=...  (DISCORD_GUILD_ID=... ไม่บังคับ)
 *   npm run register-commands
 *
 * มี DISCORD_GUILD_ID = ลงเฉพาะเซิร์ฟเวอร์นั้น (ขึ้นทันที) · ไม่มี = global (อาจใช้เวลาถึง 1 ชม.)
 */
import fs from "node:fs";

const vars = { ...process.env };
if (fs.existsSync(".dev.vars")) {
  for (const line of fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) vars[line.slice(0, i).trim()] ??= line.slice(i + 1).trim().replace(/^"|"$/g, "");
  }
}

const appId = vars.DISCORD_APPLICATION_ID;
const token = vars.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error("ต้องมี DISCORD_APPLICATION_ID และ DISCORD_BOT_TOKEN ใน .dev.vars หรือ env");
  process.exit(1);
}

const STRING = 3;
const commands = [
  {
    name: "analyze",
    description: "วิเคราะห์หุ้นตอนนี้ (ราคา สัญญาณ ข่าว)",
    options: [{ type: STRING, name: "symbol", description: "ticker เช่น NVDA", required: true }],
  },
  {
    name: "news",
    description: "ข่าวสำคัญ 48 ชม. ล่าสุดที่ระบบคัดไว้",
    options: [{ type: STRING, name: "symbol", description: "กรองเฉพาะหุ้นตัวนี้ (ไม่ใส่ = ทั้งหมด)", required: false }],
  },
  { name: "heat", description: "Market Heat Index — ตลาด Nasdaq ร้อนแรงแค่ไหน" },
  { name: "review", description: "ระบบเตือนแม่นแค่ไหน (เทียบกับราคาจริงย้อนหลัง)" },
];

const url = vars.DISCORD_GUILD_ID
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${vars.DISCORD_GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: { "content-type": "application/json", authorization: `Bot ${token}` },
  body: JSON.stringify(commands),
});
const text = await res.text();
if (!res.ok) {
  console.error(`ลงทะเบียนไม่สำเร็จ ${res.status}: ${text}`);
  process.exit(1);
}
console.log(`ลงทะเบียน ${JSON.parse(text).length} คำสั่งแล้ว (${vars.DISCORD_GUILD_ID ? "guild" : "global"})`);
