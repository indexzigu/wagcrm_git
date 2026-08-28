import Foundation

/// 경로·명칭 상수. ⚠️ 383 논의(프리뷰 → 개발서버 대체)가 결론 나면 laneScript·
/// laneName 만 바꾼다 — 다른 파일에 스크립트 경로를 적지 말 것.
enum Config {
    static let home = FileManager.default.homeDirectoryForCurrentUser.path
    /// 상태 판정 SSOT (읽기 전용) — 프로덕션 체크아웃의 사본을 쓴다.
    static let statusScript = home + "/selfhost/wagcrm/infra/selfhost/status.sh"
    /// 리소스 계측 SSOT (읽기 전용, status.sh 의 자매 — 설계 개정 2).
    static let metricsScript = home + "/selfhost/wagcrm/infra/selfhost/metrics.sh"
    /// 개발 서버(주 레인) 제어 — 383 논의로 확정(프리뷰는 부기능). 포트 3002.
    static let devScript = home + "/selfhost/wagcrm/infra/selfhost/dev.sh"
    static let devName = "개발 서버"
    static let devUpEta = "약 30초"
    /// 프리뷰(부 레인) 제어 — up 이 체크아웃을 움직이므로 프리뷰 체크아웃의 사본.
    static let laneScript = home + "/selfhost/wagcrm-preview/infra/selfhost/preview.sh"
    static let laneName = "프리뷰 서버"
    static let laneUpEta = "약 3분"
    static let fastPollSeconds: TimeInterval = 30
    static let fullPollSeconds: TimeInterval = 300
    /// 릴리스 판정 SSOT (읽기 전용) — 배포 대기·열린 PR.
    static let releaseStatusScript = home + "/selfhost/wagcrm/infra/selfhost/release-status.sh"
    /// 배포 실행 — CRM(deploy.sh) → 조건부 링크 서버(wrangler). 순서·경로는 스크립트가 소유한다.
    static let releaseDeployScript = home + "/selfhost/wagcrm/infra/selfhost/release-deploy.sh"
    /// ⚠️ 미측정 추정치 — 첫 실제 배포 때 `time` 으로 재어 교체할 것.
    static let releaseDeployEta = "약 5분"
    /// 기본 30초·레인 900초로는 배포가 중간에 terminate 된다(npm install + Next 빌드).
    static let releaseDeployTimeout: TimeInterval = 1800
    /// gh 는 네트워크 왕복이라 30초 폴링에 태우지 않는다 — 300초 + 패널 열 때.
    /// 연달아 열면 그때마다 치게 되므로 최소 간격을 둔다.
    static let releaseMinIntervalSeconds: TimeInterval = 60
    /// 외부 채널 발송 — 텔레그램. 발송·소음 억제는 전부 스크립트가 소유한다
    /// (설계 정본 docs/private/specs/2026-08-19-external-alert-channel-design.md).
    static let notifyScript = home + "/selfhost/wagcrm/infra/selfhost/notify.sh"
    /// 생존 신고 — 맥 밖 dead-man 감시자에게. ⛔ launchd 로 옮기지 말 것(계약).
    static let heartbeatScript = home + "/selfhost/wagcrm/infra/selfhost/heartbeat.sh"
    /// 일일 요약("지금 빨강인 것")을 보내는 시각(로컬 24시간제). 전환 알림은 지금처럼
    /// 즉시 나가고, 이 시각은 **그것을 놓쳤을 때의 두 번째 기회**다(오너 확정 09시 —
    /// 밤중 알림을 피하면서 자정 무렵 도는 크론의 실패를 그날 아침에 잡는다).
    /// 설계 정본: docs/private/specs/2026-08-25-daily-red-digest-design.md
    static let digestHour = 9
}
