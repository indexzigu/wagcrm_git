"use server";

// 스토리 스냅샷 분류 — /admin/stories 전용.
//
// ⛔ **"경로가 미들웨어 게이트 안이라 안전하다"는 전제는 Server Action 에 적용되지 않는다.**
// Server Action 은 경로가 아니라 **액션 ID 로 디스패치**되므로, 허용된 경로(예: operator 의
// `/assets/katalk`)로 `Next-Action: <id>` POST 를 보내면 Next 가 그 액션을 가진 워커로
// 넘긴다(`selectWorkerForForwarding`). 액션 ID 는 `/_next/static/*` 번들에서 얻을 수 있고
// 그 경로는 proxy matcher 제외라 누구나 받는다. 현재 Next 16 은 포워딩을 자기 오리진
// fetch 로 해서 미들웨어에 재진입하지만, 그건 문서화되지 않은 내부 구현이다 — 경계를
// 남의 구현에 걸어두지 말고 여기서 직접 판정한다(역할 게이트 리뷰 지적 2026-08-06).
import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { getAuthContext } from "@/lib/auth-context";

export async function classifyStory(id: string, classification: "CAMPAIGN" | "OTHER" | "UNREVIEWED") {
  const auth = await getAuthContext();
  if (auth?.role !== "admin") {
    throw new Error("Forbidden");
  }

  await getPrisma().sellerStorySnapshot.update({
    where: { id },
    data: {
      classification,
      classifiedAt: classification === "UNREVIEWED" ? null : new Date(),
    },
  });
  revalidatePath("/admin/stories");
}
