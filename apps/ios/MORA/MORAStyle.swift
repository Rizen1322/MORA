import SwiftUI
import UIKit

enum MORAStyle {
    // Dark values match apps/web/src/styles/app.css; light values follow system appearance.
    static let background = adaptive(0x050d0a, 0xf3f7f4)
    static let surface = adaptive(0x0a1712, 0xffffff)
    static let raised = adaptive(0x10221a, 0xe1eee5)
    static let accent = adaptive(0x4ade9a, 0x08683e)
    static let onAccent = adaptive(0x04150d, 0xffffff)
    static let text = adaptive(0xecf5ee, 0x10221a)
    static let secondary = adaptive(0xb3c9bb, 0x465e50)
    static let line = text.opacity(0.10)

    private static func adaptive(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
}

struct Artwork: View {
    let track: LocalTrack
    let library: LocalLibrary
    var body: some View {
        if let url = library.artworkURL(for: track), let image = ArtworkCache.image(at: url) {
            Image(uiImage: image).resizable().scaledToFill().clipped().accessibilityHidden(true)
        } else {
            ZStack {
                LinearGradient(colors: [MORAStyle.accent.opacity(0.4), MORAStyle.raised], startPoint: .topLeading, endPoint: .bottomTrailing)
                Image(systemName: "music.note").foregroundStyle(MORAStyle.accent).font(.title)
            }.accessibilityHidden(true)
        }
    }
}

