import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth-context";
import { getCrmAccounts } from "@/lib/user-registry";

export async function GET() {
  // 역할 집행은 미들웨어가 이미 했다. 여기서는 확정된 결과를 읽어 admin 만 통과시킨다
  // (인증 로직을 다시 짜는 것이 아니다).
  const auth = await getAuthContext();
  if (!auth || auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const accounts = await getCrmAccounts();
    return NextResponse.json({ accounts });
  } catch (error) {
    console.error("[api/settings/accounts] GET Error:", error);
    // 원인을 화면까지 전달한다 — service_role 키 미설정을 "계정 0건" 으로 위장하지 않는다.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "계정 목록을 불러오지 못했습니다" },
      { status: 500 },
    );
  }
}
