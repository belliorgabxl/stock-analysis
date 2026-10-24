# stock-alert-worker

Cloudflare Worker แจ้งเตือนหุ้น US เข้า Discord — **เฉพาะเมื่อมีความเคลื่อนไหวที่มีนัยยะจริง**: สัญญาณราคา (ไม่เกินวันละ 2 ข้อความ), ข่าวที่อาจทำให้ราคาขยับแรง, สรุปข่าวรายวัน และ Market Heat Index รายสัปดาห์

## ทำงานยังไง

รันวันทำการละ 2 รอบ (ปรับตาม DST อัตโนมัติ):

| รอบ | เวลา ET | เวลาไทย (โดยประมาณ) | ดูอะไร |
|---|---|---|---|
| `midday` | 12:00 | 23:00 / 00:00 | ขยับแรง, แนวโน้ม 5 วัน, วอลุ่มผิดปกติ, เป้าราคา |
| `close` | 16:20 | 03:20 / 04:20 | ทั้งหมด + New High/Low 52 สัปดาห์, ตัด SMA200 |

แต่ละรอบรวมเป็น **ข้อความเดียว** (หนึ่ง embed ต่อหุ้น พร้อม RSI/SMA/ข่าวล่าสุด) และ **ไม่ส่งอะไรเลย** ถ้าไม่มีสัญญาณ

### สัญญาณ

- **ขยับแรงผิดปกติ** — วัดเป็น σ ของความผันผวนปกติของหุ้นตัวนั้นเอง (NVDA ขยับ 6% กับ BURU ขยับ 6% ไม่เท่ากัน) ต้อง ≥ `MOVE_Z` σ และ ≥ `MIN_MOVE_PCT` %
- **แนวโน้ม 5 วัน** — ไหลลง/ขึ้นสะสมแรง (ที่ไม่ได้มาจากวันนี้วันเดียว)
- **วอลุ่มผิดปกติ** — ≥ 3 เท่าของค่าเฉลี่ย 20 วัน พร้อมราคาขยับจริง
- **New High / New Low 52 สัปดาห์** (ราคาปิด)
- **ตัด SMA200** — ต้องอยู่อีกฝั่งมา 10 วันแล้วทะลุชัดเจน (กันเลียเส้น)
- **เป้าราคา** (`PRICE_LEVELS`) — เตือนตอนราคา *เคลื่อนเข้า* โซน มี hysteresis ตามความผันผวน กันแกว่งรอบเป้าแล้วเตือนรัว

### AI ผู้ช่วยวิเคราะห์ (Claude)

ถ้าตั้ง secret `ANTHROPIC_API_KEY` ไว้ ทุกรอบที่มีสัญญาณระบบจะเรียก Claude **1 ครั้ง** ให้:

- อธิบายว่าหุ้นขยับเพราะอะไร (จากข่าวล่าสุด + การขยับของหุ้นตัวอื่นใน watchlist)
- จัดประเภทปัจจัย (ข่าวบริษัท / งบ / ตามกลุ่ม / ตามตลาด / เทคนิค / ไม่ชัดเจน)
- ให้คะแนนความสำคัญ ★1–5 และบอกสิ่งที่ควรจับตาต่อ

ถ้าไม่มี key หรือเรียก AI ไม่สำเร็จ การแจ้งเตือนยังทำงานตามปกติ

ระบบเก็บการประเมินของ AI ไว้ใน state (`aiLog`, 300 รายการล่าสุด) เพื่อเอาไปเทียบกับราคาจริงภายหลัง
เมื่อมั่นใจแล้วค่อยตั้ง `AI_MIN_IMPORTANCE=2` ให้ AI ช่วยตัดสัญญาณที่เป็น noise ทิ้ง

### กันเตือนซ้ำ

- สัญญาณเดียวกันเตือนวันละครั้ง (รอบปิดตลาดจะเตือนซ้ำเฉพาะถ้ารุนแรงขึ้นมาก)
- New High/Low, SMA200: เว้น 20 วัน · แนวโน้ม 5 วัน: เว้น 5 วัน · เป้าราคา: เว้น 3 วัน
- วันหยุดตลาด US ข้ามอัตโนมัติ
- state ทั้งหมดอยู่ใน KV key เดียว (`state:v2`) เขียนแค่ ~2 ครั้ง/วัน

