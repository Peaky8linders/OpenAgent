import SwiftUI

// MARK: - App State (Observable, shared across all views)

@Observable
public final class AppState {
    public let sentinel: SentinelPipeline
    public let audit: AuditLedger
    public let vault: CredentialVault
    public let gateway: GatewayClient

    public var isConnected: Bool {
        if case .connected = gateway.connectionState { return true }
        return false
    }

    public init() {
        let sentinel = SentinelPipeline(blockOnSuspicious: true, phiDetection: true)
        let audit = AuditLedger()
        self.sentinel = sentinel
        self.audit = audit
        self.vault = CredentialVault(audit: audit)
        self.gateway = GatewayClient(sentinel: sentinel, audit: audit)
    }
}

// MARK: - Root View (connection gate)

public struct RootView: View {
    @Environment(AppState.self) private var appState

    public init() {}

    public var body: some View {
        Group {
            if appState.isConnected {
                MainTabView()
            } else {
                ConnectionView()
            }
        }
    }
}

// MARK: - Main Tab View

public struct MainTabView: View {
    public init() {}

    public var body: some View {
        TabView {
            ChatView()
                .tabItem {
                    Label("Chat", systemImage: "message.fill")
                }

            AuditView()
                .tabItem {
                    Label("Audit", systemImage: "shield.checkered")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}

// MARK: - App Entry Point (for Xcode project integration)
// Import ClawGuardCore in your Xcode project's App.swift and use:
//
//   @main
//   struct MyApp: App {
//       @State private var appState = AppState()
//       var body: some Scene {
//           WindowGroup {
//               RootView()
//                   .environment(appState)
//           }
//       }
//   }
