import SwiftUI

/// 화면은 전부 `AppDelegate` 가 만든 메뉴바 아이템과 창이 담당한다.
/// 여기 Settings 장면은 SwiftUI 앱이 성립하기 위한 껍데기일 뿐 열리지 않는다.
@main
struct WagServerBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}