## 📡 News Radar — เตือนจากข่าว ก่อน/ระหว่างที่ราคาขยับ

การแจ้งเตือนราคาด้านบนจะดูข่าว *หลัง* ราคาขยับแล้ว ส่วน News Radar คอยสแกนข่าวใหม่ **ทุก 30 นาที** (จ-ศ 04:00–20:59 ET = pre-market ถึง after-hours, นอกเวลานั้นทุก 3 ชม.)

| แหล่ง | ได้อะไร |
|---|---|
| Alpaca News (Benzinga ฯลฯ) | ข่าวบริษัทของ `WATCHLIST` + `NEWS_EXTRA_SYMBOLS` |
| SEC EDGAR | 8-K (งบ, ดีล, ผู้บริหารลาออก, ถูกเตือน delisting), S-1/S-3/424B (**ออกหุ้นเพิ่ม**), NT 10-Q (ส่งงบช้า), 13D/G — ต้องตั้ง `SEC_USER_AGENT` |
| RSS: CNBC (Investing/Tech/Economy/Finance), MarketWatch | ข่าวมหภาค เช่น Fed, เงินเฟ้อ, ภาพรวมกลุ่ม AI/ชิป |

ทุกรอบที่มีข่าวใหม่ ระบบจะให้คะแนนทุกข่าว: ทิศทาง (บวก/ลบ/ผสม), ผลกระทบ ★1–5, ความมั่นใจ, กรอบเวลา, ประเภท (งบ, dilution, M&A, กฎหมาย ฯลฯ), เป็นข่าว hype ไหม, ซ้ำกับที่เตือนไปแล้วไหม

**ค่าเริ่มต้น: คัดด้วยกฎคีย์เวิร์ด (ฟรี ไม่ใช้ AI)** — ดู [src/news/rules.ts](src/news/rules.ts)
- คีย์เวิร์ดใน **พาดหัว** = มั่นใจกลาง (เตือนได้) · เจอแค่ในสรุปข่าว = มั่นใจต่ำ (เข้าสรุปรายวันเท่านั้น)
- ตัวอย่าง: `registered direct offering` → ลบ ★4 (dilution) · `beats estimates` / `raises guidance` → บวก ★4 · `nasdaq notice` / `minimum bid` → ลบ ★4 · `to be acquired` → บวก ★5 · `upgrades … to buy` → บวก ★3
- เอกสาร SEC: 424B5/S-1 → ★4 dilution · NT 10-Q → ★4 · 8-K ให้คะแนนตาม Item (3.01 delisting ★4, 4.02 แก้งบ ★5, 2.02 ประกาศงบ ★3 ฯลฯ)
- ลดคะแนนอัตโนมัติ: บทความความเห็น ("Should you buy…?", "3 stocks to…", "Here’s why"), สำนักงานกฎหมายชวนฟ้อง
- ข่าวมหภาคสูงสุด ★3 (เข้าสรุปรายวัน + Heat Index ไม่เตือนทันที)
- ข้อจำกัด: ไม่เข้าใจบริบท เช่น "loss narrower than feared" อาจถูกตีความผิด และคำอธิบายเป็นข้อความสำเร็จรูป

ถ้าวันหน้าตั้ง `ANTHROPIC_API_KEY` ระบบจะใช้ Claude คัดข่าวแทนกฎอัตโนมัติ (มีค่าใช้จ่าย API แยกจากแพ็กเกจ Claude รายเดือน)

- **เตือนทันที** เมื่อผลกระทบ ≥ `NEWS_MIN_IMPACT` (ค่าเริ่มต้น 4) และมั่นใจระดับกลางขึ้นไป — พร้อมราคาตอนนั้นว่าข่าวถูกสะท้อนไปแล้วหรือยัง
- **สรุปรายวัน** ~20:05 ET (ข่าว ★3 ขึ้นไป + อารมณ์ข่าวของวัน บวก/ลบ/hype)
- ไม่ต้องตั้งค่าอะไรเพิ่ม ใช้ได้ทันทีหลัง deploy
- state แยกอยู่ที่ KV key `news:v1` เขียนครั้งเดียวต่อรอบ (~40 ครั้ง/วัน)

