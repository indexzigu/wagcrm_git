export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-12">
      <div>
        <p className="text-sm font-medium text-muted-foreground">WAG CRM</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          개인정보처리방침
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          본 문서는 Meta App Review와 서비스 공개 운영을 위한 초안입니다.
          실제 배포 전 회사 법무/운영 정책에 맞게 최종 검토합니다.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">수집 항목</h2>
        <p className="leading-7 text-muted-foreground">
          캠페인 운영을 위해 거래처, 셀러 SNS 핸들, 공개 팔로워 지표,
          마케팅 링크 파라미터, 전환 이벤트 및 관리자 운영 로그를 저장합니다.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">이용 목적</h2>
        <p className="leading-7 text-muted-foreground">
          공동구매 캠페인 관리, 수수료 정산, 셀러 성장 지표 추적, 마케팅
          링크 성과 분석, 외부 API 권한 검토 증빙에 한해 사용합니다.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">보관 및 삭제</h2>
        <p className="leading-7 text-muted-foreground">
          운영 목적이 종료되거나 삭제 요청이 접수되면 내부 확인 후 관련
          데이터를 삭제하거나 비식별화합니다. 삭제 요청은 운영 관리자 이메일
          또는 서비스 내 문의 채널로 접수합니다.
        </p>
      </section>
    </main>
  );
}
