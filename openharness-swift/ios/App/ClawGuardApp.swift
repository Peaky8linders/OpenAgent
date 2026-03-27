import SwiftUI
import ClawGuardCore

// MARK: - ClawGuard iOS App Entry Point
// This file lives outside the library and provides the @main entry point.
// In Xcode: add this as the app target's source file.

@main
struct ClawGuardApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
        }
    }
}
