import Foundation

/// status.sh 의 JSON 출력(계약: scripts/__tests__/menubar-status.test.ts)을
/// 그대로 디코드한다 — 판정·문구는 전부 스크립트 쪽에 있고 앱은 표시만 한다.
struct StatusPayload: Decodable {
    let schemaVersion: Int
    let mode: String
    let items: [StatusItem]
}

struct StatusItem: Decodable, Identifiable, Equatable {
    let key: String
    let level: String   // ok | warn | error | info | unknown
    let title: String
    let detail: String
    let state: String?  // preview 전용: up | down
    var id: String { key }
}

/// 패널 표시 순서(status.sh 출력 순서에 의존하지 않는다).
/// actionsQuota 는 disk 와 같은 「남은 자원」 계열이라 끝에 붙인다. 둘 다 알림 없이
/// 화면 색으로만 알리는 항목이다(오너 결정 — ServerStore.watched 주석 참고).
/// preflightRunner 는 「남은 자원」이 아니라 가용성 판정이라 그 앞에 둔다 — 이 행이
/// 빨강이면 결과가 「모든 PR 머지 불가」라 disk·actionsQuota 보다 먼저 읽혀야 한다.
let displayOrder = ["prodLocal", "prodExternal", "db", "backupDaily", "backupWeekly", "crons", "alertDelivery", "preflightRunner", "disk", "actionsQuota"]

/// metrics.sh 의 JSON 출력(계약: scripts/__tests__/menubar-metrics.test.ts) —
/// 측정·판정은 스크립트가 소유하고 앱은 파싱·차분·그리기만 한다(설계 개정 2).
struct MetricsPayload: Decodable {
    let schemaVersion: Int
    let cores: Int
    let crm: TargetMetrics
    let db: TargetMetrics
    let dbData: DataFootprint
}

struct TargetMetrics: Decodable {
    let available: Bool
    /// 기계 전체 대비 정규화된 CPU%(0~100) — 정규화는 스크립트 소관.
    let cpuPct: Double?
    let cpuLevel: String?  // ok | warn | error — 판정도 스크립트 소관
    let memBytes: Double?
    /// 누적 송수신 바이트 — 속도 환산은 앱 링버퍼(MetricsHistory)의 몫.
    let netRxBytes: Double?
    let netTxBytes: Double?
}

struct DataFootprint: Decodable {
    let available: Bool
    let bytes: Double?
}

/// release-status.sh 의 JSON 출력(계약: scripts/__tests__/menubar-release.test.ts).
/// 문구(detail·checkText·note)는 스크립트가 완성한 것을 그대로 쓴다 — 앱은 조립하지 않는다.
struct ReleasePayload: Decodable {
    let schemaVersion: Int
    let deploy: ReleaseDeploy
    /// 최근 반영(배포 기록). ⚠️ 옵셔널이 계약이다 — 앱이 읽는 스크립트는 프로덕션
    /// 체크아웃의 사본이라, 새 앱 + 옛 스크립트 조합(재설치 직후 배포 전)에서
    /// 필드가 없어도 디코드가 깨지면 안 된다.
    let recent: ReleaseRecent?
    /// 지금 서버에 실린 커밋(배포 마커 전문). 앱은 이 값을 기억했다가 다음 조회에
    /// `--deployed-since` 로 되돌려 준다 — 그 왕복이 배포 완료 감지의 전부다.
    /// ⚠️ 위와 같은 이유로 옵셔널이다(옛 스크립트에는 이 필드가 없다).
    let markerSha: String?
    /// 마커가 움직였을 때만 채워진다 = 배포가 실제로 끝났다. 문구는 스크립트가
    /// 완성한 것을 그대로 쓴다.
    let deployed: ReleaseDeployed?
    let prs: ReleasePullRequests
}

/// 「무엇이 방금 서버에 올라갔나」 — 직전 마커와 현재 마커 사이의 PR 목록.
/// ⛔ 앱이 title·body 를 다시 조립하지 않는다(문구 소유는 release-status.sh).
struct ReleaseDeployed: Decodable {
    let from: String
    let to: String
    /// 사이 커밋 수. 0 = 되돌림(앞으로 간 커밋 없음), **-1 = 세지 못함**(조회 실패).
    /// 둘을 같은 숫자로 접지 않는 것이 계약이다.
    let count: Int
    let title: String
    let body: String
    let items: [ReleaseRecentItem]
}

struct ReleaseDeploy: Decodable {
    let level: String       // ok | info | unknown
    let title: String
    let detail: String
    let count: Int
    /// 버튼 노출 여부 — 판정 불능(unknown)은 false 다(모르는 것을 배포 가능으로 가장하지 않는다).
    let canDeploy: Bool
    /// "링크 서버 변경 포함 · 데이터베이스 구조 변경 포함" — 확인 대화상자에도 그대로 쓴다.
    let note: String
    let commits: [ReleaseCommit]
    /// 목록에 싣지 않은 나머지 커밋 수.
    let more: Int
}

struct ReleaseCommit: Decodable, Identifiable, Equatable {
    let sha: String
    let title: String
    var id: String { sha }
}

/// "지금 서버에 실려 있는 것"의 최신 커밋 목록 — 판정·URL 조립은 release-status.sh
/// 소유이고 앱은 표시·이동만 한다.
struct ReleaseRecent: Decodable {
    let title: String
    let detail: String
    let items: [ReleaseRecentItem]
}

struct ReleaseRecentItem: Decodable, Identifiable, Equatable {
    let sha: String
    let title: String
    let url: String
    var id: String { sha }
}

struct ReleasePullRequests: Decodable {
    let level: String
    let title: String
    let detail: String
    let items: [ReleasePullRequest]
}

struct ReleasePullRequest: Decodable, Identifiable, Equatable {
    let number: Int
    let title: String
    let url: String
    let checkLevel: String  // ok | warn | error | unknown
    let checkText: String
    let badge: String       // "초안" 또는 빈 문자열
    var id: Int { number }
}