> คะแนนมาจากคีย์เวิร์ด ไม่ได้อ่านข่าวเต็ม และไม่ใช่คำแนะนำการลงทุน — ดูความแม่นจริงได้จากรายงานรายสัปดาห์ด้านล่าง · อยากได้เตือนมากขึ้นตั้ง `NEWS_MIN_IMPACT=3`

## 🌡️ Market Heat Index + 🎯 AI แม่นแค่ไหน (ทุกเช้าวันเสาร์)

**Heat Index 0–100** = ตลาด Nasdaq "ร้อน" แค่ไหน จากข้อมูลที่วัดได้จริง (ไม่ใช่ % ความน่าจะเป็นที่ฟองสบู่จะแตก — ตัวเลขแบบนั้นที่ AI แต่งขึ้นจากข่าวจะดูน่าเชื่อแต่ไม่มีอะไรรองรับ)

| ส่วนประกอบ | น้ำหนัก | วัดจาก |
|---|---|---|
| แนวโน้ม | 25% | QQQ ห่างจาก SMA200 (−5% → 0, +20% → 100) |
| โมเมนตัม | 15% | RSI14 ของ QQQ (30 → 0, 80 → 100) |
| Breadth | 20% | % หุ้นใหญ่ใน `HEAT_BASKET` (50 ตัว) ที่ยืนเหนือ SMA50 |
| ความชะล่าใจ | 20% | ความผันผวน 20 วันต่ำแค่ไหนเทียบกับรอบปี |
| ข่าว | 20% | สัดส่วนข่าวบวก + ข่าวเชิง hype 7 วัน (จาก News Radar) |

พร้อมคำเตือนเชิงโครงสร้าง เช่น ดัชนีใกล้จุดสูงสุดแต่ breadth แคบ, ราคายืดห่าง SMA200 มาก, ผันผวนต่ำผิดปกติขณะราคาสูง, ข่าว hype เกิน 15% · <30 เย็น · 30–50 ปกติ · 50–70 อุ่น · 70–85 ร้อน · 85+ ร้อนจัด

**AI แม่นแค่ไหน** — เอา `aiLog` (การแจ้งเตือนราคา) และ log ของ News Radar ย้อนหลัง 90 วัน มาเทียบกับราคาจริง 1 และ 5 วันทำการหลังจากนั้น:
- แจ้งเตือนราคาแยกตาม ★ ของ AI: ★4-5 ควรขยับแรงกว่า/ไปต่อบ่อยกว่า ★1-2 — ถ้าใช่ ค่อยตั้ง `AI_MIN_IMPORTANCE=2`
- News Radar: % ที่ราคาไปตามทิศที่ AI ทาย (50% = เดาสุ่ม) และผลตอบแทนเฉลี่ยถ้าทำตาม

## 💬 Discord slash commands

| คำสั่ง | |
|---|---|
| `/analyze NVDA` | วิเคราะห์หุ้นตอนนี้: ราคา, RSI/SMA, สัญญาณ, ข่าว + AI อธิบาย |
| `/news [symbol]` | ข่าวสำคัญ 48 ชม. ที่ Radar คัดไว้ |
| `/heat` | Heat Index ตอนนี้ |
| `/review` | AI แม่นแค่ไหน |

ตั้งค่า (ครั้งเดียว):
1. https://discord.com/developers/applications → New Application → คัดลอก **Application ID** และ **Public Key**
2. แท็บ Bot → Reset Token → คัดลอก **Bot Token** · แท็บ Installation → Install Link → เพิ่มเข้าเซิร์ฟเวอร์ (scope `applications.commands`)
3. ใส่ `DISCORD_PUBLIC_KEY` ใน `wrangler.jsonc` แล้ว `npm run deploy`
4. แท็บ General Information → **Interactions Endpoint URL** = `https://<worker>/interactions` → Save (Discord จะยิงทดสอบ ต้อง deploy ก่อน)
5. ใส่ `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN` (และ `DISCORD_GUILD_ID` ถ้าอยากให้ขึ้นทันที) ใน `.dev.vars` แล้ว `npm run register-commands`
6. แนะนำ: ตั้ง `DISCORD_ALLOWED_USER_IDS` = user id ของคุณ กันคนอื่นใช้ AI ของเรา

