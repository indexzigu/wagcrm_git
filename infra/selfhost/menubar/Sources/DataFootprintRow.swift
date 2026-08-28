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
        } else if let dbData = store.latestMetrics?.dbData, dbData.available, let bytes = dbData.bytes {
            HStack(spacing: 6) {
                Text("DB 데이터 크기").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text(Self.byteText(bytes)).font(.caption.weight(.medium))
            }
        }
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
