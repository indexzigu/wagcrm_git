import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthContext } from "@/lib/auth-context";
import { planMutation, type MutationRequest } from "@/lib/account-mutation";
import { getCrmAccounts, resetUserCache } from "@/lib/user-registry";

function adminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const auth = await getAuthContext();
  if (!auth || auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = await params;

  try {
    const body = (await request.json()) as MutationRequest;
    const supabase = adminClient();

    const { data: targetData, error: targetError } = await supabase.auth.admin.getUserById(userId);
    if (targetError || !targetData?.user) {
      return NextResponse.json({ error: "대상 계정을 찾을 수 없습니다" }, { status: 404 });
    }

    const verdict = planMutation({
      request: body,
      targetEmail: targetData.user.email ?? "",
      targetId: userId,
      actorEmail: auth.email,
      actorId: auth.userId,
      nowIso: new Date().toISOString(),
    });

    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.reason }, { status: 400 });
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: verdict.metadata,
    });
    if (updateError) {
      throw new Error(updateError.message);
    }

    // 자동완성이 쓰는 60초 캐시를 즉시 무효화한다 — 안 하면 변경된 역할이 한동안
    // 옛 값으로 보인다.
    resetUserCache();

    const accounts = await getCrmAccounts();
    const account = accounts.find((item) => item.id === userId);
    // 갱신은 성공했는데 재조회 목록에 없다 — 조용한 200 으로 넘기면 화면이 `undefined` 를
    // 받아 표 정렬(`STATUS_ORDER[a.status]`)에서 크래시한다. 에러를 삼키지 않는다(P0).
    if (!account) {
      throw new Error("권한은 변경했으나 갱신된 계정을 다시 찾지 못했습니다");
    }
    return NextResponse.json({ account });
  } catch (error) {
    console.error("[api/settings/accounts/[userId]] PATCH Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "권한 변경에 실패했습니다" },
      { status: 500 },
    );
  }
}
