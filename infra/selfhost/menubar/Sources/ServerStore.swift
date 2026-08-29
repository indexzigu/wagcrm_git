import Foundation
import Combine
import UserNotifications

/// 폴링·상태 병합·알림·레인 액션. 시스템 조작은 전부 subprocess 로 스크립트에
/// 위임한다(status.sh = 읽기 전용 판정 / preview.sh = 온·오프). 앱이 docker·
/// launchctl 을 직접 부르는 것은 계약 테스트(menubar-app-delegation.test.ts)가
/// 금지한다 — preview.sh 안의 프로덕션 보호 가드를 우회하기 때문이다.
@MainActor
final class ServerStore: ObservableObject {
    @Published private(set) var items: [String: StatusItem] = [:]
    @Published private(set) var lastChecked: Date?
    /// 실행 중인 레인 액션("dev"/"preview") — 한 번에 하나만 돈다.
    @Published private(set) var busyLane: String?
    @Published private(set) var laneBusyMessage = ""
    @Published private(set) var laneErrorOutput: String?
    /// laneErrorOutput 이 어느 레인("dev"/"preview"/"release") 것인지 — dev·preview·release
    /// 가 이 필드 하나를 공유하는데, 그리는 곳(laneSection)은 프리뷰 행 하나뿐이라 배포
    /// 실패 원문이 무관한 행에 묻히는 것을 막는다.
    @Published private(set) var errorLane: String?
    @Published private(set) var statusUnavailable = false
    /// metrics.sh 30초 폴링의 최신 1회 — 그래프가 사라진 뒤로는 이력을 들지 않는다
    /// (오너 확정 2026-08-27). 소비처는 둘: CPU 과부하 → `hasError`(메뉴바 경고
    /// 아이콘), 데이터 크기 → `DataFootprintRow`.
    @Published private(set) var latestMetrics: MetricsPayload?
    @Published private(set) var metricsUnavailable = false
    /// 릴리스 섹션(배포 대기·열린 PR) — gh 왕복이라 300초 + 패널 열 때만 갱신한다.
    @Published private(set) var release: ReleasePayload?
    @Published private(set) var releaseUnavailable = false
    private var lastReleaseCheck: Date?
    /// 마지막으로 관측한 배포 마커(= 지금 서버에 실린 커밋). 이 값이 바뀌는 순간이
    /// 「배포가 끝났다」이고, 그때 알림 1통이 나간다(설계 개정 5).
    ///
    /// ⛔ **첫 관측은 알리지 않는다** — nil 인 동안에는 `--deployed-since` 를 넘기지
    ///    않으므로 스크립트가 `deployed: null` 을 돌려준다. 이 가드가 없으면 앱을 켤
    ///    때마다(재부팅·크래시 복구 포함) 가짜 「배포 완료」가 뜬다. reconcile 의
    ///    hasReconciled 와 같은 부류의 「기동 직후 1회는 기준값만 잡는다」 가드다.
    /// ⛔ 디스크에 저장하지 않는다 — 앱이 꺼져 있던 사이의 배포는 놓치는 것이 맞다.
    ///    나중에 알리면 오너가 방금 일어난 일로 읽는다.
    private var lastKnownMarker: String?
    /// 이미 알린 배포 마커. **겹쳐 도는 조회가 같은 배포를 두 번 알리는 것을 막는다.**
    ///
    /// 🪤 `refreshRelease` 는 호출 지점이 넷이다(기동 · 5분 타이머 · **패널 열기** ·
    ///    배포 완료 직후 force). `lastKnownMarker` 갱신은 `await` **뒤**라, 배포가 끝나는
    ///    순간에 두 호출이 겹치면 둘 다 같은 구 마커를 스냅샷으로 들고 출발해 **둘 다**
    ///    같은 배포를 발견한다 — 5분짜리 배포를 지켜보려고 패널을 여는 것은 흔한 조작이라
    ///    이론적인 경우가 아니다(2026-08-27 교차 검증 지적). 최소 간격 가드는 "마지막
    ///    호출이 **시작**된 시각"만 보므로 이 겹침을 볼 수 없다.
    /// ⚠️ 이 판정이 성립하는 이유는 `@MainActor` 다 — await 뒤 이어지는 구간이 직렬화돼
    ///    읽고-쓰기 사이에 다른 호출이 끼지 못한다.
    private var lastNotifiedDeployMarker: String?

