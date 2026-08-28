import { getPrisma } from "./prisma";

// 알림 크론 폐지(알림센터 해체, 2026-07-24)로 남은 설정은 대시보드 일정
// 커버리지 임계(schedule-gap-briefing)뿐이다. 과거 저장된 JSON에 남아 있는
// sellerNoResponse 등 구 필드는 파싱 시 무시된다.
export interface ReminderSettings {
  scheduleThresholds: { idealDays: number; minDays: number; deadlineDays: number };
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  scheduleThresholds: { idealDays: 60, minDays: 30, deadlineDays: 21 },
};

/**
 * Retrieve reminder settings from the database.
 * Falls back to DEFAULT_REMINDER_SETTINGS if no record exists.
 */
export async function getReminderSettings(): Promise<ReminderSettings> {
  const prisma = getPrisma();
  const record = await prisma.reminderSettings.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (!record) {
    return DEFAULT_REMINDER_SETTINGS;
  }

  try {
    const parsed = JSON.parse(record.settings) as Partial<ReminderSettings>;
    return {
      scheduleThresholds: parsed.scheduleThresholds
        ? {
            ...DEFAULT_REMINDER_SETTINGS.scheduleThresholds,
            ...parsed.scheduleThresholds,
          }
        : DEFAULT_REMINDER_SETTINGS.scheduleThresholds,
    };
  } catch {
    return DEFAULT_REMINDER_SETTINGS;
  }
}

/**
 * Update reminder settings in the database.
 * Upserts the single settings record with the merged values.
 */
export async function updateReminderSettings(
  partial: Partial<ReminderSettings>
): Promise<ReminderSettings> {
  const prisma = getPrisma();
  const current = await getReminderSettings();

  const merged: ReminderSettings = {
    scheduleThresholds: partial.scheduleThresholds
      ? {
          ...current.scheduleThresholds,
          ...partial.scheduleThresholds,
        }
      : current.scheduleThresholds,
  };

  const existing = await prisma.reminderSettings.findFirst({
    orderBy: { updatedAt: "desc" },
  });

  if (existing) {
    await prisma.reminderSettings.update({
      where: { id: existing.id },
      data: { settings: JSON.stringify(merged) },
    });
  } else {
    await prisma.reminderSettings.create({
      data: { settings: JSON.stringify(merged) },
    });
  }

  return merged;
}
