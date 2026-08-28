import { NextResponse } from "next/server";
import { z } from "zod";
import { getReminderSettings, updateReminderSettings } from "@/lib/reminder-settings";

export async function GET() {
  try {
    const settings = await getReminderSettings();
    return NextResponse.json(settings);
  } catch (error) {
    console.error("[settings/reminders] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load reminder settings" },
      { status: 500 },
    );
  }
}

// 알림 크론 폐지(알림센터 해체, 2026-07-24)로 남은 설정은 일정 커버리지 임계뿐.
// ⚠️ 종전 스키마에는 scheduleThresholds가 아예 빠져 있어 zod가 조용히 스트립
// → "일정 확보 기준일 저장"이 성공 토스트를 띄우고도 실제로는 아무것도 저장하지
// 않는 선재 버그가 있었다. 이 재작성이 그 결함의 수정이기도 하다.
const patchSchema = z.object({
  scheduleThresholds: z
    .object({
      idealDays: z.number().int().positive(),
      minDays: z.number().int().positive(),
      deadlineDays: z.number().int().positive(),
    })
    .optional(),
});

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const parsed = patchSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const updated = await updateReminderSettings(parsed.data);
    return NextResponse.json(updated);
  } catch (error) {
    console.error("[settings/reminders] PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update reminder settings" },
      { status: 500 },
    );
  }
}
