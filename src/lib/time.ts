// ตลาดหุ้น US อิงเวลา New York เสมอ (รองรับ DST อัตโนมัติผ่าน Intl)
const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export type EtParts = { date: string; hour: number; minute: number };

export function etParts(d: Date): EtParts {
  const p: Record<string, string> = {};
  for (const { type, value } of ET_FORMAT.formatToParts(d)) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

export type Slot = "midday" | "close";

// cron ยิง 2 ครั้งต่อ slot (เวลา UTC ของฤดูร้อน/ฤดูหนาว) — เลือกเฉพาะครั้งที่ตรงเวลา ET จริง
export function slotForTime(et: EtParts): Slot | null {
  if (et.hour === 12) return "midday";
  if (et.hour === 16) return "close";
  return null;
}

// สัดส่วนวอลุ่มสะสมโดยประมาณของวัน (วอลุ่มหุ้น US เป็นรูปตัว U: หนาช่วงเปิด/ปิด)
const CUM_VOLUME_CURVE: Array<[number, number]> = [
  [0, 0],
  [30, 0.12],
  [60, 0.2],
  [120, 0.33],
  [180, 0.45],
  [240, 0.56],
  [300, 0.67],
  [360, 0.82],
  [390, 1],
];

export function sessionVolumeFraction(dataTime: Date): number {
  const et = etParts(dataTime);
  const minutes = et.hour * 60 + et.minute - (9 * 60 + 30);
  if (minutes <= 0) return 0;
  if (minutes >= 390) return 1;
  for (let i = 1; i < CUM_VOLUME_CURVE.length; i++) {
    const [m1, f1] = CUM_VOLUME_CURVE[i];
    if (minutes <= m1) {
      const [m0, f0] = CUM_VOLUME_CURVE[i - 1];
      return f0 + ((minutes - m0) / (m1 - m0)) * (f1 - f0);
    }
  }
  return 1;
}

export function daysBetween(a: number, b: number): number {
  return Math.abs(b - a) / 86_400_000;
}