    private var fastTimer: Timer?
    private var fullTimer: Timer?
    private var notifiedErrorKeys = Set<String>()
    private var notificationsReady = false
    /// 화해(reconcile)를 이미 돌렸는가 — 앱 수명당 1회로 막는다(아래 reconcileExternalAlerts).
    private var hasReconciled = false
    /// 마지막으로 일일 요약을 시도한 날(era 기준 일련일). ⛔ 프로세스 메모리다 — 앱이
    /// 재시작하면 리셋되므로 하루 1통을 **실제로** 지키는 것은 notify.sh 의
    /// DIGEST_MIN_INTERVAL_H 다(아래 sendDailyDigestIfDue).
    private var lastDigestDay: Int?

    /// 알림 감시 목록 — macOS 알림·텔레그램·화해(reconcile)가 전부 이 하나를 공유한다
    /// (계약: scripts/__tests__/menubar-app-delegation.test.ts "watched 배열은 하나뿐이어야
    /// 한다"). disk 는 의도적으로 뺀다(오너 지시 — 디스크 잔여는 알리지 않고 화면
    /// 표시만 유지). 전달 계약의 NOTIFY_EXEMPT 에 사유와 함께 등재돼 있다 — 여기
    /// 추가하려면 그 등재를 먼저 지워야 하고, 그 순간 오너 지시를 되돌리는 것임이 드러난다.
    ///
    /// preflightRunner 는 반대로 **등재를 지우고 여기 넣은** 경우다(오너 결정 2026-08-27).
    /// 이 행이 error 가 되는 경로는 둘뿐이고(등록 0대 · online 0대) 둘 다 결과가 「모든 PR
    /// 머지 불가」라, disk 의 「잔여 자원」 부류와 성격이 다르다. ⛔ 이 키를
    /// UNKNOWN_ESCALATABLE_KEYS 에 넣지 말 것 — 그러면 gh 조회 실패(회색)가 error 로 승격돼
    /// **네트워크 끊김마다 폰이 울린다.** 지금은 승격 목록에 없어서 폴백 중·gh 실패는
    /// 알림 대상이 아니다(화면 색으로만).
    private static let watched = ["prodLocal", "prodExternal", "db", "backupDaily", "backupWeekly", "crons", "preflightRunner"]

    var previewUp: Bool { items["preview"]?.state == "up" }
    var devUp: Bool { items["devServer"]?.state == "up" }
    var laneBusy: Bool { busyLane != nil }
    /// 리소스 과부하(error)도 아이콘 경고에 합류한다 — 단 macOS 알림은 보내지
    /// 않는다(오너 확정: 색으로만. notifyOnNewErrors 의 watched 에 넣지 말 것).
    var hasError: Bool {
        items.values.contains { $0.level == "error" }
            || latestMetrics?.crm.cpuLevel == "error"
            || latestMetrics?.db.cpuLevel == "error"
    }
    /// 배포가 도는 동안 메뉴바 아이콘을 바꾸기 위한 신호(패널을 닫아도 보여야 한다).
    var deploying: Bool { busyLane == "release" }

