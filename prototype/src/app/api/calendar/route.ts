import { CALENDAR_EVENTS, CALENDAR_KIND_LABEL } from "@/lib/fixtures";

/**
 * 專題行事曆 iCal 訂閱（Roy 2026-09-09：想跟 Google 日曆連動）。
 * 不需要 OAuth：使用者在 Google 日曆「從網址新增」貼這個網址，Google 會定期抓；Apple／Outlook 也吃 .ics。
 * 系辦改活動，訂閱的人自動更新。原型讀 fixtures；正式版讀 DB。
 */
export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FJU IM//專題管理平台//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:輔大資管專題行事曆", "X-WR-TIMEZONE:Asia/Taipei",
    ...CALENDAR_EVENTS.flatMap((e) => {
      const d = e.date.replace(/-/g, "");
      return ["BEGIN:VEVENT", `UID:${e.id}@fju-im-project`, `DTSTAMP:${d}T000000Z`, `DTSTART;VALUE=DATE:${d}`, `SUMMARY:【${CALENDAR_KIND_LABEL[e.kind]}】${e.title}`, ...(e.href ? [`URL:${origin}${e.href}`] : []), "END:VEVENT"];
    }),
    "END:VCALENDAR",
  ];
  return new Response(lines.join("\r\n"), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="fju-im-project.ics"' } });
}
