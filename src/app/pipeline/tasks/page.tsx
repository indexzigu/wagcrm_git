import { redirect } from "next/navigation";

/**
 * 「업무 처리」 별도 입구는 폐기됐다 — 같은 데이터·컴포넌트를 모바일 뷰 모드만 달리해
 * 렌더하던 중복 입구였고(그 모드 prop 은 소비처가 없었다), 입구는 `/pipeline` 하나다.
 * 북마크·옛 링크를 위해 파일은 남기고 본문만 리다이렉트한다.
 */
export default function PipelineTasksPage() {
  redirect("/pipeline");
}
