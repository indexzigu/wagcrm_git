import { createClient } from "@/lib/supabase/server";
import { resolveAccess } from "@/lib/auth-allowlist";

export default async function PendingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const access = resolveAccess(user?.app_metadata, user?.email);
  const rejected = access.status === "rejected";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold">
          {rejected ? "접근 권한이 없습니다" : "승인을 기다리는 중입니다"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {rejected
            ? "이 계정으로는 CRM 을 이용할 수 없습니다."
            : "관리자가 계정을 승인하면 바로 이용할 수 있습니다."}
        </p>
        <p className="text-xs text-muted-foreground">{user?.email}</p>
        {/* 🪤 브리프 원안은 `<a href="/auth/signout">` 이었으나 그런 라우트가 없다 —
            실제 로그아웃 엔드포인트는 `/api/auth/signout`(POST 전용, `crm-sidebar.tsx` 와
            동일 패턴)이다. GET 링크로는 404 가 난다. */}
        <form action="/api/auth/signout" method="POST" className="inline-block">
          <button type="submit" className="text-sm underline">
            다른 계정으로 로그인
          </button>
        </form>
      </div>
    </main>
  );
}
