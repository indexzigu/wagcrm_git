import { AccountManagementTable } from "@/components/crm/AccountManagementTable";
import { getAuthContext } from "@/lib/auth-context";

export default async function AccountsSettingsPage() {
  // 미들웨어가 이미 인증을 강제하므로 null 은 실질 도달하지 않는다(방어 코드로
  // 겹겹이 쌓지 않는다) — 다만 타입상 다뤄야 하므로, null 이면 빈 문자열을 넘겨
  // AccountManagementTable 의 "자기 행" 판정이 어떤 행에도 매칭되지 않게 한다.
  const auth = await getAuthContext();

  return (
    <div className="w-full flex-1 space-y-4">
      <div>
        <h1 className="text-lg font-semibold">계정 관리</h1>
        <p className="text-sm text-muted-foreground">
          로그인 승인과 역할을 여기서 관리합니다.
        </p>
      </div>
      <AccountManagementTable currentUserId={auth?.userId ?? ""} />
    </div>
  );
}