    func start() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor in self.notificationsReady = granted }
        }
        Task {
            await self.refresh(fast: false)
            await self.refreshMetrics()
            await self.refreshRelease()
        }
        fastTimer = Timer.scheduledTimer(withTimeInterval: Config.fastPollSeconds, repeats: true) { _ in
            Task { @MainActor in
                await self.refresh(fast: true)
                await self.refreshMetrics()
            }
        }
        fullTimer = Timer.scheduledTimer(withTimeInterval: Config.fullPollSeconds, repeats: true) { _ in
            Task { @MainActor in
                await self.refresh(fast: false)
                await self.refreshRelease()
            }
        }
    }

    func refresh(fast: Bool) async {
        // 판정보다 먼저 보낸다 — status.sh 가 고장 나도 "앱은 살아 있다"는 사실은
        // 참이고, 그 사실이 dead-man 이 묻는 유일한 질문이다.
        if !fast { Task { _ = await Self.run(script: Config.heartbeatScript, args: []) } }
        // 텔레그램 도달성 확인(메시지 없음) — full 폴링에서만. notify.sh 자체가
        // 시간당 1회로 자기 빈도를 제한하므로 여기서 추가로 간격을 두지 않는다.
        if !fast { notifyExternal(["probe"]) }
        let result = await Self.run(script: Config.statusScript, args: fast ? ["--fast"] : [])
        guard result.exitCode == 0,
              let data = result.stdout.data(using: .utf8),
              let payload = try? JSONDecoder().decode(StatusPayload.self, from: data)
        else {
            // 판정 불능은 초록으로 가장하지 않는다 — 패널이 회색 안내를 띄운다.
            statusUnavailable = true
            return
        }
        statusUnavailable = false
        for item in payload.items { items[item.key] = item }
        lastChecked = Date()
        notifyOnNewErrors()
        if !fast { reconcileExternalAlerts() }
        if !fast { sendDailyDigestIfDue() }
    }

    /// 리소스 계측 폴링 — 판정 불능은 초록으로 가장하지 않는다(회색 안내).
    func refreshMetrics() async {
        let result = await Self.run(script: Config.metricsScript, args: [])
        guard result.exitCode == 0,
              let data = result.stdout.data(using: .utf8),
              let payload = try? JSONDecoder().decode(MetricsPayload.self, from: data)
        else {
            metricsUnavailable = true
            return
        }
        metricsUnavailable = false
        latestMetrics = payload
    }

    /// 릴리스 상태 폴링. `force` 는 간격 가드를 무시한다(배포 직후 즉시 반영용).
    func refreshRelease(force: Bool = false) async {
        if !force, let last = lastReleaseCheck,
           Date().timeIntervalSince(last) < Config.releaseMinIntervalSeconds {
            return
        }
        lastReleaseCheck = Date()
        // 직전에 관측한 마커를 되돌려 준다 — 스크립트가 그 사이 구간을 조회해
        // 「무엇이 방금 올라갔나」를 문구까지 완성해 준다. 마커를 모르는 동안
        // (기동 직후)에는 넘기지 않으므로 알림도 나가지 않는다.
        let args = lastKnownMarker.map { ["--deployed-since", $0] } ?? []
        let result = await Self.run(script: Config.releaseStatusScript, args: args)
        guard result.exitCode == 0,
              let data = result.stdout.data(using: .utf8),
              let payload = try? JSONDecoder().decode(ReleasePayload.self, from: data)
        else {
            releaseUnavailable = true
            return
        }
        releaseUnavailable = false
        release = payload
        // 판정·문구는 전부 스크립트 것이다 — 앱은 있으면 띄운다. 발화 조건이
        // 마커 변화 하나뿐이라 버튼 배포·터미널 배포가 **같은 한 줄**을 탄다
        // (배포 버튼은 끝난 직후 refreshRelease(force:) 를 부르므로 즉시 뜬다).
        // 🪤 같은 마커로는 두 번 알리지 않는다(위 lastNotifiedDeployMarker 주석의 겹침).
        //    표식을 발송 **전에** 찍어야 뒤따라 들어온 호출이 그것을 보고 멈춘다.
        if let deployed = payload.deployed, deployed.to != lastNotifiedDeployMarker {
            lastNotifiedDeployMarker = deployed.to
            postNotification(title: deployed.title, body: deployed.body)
        }
        // 옛 스크립트(필드 없음)에서는 마커를 잃지 않는다 — 잃으면 다음 회차가
        // 다시 「첫 관측」이 되어 그 사이의 배포를 영영 못 본다.
        if let marker = payload.markerSha { lastKnownMarker = marker }
    }

    /// 심각한 문제만, 상태가 나빠지는 전환에 1회 — 반복 알림 없음(설계 원칙).
    private func notifyOnNewErrors() {
        // crons = 자동 작업 지연·실패(2026-08-19 추가). 레이더에만 있던 신호가 6일간
        // 아무에게도 도달하지 않은 사고에서 나왔다 — 이 배열에서 빼면 그 상태로 되돌아간다.
        // backupWeekly 는 2026-08-19 까지 빠져 있었다 — 주간 백업이 실패해도 화면에 빨간
        // 행만 뜨고 알림은 가지 않았다. disk 는 의도적으로 뺀다(오너 지시 — 디스크 잔여는
        // 알리지 않고 화면 표시만).
        // 계약: scripts/__tests__/menubar-app-delegation.test.ts
        for key in Self.watched {
            guard let item = items[key] else { continue }
            if item.level == "error" {
                if !notifiedErrorKeys.contains(key) {
                    notifiedErrorKeys.insert(key)
                    postNotification(title: item.title, body: item.detail)
                    // 같은 전환·같은 문구를 외부 채널로도 보낸다. 재발송 하한과 발송
                    // 실패 처리는 notify.sh 가 소유한다 — 앱은 전환만 알린다.
                    notifyExternal(["send", key, item.title, item.detail])
                }
            } else if notifiedErrorKeys.remove(key) != nil {
                // 실제로 빨강에서 벗어난 순간에만 부른다. 조건 없이 부르면 초록인
                // 항목마다 매 폴링에 프로세스가 하나씩 뜬다.
                notifyExternal(["clear", key])
            }
        }
    }

    /// 앱이 죽어 있던 사이(크래시·재부팅) 항목이 회복된 경우의 화해. `notifiedErrorKeys`
    /// 는 프로세스 메모리라 **이 프로세스가** 실제로 빨강을 본 적이 있어야만 clear 가
    /// 나간다 — 회복이 이전 프로세스 생애에서 일어났다면 이번 프로세스는 그 사실을
    /// 모른 채 `alert-sent.tsv` 의 옛 발송 기록만 남고, 다음 진짜 빨강이
    /// `RESEND_MIN_INTERVAL_H`(6시간) 하한에 걸려 조용히 삼켜진다(2026-08-19 리뷰
    /// 지적 I1). 기동 후 첫 full 폴링에서 1회, 지금 error 가 아닌 감시 대상 키에
    /// clear 를 보내 그 남은 기록을 정리한다. `hasReconciled` 가 앱 수명당 1회로
    /// 막는다 — 조건 없이 매 폴링 부르면 초록인 항목마다 매번 프로세스가 뜨는,
    /// notifyOnNewErrors 가 이미 피하고 있는 것과 같은 문제가 재발한다.
    private func reconcileExternalAlerts() {
        guard !hasReconciled else { return }
        hasReconciled = true
        for key in Self.watched {
            guard let item = items[key], item.level != "error" else { continue }
            notifyExternal(["clear", key])
        }
    }

    /// 하루 1회 "지금 빨강인 것" 요약 — 전환 알림 1통을 놓쳐도 다음 날 다시 온다.
    /// 설계 정본: docs/private/specs/2026-08-25-daily-red-digest-design.md
    ///
    /// 왜 필요한가(2026-08-25 실사고 #446): 알림은 **엣지 트리거**다. 한 번 빨강이 된 뒤
    /// 계속 빨강이면 notifiedErrorKeys 가 추가 발송을 막으므로, 크론이 나흘 연속 실패해도
    /// 시스템이 말을 건 것은 첫 전환 1회뿐이었다. 그 침묵은 정상과 구분되지 않는다.
    ///
    /// ⛔ 새로 판정하지 않는다 — 감시 목록은 notifyOnNewErrors 와 **같은 Self.watched** 이고,
    ///    문구는 status.sh 가 완성한 title·detail 을 잇기만 한다. 별도 목록을 만들면 disk
    ///    제외 같은 오너 결정이 한쪽에서만 계승된다(외부채널 설계서의 ⛔ 조항).
    /// ⛔ 빨강이 없으면 보내지 않는다 — 매일 오는 「전부 정상」은 그 학습이 알림 전체를
    ///    무시하게 만든다(앞선 설계 3건이 warn 단계 알림을 기각한 것과 같은 근거).
    /// 🪤 표식은 빨강이 없어도 찍는다. 안 찍으면 그날 늦게 빨강이 된 항목에 요약이 한 번
    ///    더 붙어, 방금 나간 전환 알림과 몇 분 사이로 두 통이 된다.
    private func sendDailyDigestIfDue() {
        let calendar = Calendar.current
        let now = Date()
        guard calendar.component(.hour, from: now) >= Config.digestHour else { return }
        guard let today = calendar.ordinality(of: .day, in: .era, for: now) else { return }
        guard lastDigestDay != today else { return }
        lastDigestDay = today
        let red = Self.watched.compactMap { items[$0] }.filter { $0.level == "error" }
        guard !red.isEmpty else { return }
        let detail = red.map { "\($0.title): \($0.detail)" }.joined(separator: " / ")
        notifyExternal(["send", "digest", "아직 빨강입니다", detail])
    }

    /// 외부 채널 발송은 폴링을 막지 않는다 — 결과를 기다리지 않고 던진다.
    private func notifyExternal(_ args: [String]) {
        Task { _ = await Self.run(script: Config.notifyScript, args: args) }
    }

    private func postNotification(title: String, body: String) {
        guard notificationsReady else { return }
        let content = UNMutableNotificationContent()
        content.title = "WAG 서버 — \(title)"
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - 레인 켜기/끄기 (전부 dev.sh / preview.sh 위임)

    func devUpAction() { runLane("dev", script: Config.devScript, args: ["up"], busyMessage: "여는 중… \(Config.devUpEta) 걸립니다") }
    func devDownAction() { runLane("dev", script: Config.devScript, args: ["down"], busyMessage: "닫는 중…") }
    func laneUp() { runLane("preview", script: Config.laneScript, args: ["up"], busyMessage: "여는 중… \(Config.laneUpEta) 걸립니다") }
    func laneDown() { runLane("preview", script: Config.laneScript, args: ["down"], busyMessage: "닫는 중…") }
    /// 배포 — 순서(CRM → 조건부 링크 서버)·조건·경로는 전부 release-deploy.sh 가 소유한다.
    func releaseDeployAction() {
        runLane(
            "release",
            script: Config.releaseDeployScript,
            args: [],
            busyMessage: "배포 중… \(Config.releaseDeployEta) 걸립니다",
            timeout: Config.releaseDeployTimeout
        )
    }

    private func runLane(
        _ lane: String, script: String, args: [String], busyMessage: String,
        timeout: TimeInterval = 900
    ) {
        guard !laneBusy else { return }
        busyLane = lane
        laneBusyMessage = busyMessage
        laneErrorOutput = nil
        errorLane = nil
        Task {
            let result = await Self.run(script: script, args: args, timeout: timeout)
            self.busyLane = nil
            if result.exitCode != 0 {
                // 진단 메시지를 그대로 보여준다 — 요약·삼킴 금지(설계 원칙: 그
                // 메시지들은 실사고를 거쳐 다듬어진 것이다).
                let combined = [result.stdout, result.stderr]
                    .filter { !$0.isEmpty }
                    .joined(separator: "\n")
                self.laneErrorOutput = combined.isEmpty ? "스크립트가 이유 없이 실패했습니다(코드 \(result.exitCode))" : combined
                self.errorLane = lane
                // 배포는 몇 분 걸려 오너가 자리를 뜬 사이에 끝난다 — 실패를 패널
                // 색으로만 알리면 다음에 패널을 열 때까지 모른다(성공 알림을 넣는
                // 이유와 같다). 원문은 패널이 그대로 들고 있으므로 여기서는 첫 줄만
                // 싣는다 — 「요약·삼킴 금지」는 패널 표시에 대한 원칙이고, 이 알림은
                // 패널로 보내는 포인터다.
                //
                // ⚠️ 성공은 여기서 알리지 않는다. 성공 통지의 발화 조건은 마커 변화
                //    하나이고(refreshRelease), 여기서 또 보내면 버튼 배포만 2통이 된다.
                // ⚠️ 이 경로는 **버튼으로 시작한 배포만** 본다. 터미널 실행의 실패는
                //    마커가 안 움직여 구조적으로 관측할 수 없다(설계 개정 5의 한계 절).
                if lane == "release" {
                    let firstLine = self.laneErrorOutput?
                        .split(separator: "\n", omittingEmptySubsequences: true)
                        .first
                        .map(String.init) ?? ""
                    self.postNotification(
                        title: "배포 실패",
                        body: firstLine.isEmpty
                            ? "메뉴바 패널에서 원문을 확인하세요"
                            : firstLine
                    )
                }
            }
            await self.refresh(fast: true)
            if lane == "release" { await self.refreshRelease(force: true) }
        }
    }

    // MARK: - subprocess

    struct RunResult {
        let exitCode: Int32
        let stdout: String
        let stderr: String
    }

    private static func run(script: String, args: [String], timeout: TimeInterval = 30) async -> RunResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/bash")
                process.arguments = [script] + args
                let out = Pipe()
                let err = Pipe()
                process.standardOutput = out
                process.standardError = err
                do {
                    try process.run()
                } catch {
                    continuation.resume(returning: RunResult(exitCode: 127, stdout: "", stderr: "실행 실패: \(error.localizedDescription)"))
                    return
                }
                // 타임아웃은 읽기 **전에** 건다 — 스크립트가 파이프를 안 닫고 멈추면
                // readDataToEndOfFile 이 영원히 기다리는데, terminate 가 파이프를 닫아
                // 그 대기를 풀어준다.
                let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
                // 두 파이프를 **동시에** 비운다 — 순차로 읽으면 stderr 버퍼(16KB)가
                // 가득 찬 자식이 write 에서 멈추고, stdout 도 진행이 안 돼 EOF 가 오지
                // 않는 교착이 된다(빌드 로그가 많은 preview.sh up 이 정확히 그 경우다).
                var errData = Data()
                let errDrain = DispatchGroup()
                errDrain.enter()
                DispatchQueue.global().async {
                    errData = err.fileHandleForReading.readDataToEndOfFile()
                    errDrain.leave()
                }
                let outData = out.fileHandleForReading.readDataToEndOfFile()
                errDrain.wait()
                process.waitUntilExit()
                deadline.cancel()
                continuation.resume(returning: RunResult(
                    exitCode: process.terminationStatus,
                    stdout: String(data: outData, encoding: .utf8) ?? "",
                    stderr: String(data: errData, encoding: .utf8) ?? ""
                ))
            }
        }
    }
}
