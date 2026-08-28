import SwiftUI

/// 릴리스 섹션 — 위는 "지금 배포할 것"(액션이 붙는다), 아래는 "가서 머지할 것"
/// (이동만 한다). 둘은 다른 질문이라 시각적으로 가른다: 열린 PR 은 아직 머지 전이라
/// 배포 대상이 아니다. 문구는 release-status.sh 가 완성한 것을 그대로 쓴다.
struct ReleaseSection: View {
    @ObservedObject var store: ServerStore
    @State private var confirmDeploy = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // ⚠️ 독립 if 로 둔다(else if 금지) — 낡은 release 값이 있어도 조회 실패
            // 경고는 함께 떠야 한다. PanelView 의 statusUnavailable 과 동일 패턴
            // (S3, 2026-08-14 리뷰): "모르는 것을 아는 것처럼" 보이는 비대칭 제거.
            if store.releaseUnavailable {
                Label(releaseUnavailableMessage, systemImage: "questionmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let release = store.release {
                deployRow(release.deploy)
                if let recent = release.recent, !recent.items.isEmpty, !store.deploying {
                    recentSection(recent)
                }
                if !release.prs.items.isEmpty || release.prs.level == "unknown" {
                    prSection(release.prs)
                }
            }
        }
        .alert("프로덕션에 반영합니다", isPresented: $confirmDeploy) {
            Button("배포하기", role: .destructive) { store.releaseDeployAction() }
            Button("취소", role: .cancel) {}
        } message: {
            Text(confirmMessage)
        }
    }

    /// 값이 있는데 조회가 실패했으면 "낡았다"는 사실을, 값이 아예 없으면 기존 문구를 쓴다.
    private var releaseUnavailableMessage: String {
        store.release != nil
            ? "릴리스 상태 최근 조회 실패 — 아래는 이전 값입니다"
            : "릴리스 상태를 확인하지 못했습니다 — 잠시 후 다시 시도합니다"
    }

    private var confirmMessage: String {
        let deploy = store.release?.deploy
        let count = deploy?.count ?? 0
        let note = deploy?.note ?? ""
        let head = "커밋 \(count)건을 프로덕션에 반영합니다."
        let tail = "약 \(Config.releaseDeployEta.replacingOccurrences(of: "약 ", with: "")) 걸립니다. 계속할까요?"
        return note.isEmpty ? "\(head) \(tail)" : "\(head)\n\(note)\n\(tail)"
    }

    @ViewBuilder private func deployRow(_ deploy: ReleaseDeploy) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(levelColor(deploy.level)).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(deploy.title).font(.callout.weight(.medium))
                Text(store.deploying ? store.laneBusyMessage : deploy.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !deploy.note.isEmpty && !store.deploying {
                    Text(deploy.note).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if store.deploying {
                ProgressView().controlSize(.small)
            } else if deploy.canDeploy {
                Button("배포하기") { confirmDeploy = true }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.laneBusy)
            }
        }
        if !store.deploying && !deploy.commits.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(deploy.commits) { commit in
                    Text("· \(commit.title)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                if deploy.more > 0 {
                    Text("외 \(deploy.more)건").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(.leading, 17)
        }
        if let errorOutput = store.laneErrorOutput, store.errorLane == "release" {
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

    /// 최근 반영(배포 기록) — 서버에 이미 실려 있는 최신 커밋 몇 건. 대기 목록(위)과
    /// 반대 방향의 질문("무엇이 이미 나가 있나")이라 액션이 없고 이동만 한다.
    /// 범주 정보라 색을 받지 않는다(P8 승계 — 색은 의미축만 탄다).
    @ViewBuilder private func recentSection(_ recent: ReleaseRecent) -> some View {
        // 구분선은 필수다(ss-ux P1) — 위 배포 대기 목록과 이 목록은 불릿 스타일이
        // 동일한데 의미는 정반대(나갈 것 vs 이미 나간 것)라, 헤더 한 줄만으로는
        // 경계가 안 읽힌다. prSection 진입부와 같은 형태를 쓴다.
        // 위계는 prSection 과 같은 문법을 쓴다 — 둘 다 「헤더 + 링크 목록」인
        // 대등한 절이라, 한쪽만 안으로 밀리거나 한 단 작은 글씨를 쓰면 종속
        // 정보처럼 읽힌다(오너 지적 2026-08-27). 배포 대기 목록이 들여쓰기와
        // 불릿을 유지하는 것은 그쪽이 바로 위 배포 행에 딸린 하위 목록이라서다.
        Divider().padding(.top, 4)
        HStack(spacing: 4) {
            Text(recent.title).font(.caption.weight(.semibold))
            if !recent.detail.isEmpty {
                // prSection 헤더의 detail 과 같은 .caption — 같은 역할은 같은 단.
                Text(recent.detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.top, 4)
        ForEach(recent.items) { item in
            Button {
                if let url = URL(string: item.url) { openURL(url) }
            } label: {
                HStack(spacing: 6) {
                    // 열린 PR 행의 상태 점과 같은 너비를 비워 두 목록의 제목이 같은
                    // 세로선에서 시작하게 한다. 여기 점이 없는 것은 의도다 — 이미
                    // 나간 커밋에는 상태축이 없다(P8: 색은 의미축만 탄다).
                    Color.clear.frame(width: 7, height: 7)
                    Text(item.title).font(.caption).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder private func prSection(_ prs: ReleasePullRequests) -> some View {
        Divider().padding(.top, 4)
        HStack(spacing: 4) {
            Text(prs.title).font(.caption.weight(.semibold))
            Text(prs.detail).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 4)
        ForEach(prs.items) { pr in
            Button {
                if let url = URL(string: pr.url) { openURL(url) }
            } label: {
                HStack(spacing: 6) {
                    // 색을 받는 것은 체크 상태뿐이다 — 번호·제목은 무채색(범주는 색을 안 받는다).
                    Circle().fill(levelColor(pr.checkLevel)).frame(width: 7, height: 7)
                    Text("#\(pr.number)").font(.caption.monospacedDigit())
                    Text(pr.title).font(.caption).lineLimit(1).truncationMode(.tail)
                    if !pr.badge.isEmpty {
                        Text(pr.badge).font(.caption2).foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 4)
                    Text(pr.checkText).font(.caption2).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}