## ตั้งค่า

`wrangler.jsonc` → `vars`:

| ตัวแปร | ค่าเริ่มต้น | |
|---|---|---|
| `WATCHLIST` | | `NVDA,RKLB,...` |
| `PRICE_LEVELS` | | `NVDA:below=165,above=200;RKLB:below=50` |
| `ALERT_SLOTS` | `midday,close` | ใส่ `close` ถ้าอยากได้วันละครั้ง |
| `MOVE_Z` | `2.5` | สูง = เตือนน้อยลง |
| `MIN_MOVE_PCT` | `3` | |
| `TREND_Z`, `MIN_TREND_PCT`, `VOLUME_RATIO` | `2.5`, `10`, `3` | |
| `ALPACA_FEED` | `sip` | `iex` ถ้าต้องการข้อมูล real-time (แต่แม่นน้อยกว่า) |
| `AI_MODEL` | `claude-opus-5-5` | |
| `AI_MIN_IMPORTANCE` | `0` | `0` = AI แค่อธิบาย, `2` = ตัด ★1 ทิ้ง |
| `NEWS_RADAR` | | `off` = ปิด News Radar |
| `NEWS_MIN_IMPACT` | `4` | เตือนข่าวทันทีเมื่อ ★ ≥ ค่านี้ |
| `NEWS_EXTRA_SYMBOLS` | | ติดตามข่าวเพิ่ม (ไม่คำนวณสัญญาณราคา) |
| `NEWS_AI_MODEL` | = `AI_MODEL` | `claude-haiku-5-5` ถูกกว่ามากสำหรับงานคัดข่าว |
| `NEWS_RSS_FEEDS` | CNBC ×4 + MarketWatch | URL คั่นด้วย `,` |
| `SEC_USER_AGENT` | | `"MyStockBot you@example.com"` (SEC บังคับ) — ไม่ใส่ = ข้าม SEC |
| `HEAT_BASKET` | หุ้นใหญ่ Nasdaq 50 ตัว | ใช้วัด breadth |
| `DISCORD_PUBLIC_KEY` | | เปิด slash commands |
| `DISCORD_ALLOWED_USER_IDS` | | จำกัดคนใช้คำสั่ง |

Secrets (`wrangler secret put ...` / `.dev.vars` ตอน dev): `DISCORD_WEBHOOK_URL`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `TRIGGER_TOKEN`, `ANTHROPIC_API_KEY` (ไม่บังคับ), `DISCORD_NEWS_WEBHOOK_URL` (ไม่บังคับ: แยกห้องข่าว)

## ใช้งาน

```sh
npm install
npm run typecheck
npm run backtest                  # จำลองย้อนหลัง 250 วันทำการ: เตือนกี่ครั้ง เรื่องอะไร
npm run backtest -- --verbose     # แสดงทุกการแจ้งเตือน
BT_MOVE_Z=3 npm run backtest      # ลองค่าอื่นก่อนแก้ config
npm run news:dry                  # ทดสอบ News Radar + Heat Index กับข้อมูลจริง (ไม่ส่ง Discord)
npm run dev
npm run deploy
```

Endpoints (ต้องใส่ header `x-trigger-token`):

```sh
# ดูผลวิเคราะห์ + ข้อความที่จะส่ง (ไม่ส่งจริง ไม่แตะ state)
curl -X POST https://<worker>/run -H "x-trigger-token: $TOKEN" -d '{"dryRun":true}'
# body: { "slot": "midday"|"close", "dryRun": bool, "force": bool, "symbols": ["NVDA"] }

curl -X POST https://<worker>/test-discord -H "x-trigger-token: $TOKEN"

# News Radar: ดูว่าจะเตือนข่าวอะไร (ignoreSeen = รวมข่าวที่เคยเห็นแล้ว)
curl -X POST https://<worker>/news -H "x-trigger-token: $TOKEN" -d '{"dryRun":true,"ignoreSeen":true}'

# Heat Index + ความแม่นของ AI (force = ส่ง Discord ตอนนี้เลย)
curl -X POST https://<worker>/weekly -H "x-trigger-token: $TOKEN" -d '{"dryRun":true}'
```
