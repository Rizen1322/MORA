// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MORACore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "MORACore", targets: ["MORACore"])],
    targets: [
        .target(name: "MORACore", path: "MORA", exclude: [
            "MORAApp.swift", "LocalLibrary.swift", "NativePlayer.swift", "PlannerBridge.swift",
            "RootView.swift", "LibraryView.swift", "PlayerView.swift", "MORAStyle.swift",
            "ArtworkCache.swift", "SourceContracts.swift", "Info.plist", "Resources"
        ], sources: ["PlaybackBookmark.swift", "LocalTrack.swift"]),
        .testTarget(name: "MORACoreTests", dependencies: ["MORACore"], path: "NativeTests")
    ]
)
