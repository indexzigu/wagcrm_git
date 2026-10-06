import SwiftUI

/// DB 데이터 크기 한 줄.
///
/// 원래 이 자리에는 CPU·메모리·데이터 전송 그래프 3개가 있었으나 운영에 쓰이지
/// 않아 제거했다(오너 확정 2026-08-27). `metrics.sh` 폴링 자체는 남는다 — CPU
/// 과부하 판정이 메뉴바 경고 아이콘 조건(`ServerStore.hasError`)에 물려 있고,
/// 이 줄이 쓰는 데이터 크기도 같은 페이로드에서 온다.
struct DataFootprintRow: View {
    @ObservedObject var store: ServerStore

    var body: some View {
        if store.metricsUnavailable {
            // 침묵시키지 않는다 — 이 상태에서는 CPU 과부하 경고도 함께 죽어 있다.
            Label("사용량을 확인하지 못했습니다 — 잠시 후 다시 시도합니다", systemImage: "questionmark.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            if let dbData = store.latestMetrics?.dbData, dbData.available, let bytes = dbData.bytes {
                HStack(spacing: 6) {
                    Text("DB 데이터 크기").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Text(Self.byteText(bytes)).font(.caption.weight(.medium))
                }
            }
            // 코드 점유량 — 디스크 여유가 하루에 5G 씩 오르내릴 때 "무엇이 커졌나"를 바로
            // 보기 위한 줄(2026-10-06). 워크트리 하나가 node_modules+.next 로 2G 남짓이라
            // AI 세션이 워크트리를 만들고 지울 때마다 그만큼 흔들린다. 옛 스크립트(필드
            // 없음)면 줄 자체를 그리지 않는다.
            if let repo = store.latestMetrics?.repoData {
                repoRow(repo)
            }
        }
    }

    @ViewBuilder
    private func repoRow(_ repo: RepoFootprint) -> some View {
        HStack(spacing: 6) {
            Text("코드·워크트리 크기").font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if repo.available, let total = repo.totalBytes {
                Text(Self.byteText(total)).font(.caption.weight(.medium))
            } else if let error = repo.error {
                // 침묵시키지 않는다 — 측정 실패는 캐시에 적혀 여기까지 온다.
                Text("측정 실패 — \(error)").font(.caption).foregroundStyle(.red)
            } else {
                Text("측정 중…").font(.caption).foregroundStyle(.secondary)
            }
        }
        .help(Self.repoHelp(repo))
    }

    /// 마우스를 올리면 보이는 내역 — "줄이면 얼마나 돌아오나"가 아니라 "지금 얼마나
    /// 깔려 있나"(du 기준)라는 것까지 적는다.
    static func repoHelp(_ repo: RepoFootprint) -> String {
        var parts: [String] = []
        if let main = repo.mainBytes { parts.append("본체 \(byteText(main))") }
        if let count = repo.worktreeCount, let bytes = repo.worktreeBytes {
            parts.append("워크트리 \(count)개 \(byteText(bytes))")
        }
        if let deploy = repo.deployBytes { parts.append("운영본 \(byteText(deploy))") }
        if let missing = repo.missing, missing > 0 { parts.append("미측정 \(missing)곳") }
        if let at = repo.measuredAt, at.count >= 16 { parts.append("\(at.dropFirst(11).prefix(5)) 측정") }
        parts.append("du 기준 · 30분마다")
        return parts.joined(separator: " · ")
    }

    /// 바이트 표기 — ⛔ `ByteCountFormatter` 를 쓰지 말 것. 이 앱에는 한국어
    /// 로컬라이즈가 없어 Foundation 이 **영어 단어로 떨어진다**(실측:
    /// 0 → "Zero KB", 1 → "1 byte", 512 → "512 bytes"). 한국어 패널에 영어가
    /// 섞이는 것이 오너 화면에서 실제로 보였다. `allowsNonnumericFormatting`
    /// 을 꺼도 "0 bytes"·"1 byte" 는 그대로라 그 옵션으로는 해결되지 않는다.
    /// 단위 기호(B·KB·MB·GB)는 언어 중립이라 직접 만든다.
    static func byteText(_ v: Double) -> String {
        let bytes = max(v, 0)
        for (scale, unit) in [(1_073_741_824.0, "GB"), (1_048_576.0, "MB"), (1024.0, "KB")]
        where bytes >= scale {
            return String(format: "%.1f %@", bytes / scale, unit)
        }
        return String(format: "%.0f B", bytes)
    }
}
