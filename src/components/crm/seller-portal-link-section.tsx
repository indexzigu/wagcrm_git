"use client";

// 셀러 전용 리포트 접근 관리 — 셀러 상세 패널에 배치.
// 기본 경로는 전용 주소(crm.ygrd.kr/<셀러계정명>) + 열람 비밀번호:
//  - 주소(slug)는 셀러 계정명 기반이라 기억하기 쉽고, 공개 정보로 취급한다.
//  - 비밀은 비밀번호뿐 — 발급 시 평문이 딱 1회 표시되며 서버에는 해시만 남는다.
//  - 재발급하면 기존 비밀번호·셀러의 로그인 세션이 즉시 무효화된다.
// 과거에 공유한 토큰 링크(/p/<token>)는 계속 동작한다(레거시 표시만).
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Link2, Copy, Loader2, Check, ExternalLink, KeyRound, Pencil } from "lucide-react";

export type SellerPortalLinkSectionProps = {
  sellerId: string;
  initialToken?: string | null;
  initialSlug?: string | null;
  initialHasPassword?: boolean;
  /** 계정명(snsHandle) 기반 슬러그 제안 — 정규화 불가(한글 등)면 null */
  suggestedSlug?: string | null;
};

export function SellerPortalLinkSection({
  sellerId,
  initialToken,
  initialSlug,
  initialHasPassword,
  suggestedSlug,
}: SellerPortalLinkSectionProps) {
  const [slug, setSlug] = useState<string | null>(initialSlug ?? null);
  const [hasPassword, setHasPassword] = useState<boolean>(initialHasPassword ?? false);
  const [slugInput, setSlugInput] = useState<string>(initialSlug ?? suggestedSlug ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issuedPassword, setIssuedPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState<"url" | "pw" | "token" | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = slug ? `${origin}/${slug}` : "";
  const tokenUrl = initialToken ? `${origin}/p/${initialToken}` : "";

  async function post(body: Record<string, unknown>): Promise<{ slug: string | null; hasPassword: boolean; password: string | null } | null> {
    setBusy(true);
    try {
      const res = await fetch(`/api/sellers/${sellerId}/portal-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `요청 실패 (${res.status})`);
      return data;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "요청에 실패했습니다.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  // 최초 설정: 주소 저장 + 비밀번호 발급을 한 번에. 주소 변경: slug만.
  async function saveSlug() {
    const value = slugInput.trim().toLowerCase();
    if (!value) return;
    const firstSetup = !slug && !hasPassword;
    const data = await post(firstSetup ? { slug: value, generatePassword: true } : { slug: value });
    if (!data) return;
    setSlug(data.slug);
    setHasPassword(data.hasPassword);
    setEditing(false);
    if (data.password) {
      setIssuedPassword(data.password);
      toast.success("전용 주소와 비밀번호를 발급했습니다. 비밀번호는 지금만 표시됩니다.");
    } else {
      toast.success("전용 주소를 저장했습니다.");
    }
  }

  async function rotatePassword() {
    if (
      hasPassword &&
      !window.confirm("비밀번호를 재발급할까요? 기존 비밀번호와 셀러의 로그인 상태가 즉시 무효화됩니다.")
    ) {
      return;
    }
    const data = await post({ generatePassword: true });
    if (!data) return;
    setHasPassword(true);
    setIssuedPassword(data.password);
    toast.success("비밀번호를 발급했습니다. 지금만 표시되니 셀러에게 바로 전달하세요.");
  }

  async function copy(text: string, kind: "url" | "pw" | "token") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      toast.success("복사했습니다. 카톡 등으로 셀러에게 전달하세요.");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error("복사에 실패했습니다. 직접 선택해 복사해주세요.");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-card p-4">
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-[13px] font-semibold text-foreground">셀러 전용 리포트 링크</h3>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        셀러 계정명으로 된 전용 주소입니다. 셀러는 비밀번호를 입력해 자신의 모든 캠페인 판매 현황과
        이력을 확인합니다. 내부 마진·정산·구매자 정보는 노출되지 않습니다.
      </p>

      {slug && !editing ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-focus-ring"
            />
            <Button type="button" size="sm" variant="secondary" onClick={() => copy(url, "url")} className="h-8 shrink-0 gap-1.5">
              {copied === "url" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              복사
            </Button>
            {/* 관리자도 셀러가 보는 화면을 그대로 확인 — CRM 로그인 세션이면 비밀번호 없이 열린다 */}
            <Button asChild size="sm" variant="secondary" className="h-8 shrink-0 gap-1.5">
              <a href={url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                열기
              </a>
            </Button>
          </div>

          {issuedPassword && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold text-amber-700">
                    열람 비밀번호: 지금만 표시됩니다
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-bold tracking-wider text-amber-900">
                    {issuedPassword}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => copy(issuedPassword, "pw")}
                  className="h-8 shrink-0 gap-1.5"
                >
                  {copied === "pw" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  복사
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={rotatePassword}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
              {hasPassword ? "비밀번호 재발급 (기존 무효화)" : "비밀번호 발급 (필수)"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSlugInput(slug);
                setEditing(true);
              }}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <Pencil className="h-3 w-3" />
              주소 변경
            </button>
          </div>
          {!hasPassword && (
            <p className="text-[11px] font-medium text-amber-600">
              비밀번호가 아직 없어 셀러가 열람할 수 없습니다. 발급 후 주소와 함께 전달하세요.
            </p>
          )}
        </div>
      ) : !editing ? (
        // 미설정 상태 — 입력창은 설정을 시작할 때만 연다(패널 노이즈·오입력 방지)
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => {
            setSlugInput(suggestedSlug ?? "");
            setEditing(true);
          }}
          className="gap-1.5"
        >
          <Link2 className="h-3.5 w-3.5" />
          전용 주소 만들기
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{origin ? `${origin}/` : "/"}</span>
            <input
              value={slugInput}
              onChange={(e) => setSlugInput(e.target.value)}
              placeholder="셀러 계정명 (예: gaon)"
              className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none focus:ring-1 focus:ring-focus-ring"
            />
            <Button
              type="button"
              size="sm"
              disabled={busy || !slugInput.trim()}
              onClick={saveSlug}
              className="h-8 shrink-0 gap-1.5"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              {slug ? "주소 저장" : "주소 만들기"}
            </Button>
            {editing && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} className="h-8 shrink-0">
                취소
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            소문자 영문/숫자로 시작, 3~31자 (._- 사용 가능).
            {!slug && " 주소를 만들면 열람 비밀번호도 함께 발급됩니다."}
          </p>
        </div>
      )}

      {initialToken && (
        <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2.5">
          <p className="min-w-0 truncate text-[10px] text-muted-foreground">
            기존 토큰 링크도 계속 동작합니다: <span className="font-mono">{tokenUrl}</span>
          </p>
          <button
            type="button"
            onClick={() => copy(tokenUrl, "token")}
            className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {copied === "token" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            복사
          </button>
        </div>
      )}
    </div>
  );
}
