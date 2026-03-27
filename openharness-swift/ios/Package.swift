// swift-tools-version: 6.0
// ClawGuard — Secure iOS Client for OpenClaw/NemoClaw

import PackageDescription

let package = Package(
    name: "ClawGuard",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "ClawGuardCore", targets: ["ClawGuardCore"]),
    ],
    targets: [
        // Core library — sentinel, audit, vault, networking, views
        .target(
            name: "ClawGuardCore",
            path: "Sources/ClawGuardCore",
            exclude: ["App/ClawGuardApp.swift"]
        ),
        // Tests
        .testTarget(
            name: "ClawGuardCoreTests",
            dependencies: ["ClawGuardCore"],
            path: "Tests/ClawGuardCoreTests"
        ),
    ]
)
