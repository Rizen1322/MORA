import SwiftUI

@main
@MainActor
struct MORAApp: App {
    @StateObject private var library = LocalLibrary()
    @StateObject private var player = NativePlayer()

    var body: some Scene {
        WindowGroup { RootView(library: library, player: player) }
    }
}
