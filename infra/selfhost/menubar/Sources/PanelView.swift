import SwiftUI

/// 패널 화면 — 항목별 상태등 + 프리뷰(제2 레인) 온·오프. 문구는 status.sh 가
/// 완성해서 주는 것을 그대로 표시한다.
struct PanelView: View {
    @ObservedObject var store: ServerStore
    @State private var confirmReopen = false
    /// 정상(ok) 항목 접기의 펼침 상태 — 기본은 접힘(오너 요청 2026-08-25: 패널은
    /// "지금 주의할 것"부터 보여야 한다). 주의 항목(error·warn·unknown)은 이 상태와
    /// 무관하게 항상 펼쳐 보인다.
    @State private var showHealthy = false
    /// 개발 서버·프리뷰 서버 묶음의 펼침 상태 — 기본은 접힘. 둘 다 꺼져 있고
    /// 조용한 상태가 이 패널을 여는 대부분의 순간이라, 그때 자리를 차지할 이유가 없다.
    @State private var showRuntime = false

    var body: some View {
        // 줄 간격(8)보다 섹션 경계(8 + 구분선 좌우 여백 3×2 = 14)를 넓게 둔다 —
        // 여백만으로도 주제가 바뀌는 지점이 보여야 한다. 종전에는 둘 다 10 이라
        // 1px 구분선 하나가 위계 정보를 혼자 지고 있었다.
        VStack(alignment: .leading, spacing: 8) {
            if store.statusUnavailable {
                Label("상태를 확인하지 못했습니다 — 잠시 후 다시 시도합니다", systemImage: "questionmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            // 주의 항목(error·warn·unknown)은 항상 펼치고, 정상(ok)만 한 줄로 접는다 —
            // "보통 행은 조용히, 주의가 필요한 소수만 노출"(P8 색 사용 원칙과 같은 축).
            // unknown 을 접지 않는 것은 의도다: 판정 불능을 초록 뒤에 숨기지 않는다.
            let statusItems = displayOrder.compactMap { store.items[$0] }
            let healthyCount = statusItems.filter { $0.level == "ok" }.count
            ForEach(statusItems.filter { $0.level != "ok" }) { row($0) }
            if healthyCount > 0 {
                healthySummaryRow(count: healthyCount)
                if showHealthy {
                    ForEach(statusItems.filter { $0.level == "ok" }) { row($0) }
                }
            }
            Divider().padding(.vertical, 3)
            ReleaseSection(store: store)
            Divider().padding(.vertical, 3)
            runtimeSection
            // 레인 오류 원문(빨간 상자)이 떠 있을 때 "지금 확인" 버튼이 그 상자에
            // 딸린 것처럼 보였다 — 메타 영역임을 구분선으로 분리한다.
            Divider().padding(.vertical, 3)
            // 유일한 서버 정보라 맨 아래 메타 영역에 둔다(오너 확정 2026-08-27).
            DataFootprintRow(store: store)
            footer
        }
        .padding(14)
        .frame(width: 380)
        .alert("프리뷰를 처음부터 다시 엽니다", isPresented: $confirmReopen) {
            Button("다시 열기", role: .destructive) { store.laneUp() }
            Button("취소", role: .cancel) {}
        } message: {
            Text("지금 보던 내용이 사라지고 다시 여는 데 \(Config.laneUpEta) 걸립니다. 계속할까요?")
        }
    }

    /// 정상 항목 요약 한 줄 — 클릭하면 접힌 정상 행들을 펼친다. 문구를 스크립트에서
    /// 받지 않는 이유: 이것은 판정이 아니라 표시 집계다(개수 세기·접기 상태는 화면
    /// 소유). 판정("ok 인가")은 여전히 status.sh 의 level 을 그대로 쓴다.
    private func healthySummaryRow(count: Int) -> some View {
        Button {
            showHealthy.toggle()
        } label: {
            HStack(spacing: 8) {
                Circle().fill(levelColor("ok")).frame(width: 9, height: 9)
                Text("정상 \(count)개").font(.callout.weight(.medium))
                Spacer(minLength: 0)
                Image(systemName: showHealthy ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func row(_ item: StatusItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(levelColor(item.level)).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.callout.weight(.medium))
                Text(item.detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    /// 켜고 끄는 서버들(개발·프리뷰)을 한 묶음으로 둔다 — 둘은 같은 축의 질문
    /// ("지금 뭐가 떠 있나")이라 떨어뜨려 놓을 이유가 없다.
    ///
    /// 평시에는 한 줄로 접는다. 다만 **하나라도 켜져 있거나·도는 중이거나·오류
    /// 원문이 있거나·판정이 정상이 아니면 접지 않는다** — 이 행의 목적이 "끄는 것을
    /// 잊는 사고"를 막는 것이라, 켜져 있는 사실이 접힘 뒤에 숨으면 목적이 뒤집힌다.
    @ViewBuilder private var runtimeSection: some View {
        let busyOrUp = store.devUp || store.previewUp || store.laneBusy
        let hasLaneError = store.laneErrorOutput != nil && store.errorLane != "release"
        let notOk = (store.items["devServer"]?.level ?? "unknown") != "ok"
            || (store.items["preview"]?.level ?? "unknown") != "ok"
        let mustShow = busyOrUp || hasLaneError || notOk
        if !mustShow {
            runtimeSummaryRow
        }
        if mustShow || showRuntime {
            devSection
            laneSection
        }
    }

    private var runtimeSummaryRow: some View {
        Button {
            showRuntime.toggle()
        } label: {
            HStack(spacing: 8) {
                Circle().fill(levelColor("ok")).frame(width: 9, height: 9)
                Text("구동 중인 서버 없음").font(.callout.weight(.medium))
                Spacer(minLength: 0)
                Image(systemName: showRuntime ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 개발 서버 — 주 레인(383 결론: 오너의 실제 확인 루프). 켜면 최신 백업으로
    /// DB 를 재구축하고(dev.sh 소유) 뜨는 즉시 브라우저가 열린다.
    @ViewBuilder private var devSection: some View {
        let dev = store.items["devServer"]
        // 정렬은 row(_:)·ReleaseSection.deployRow 와 같은 기준선을 쓴다 — 같은
        // 모양의 행인데 점 높이만 어긋나면 원인을 짚기 어려운 위화감이 남는다.
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(levelColor(dev?.level ?? "unknown")).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(Config.devName).font(.callout.weight(.medium))
                Text(store.busyLane == "dev" ? store.laneBusyMessage : (dev?.detail ?? "확인 불가"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.busyLane == "dev" {
                ProgressView().controlSize(.small)
            } else if store.devUp {
                Button("끄기") { store.devDownAction() }.disabled(store.laneBusy)
            } else {
                Button("켜기") { store.devUpAction() }.disabled(store.laneBusy)
            }
        }
    }

    /// 프리뷰 — 부 레인(폰 확인·프로덕션 빌드 전용 버그 의심 때만).
    @ViewBuilder private var laneSection: some View {
        let lane = store.items["preview"]
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(levelColor(lane?.level ?? "unknown")).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(Config.laneName).font(.callout.weight(.medium))
                Text(store.busyLane == "preview" ? store.laneBusyMessage : (lane?.detail ?? "확인 불가"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.busyLane == "preview" {
                ProgressView().controlSize(.small)
            } else if store.previewUp {
                Button("끄기") { store.laneDown() }.disabled(store.laneBusy)
                Button("다시 열기") { confirmReopen = true }.disabled(store.laneBusy)
            } else {
                Button("켜기") { store.laneUp() }.disabled(store.laneBusy)
            }
        }
        if let errorOutput = store.laneErrorOutput, store.errorLane != "release" {
            ScrollView {
                Text(errorOutput)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 160)
            .padding(6)
            .background(Color.red.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    private var footer: some View {
        HStack {
            if let checked = store.lastChecked {
                Text("마지막 확인 \(checked.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Button("지금 확인") { Task { await store.refresh(fast: false) } }
                .font(.caption)
        }
    }
}
