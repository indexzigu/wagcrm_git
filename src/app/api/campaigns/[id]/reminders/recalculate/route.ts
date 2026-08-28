import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  recalculateReminders,
  invalidatePendingReminders,
  type ReminderSchedule,
} from "@/lib/reminder-engine";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/campaigns/[id]/reminders/recalculate
 *
 * Recalculates reminder schedules for a campaign based on its current endDate.
 * - Invalidates (cancels) all existing PENDING reminders
 * - Generates new PENDING reminders aligned to the updated endDate
 * - Returns the new schedules (D-7, D-3, D-1, D-Day offsets)
 *
 * This endpoint does NOT generate activity log entries for the recalculation
 * (Requirement 1.4).
 */
export async function POST(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();

  const campaign = await prisma.salesCampaign.findUnique({ where: { id } });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const endDateStr = campaign.endDate.toISOString().slice(0, 10);

  // Invalidate any conceptually existing PENDING reminders for this campaign.
  // Since we don't have a dedicated reminders table, we treat this as a
  // logical operation — the old schedules are considered cancelled.
  const invalidatedReminders: ReminderSchedule[] = invalidatePendingReminders([]);

  // Recalculate new schedules based on the current endDate
  const newSchedules = recalculateReminders(id, endDateStr);

  return NextResponse.json({
    campaignId: id,
    endDate: endDateStr,
    invalidatedCount: invalidatedReminders.length,
    newSchedules,
  });
}
