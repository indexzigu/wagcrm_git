import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, requireRole } from "@/lib/api-auth";
import {
  ORDER_AUTO_SYNC_INTERVAL_OPTIONS,
  getOrderAutoSyncIntervalHours,
  isOrderAutoSyncInterval,
  setOrderAutoSyncIntervalHours,
  type OrderAutoSyncIntervalHours,
} from "@/lib/order-converter/order-auto-sync";

// 주문관리 화면 진입 시 자동 동기화 간격(1·3·6시간). 허용값·판정 SSOT는 order-auto-sync.ts.
const patchSchema = z.object({
  intervalHours: z.custom<OrderAutoSyncIntervalHours>(isOrderAutoSyncInterval, {
    message: `intervalHours must be one of ${ORDER_AUTO_SYNC_INTERVAL_OPTIONS.join(", ")}`,
  }),
});

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const intervalHours = await getOrderAutoSyncIntervalHours();
    return NextResponse.json({
      intervalHours,
      options: ORDER_AUTO_SYNC_INTERVAL_OPTIONS,
      canEdit: auth.context.role === "admin",
    });
  } catch (error) {
    console.error("[settings/order-sync] GET error:", error);
    return NextResponse.json({ error: "Failed to load order sync settings" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  try {
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const intervalHours = await setOrderAutoSyncIntervalHours(parsed.data.intervalHours);
    return NextResponse.json({ intervalHours });
  } catch (error) {
    console.error("[settings/order-sync] PATCH error:", error);
    return NextResponse.json({ error: "Failed to update order sync settings" }, { status: 500 });
  }
}
