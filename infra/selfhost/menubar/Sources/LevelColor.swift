import SwiftUI

/// status.sh · metrics.sh · release-status.sh 가 공통으로 쓰는 `level` 어휘의
/// 색 정본. 화면마다 switch 를 새로 쓰면 같은 레벨이 다른 색으로 갈라진다.
/// unknown = 확인 불가 — 초록으로 가장하지 않는다(설계 원칙).
func levelColor(_ level: String) -> Color {
    switch level {
    case "ok": return .green
    case "warn": return .yellow
    case "error": return .red
    case "info": return .blue
    default: return .gray
    }
}
