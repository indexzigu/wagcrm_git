import AppKit
import Combine
import SwiftUI

/// 메뉴바 아이템과 팝오버 창을 직접 만든다. 뼈대는 같은 기계에서 검증된
/// ticket-board(`~/Projects/ticket-board/macapp/`)의 이식이다.
///
/// **왜 SwiftUI 의 `MenuBarExtra` 를 쓰지 않는가(ticket-board 실사고):**
/// `MenuBarExtra` 의 창은 메뉴바 아이콘에 **붙어서** 위치를 잡는다. 메뉴바
/// 자동 숨김을 켜두면 아이콘이 딸려 올라가면서 창까지 끌려가 흔들린다.
/// 그래서 창을 직접 만들고 **열리는 순간 좌표를 계산해 박는다**.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = ServerStore()
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var outsideMonitor: Any?
    private var keyMonitor: Any?
    private var watchers = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.target = self
        item.button?.action = #selector(toggle)
        statusItem = item
        store.start()
        drawIcon()

        // 상태가 바뀌면 아이콘도 바뀐다(정상 ↔ 경고, 레인 점 표시). 패널이 열려
        // 있으면 크기도 다시 잰다 — 첫 열기 직후 중량 검사 결과가 늦게 도착해
        // 행이 늘어나는데, 열 때 한 번 잰 크기로는 그 행들이 잘린다(실측 결함).
        store.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.drawIcon()
                    self?.resizePanelIfNeeded()
                }
            }
            .store(in: &watchers)
    }

    func applicationWillTerminate(_ notification: Notification) {
        removeMonitors()
    }

    // MARK: - 메뉴바 아이콘

    private func drawIcon() {
        // 우선순위: 오류 > 배포 중 > 정상. 배포는 수 분이 걸리고 패널을 닫아도
        // 계속 도므로, 진행 중이라는 사실이 아이콘에 남아야 한다.
        let name: String
        if store.hasError {
            name = "exclamationmark.triangle"
        } else if store.deploying {
            name = "arrow.triangle.2.circlepath"
        } else {
            // `server.rack` 은 가로선 3개 + 점으로 이뤄져 메뉴바 크기(≈15pt)로
            // 줄면 선 간격이 1px 미만이 되어 회색 얼룩으로 뭉갠다(2026-08-27 실측
            // 렌더 비교). 큰 사각형 하나인 `display` 는 같은 크기에서 실루엣이
            // 남는다 — 눈에 띄는 것이 이 아이콘의 목적이므로 형태를 우선한다.
            name = "display"
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "WAG 서버")
        image?.isTemplate = true
        statusItem?.button?.image = image
        // 아이콘 옆 글자는 두 가지를 잇달아 붙인다.
        //  ① 배포 대기 건수 — 패널을 열지 않고도 "밀린 게 몇 건인지" 보여준다
        //     (오너 확정 2026-08-27). 건수를 못 셌을 때(level "unknown")는 숫자를
        //     지어내지 않고 아무것도 쓰지 않는다.
        //  ② 개발 서버·프리뷰가 켜져 있는 동안의 점 — 둘 다 켜져 있는 동안
        //     프로덕션 사본 DB 가 디스크에 있으므로, 끄는 것을 잊는 사고를 막는다(설계).
        var label = ""
        if let deploy = store.release?.deploy, deploy.level != "unknown", deploy.count > 0 {
            label += " \(deploy.count)"
        }
        if store.previewUp || store.devUp {
            label += " ●"
        }
        statusItem?.button?.title = label
        statusItem?.button?.imagePosition = .imageLeading
    }

    // MARK: - 창 열고 닫기

    @objc private func toggle() {
        if panel?.isVisible == true {
            hide()
        } else {
            show()
        }
    }

    private func show() {
        // 열리는 순간 최신 상태로 — 경량 검사는 즉시, 릴리스는 간격 가드(60초)를 탄다.
        Task { @MainActor in
            await store.refresh(fast: true)
            present()
            await store.refreshRelease()
        }
    }

    private func present() {
        let panel = panel ?? makePanel()
        self.panel = panel

        // 높이는 내용이 정한다 — 아래 숫자는 fittingSize 를 못 구한 경우에만 쓰는
        // 최후 폴백이다. 종전 360 은 리소스 그래프 3개가 있던 시절의 값이라
        // 그래프 제거 후로는 근거가 없어졌다(2026-08-27).
        panel.setContentSize(panel.contentView?.fittingSize ?? NSSize(width: 380, height: 300))
        panel.setFrameOrigin(anchor(for: panel.frame.size))
        panel.orderFrontRegardless()
        panel.makeKey()
        installMonitors()
    }

    private func hide() {
        panel?.orderOut(nil)
        removeMonitors()
    }

    /// 열려 있는 동안 내용 높이가 바뀌면(늦게 도착한 검사 결과·레인 오류 출력)
    /// 크기·좌표를 다시 잡는다. 좌표를 같이 잡는 이유: 창은 위 모서리가 고정돼야
    /// 하는데 setContentSize 는 아래 기준이라 그대로 두면 위로 자란다.
    private func resizePanelIfNeeded() {
        guard let panel, panel.isVisible else { return }
        let size = panel.contentView?.fittingSize ?? panel.frame.size
        if abs(size.height - panel.frame.size.height) > 1 {
            panel.setContentSize(size)
            panel.setFrameOrigin(anchor(for: size))
        }
    }

    /// 창 좌표는 **여기서 한 번만** 정한다. 메뉴바가 이후에 숨어도 다시 계산하지 않는다.
    private func anchor(for size: NSSize) -> NSPoint {
        guard let button = statusItem?.button, let host = button.window else {
            return NSPoint(x: 100, y: 100)
        }
        let onScreen = host.convertToScreen(button.convert(button.bounds, to: nil))
        var x = onScreen.midX - size.width / 2
        let y = onScreen.minY - size.height - 6

        if let bounds = (host.screen ?? NSScreen.main)?.frame {
            x = min(max(x, bounds.minX + 8), bounds.maxX - size.width - 8)
        }
        return NSPoint(x: x, y: y)
    }

    private func makePanel() -> NSPanel {
        let panel = FloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 360),
            // nonactivatingPanel: 앱을 앞으로 끌어내지 않는다 — 그래야 자동 숨김
            // 메뉴바가 이 창 때문에 나타났다 사라지는 일이 없다.
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = NSHostingView(rootView: PanelChrome(store: store))
        panel.isFloatingPanel = true
        panel.level = .popUpMenu
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        return panel
    }

    // MARK: - 바깥 클릭·ESC 로 닫기

    private func installMonitors() {
        removeMonitors()
        outsideMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            Task { @MainActor in self?.hide() }
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 {  // esc
                Task { @MainActor in self?.hide() }
                return nil
            }
            return event
        }
    }

    private func removeMonitors() {
        if let outsideMonitor { NSEvent.removeMonitor(outsideMonitor) }
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        outsideMonitor = nil
        keyMonitor = nil
    }
}

/// 테두리 없는 창은 **기본적으로 키 윈도우가 되지 못한다**(ticket-board 실사고) —
/// 버튼 클릭이 먹히도록 열어준다. 앱 자체를 앞으로 끌어내지 않으려고
/// `canBecomeMain` 은 닫아 둔다.
private final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// 테두리 없는 창이라 모서리·배경은 내용 쪽에서 그린다.
private struct PanelChrome: View {
    @ObservedObject var store: ServerStore

    var body: some View {
        PanelView(store: store)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.primary.opacity(0.12), lineWidth: 1)
            )
            .padding(6)   // 그림자가 잘리지 않도록
    }
}
