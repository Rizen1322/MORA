import SwiftUI
import WidgetKit

/// Home-screen widgets: «Моя волна», «Продолжить» and «Любимое». Each opens the app through
/// mora:// (NativeDeepLink); the app writes their data (NativeWidgetData) and reloads them.

private let mint = Color(red: 74 / 255, green: 222 / 255, blue: 154 / 255)
private let background = Color(red: 5 / 255, green: 13 / 255, blue: 10 / 255)

struct MoraEntry: TimelineEntry {
    let date: Date
    /// nil: the app has not shared anything (first launch pending, or no App Group in the signature).
    let data: NativeWidgetData?
}

struct MoraProvider: TimelineProvider {
    func placeholder(in context: Context) -> MoraEntry {
        MoraEntry(date: .now, data: NativeWidgetData(now: .init(title: "Название трека", artist: "Исполнитель"), liked: [.init(title: "Любимый трек", artist: "Исполнитель")], likedCount: 1))
    }
    func getSnapshot(in context: Context, completion: @escaping (MoraEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : MoraEntry(date: .now, data: NativeWidgetData.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<MoraEntry>) -> Void) {
        // The app reloads the widgets whenever their data changes.
        completion(Timeline(entries: [MoraEntry(date: .now, data: NativeWidgetData.load())], policy: .never))
    }
}

private struct Header: View {
    let title: String, symbol: String
    var body: some View {
        Label(title, systemImage: symbol).font(.caption.weight(.semibold)).foregroundStyle(mint).lineLimit(1)
    }
}

struct WaveWidgetView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "waveform").font(.title.weight(.semibold)).foregroundStyle(mint)
            Spacer(minLength: 0)
            Text("Моя волна").font(.headline).foregroundStyle(.white)
            Text("Слушать").font(.caption).foregroundStyle(.white.opacity(0.6))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "mora://wave"))
    }
}

struct ContinueWidgetView: View {
    let entry: MoraEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Header(title: entry.data?.playing == true ? "Сейчас играет" : "Продолжить", symbol: entry.data?.playing == true ? "speaker.wave.2.fill" : "play.fill")
            Spacer(minLength: 0)
            if let now = entry.data?.now {
                Text(now.title).font(.headline).foregroundStyle(.white).lineLimit(2)
                Text(now.artist).font(.caption).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
            } else {
                Text("Откройте MORA").font(.headline).foregroundStyle(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "mora://player"))
    }
}

struct LikedWidgetView: View {
    let entry: MoraEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        let rows = entry.data?.liked.prefix(family == .systemLarge ? 6 : 3) ?? []
        VStack(alignment: .leading, spacing: 6) {
            Header(title: entry.data.map { "Любимое · \($0.likedCount)" } ?? "Любимое", symbol: "heart.fill")
            if rows.isEmpty {
                Spacer(minLength: 0)
                Text(entry.data == nil ? "Откройте MORA" : "Отмечайте треки сердцем").font(.subheadline).foregroundStyle(.white.opacity(0.7))
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, song in
                VStack(alignment: .leading, spacing: 1) {
                    Text(song.title).font(.subheadline.weight(.medium)).foregroundStyle(.white).lineLimit(1)
                    Text(song.artist).font(.caption2).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(URL(string: "mora://liked"))
    }
}

struct WaveWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "mora.wave", provider: MoraProvider()) { _ in
            WaveWidgetView().containerBackground(background, for: .widget)
        }
        .configurationDisplayName("Моя волна")
        .description("Запускает бесконечный поток под ваше настроение.")
        .supportedFamilies([.systemSmall])
    }
}

struct ContinueWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "mora.continue", provider: MoraProvider()) { entry in
            ContinueWidgetView(entry: entry).containerBackground(background, for: .widget)
        }
        .configurationDisplayName("Продолжить слушать")
        .description("Последний трек: продолжить или открыть плеер.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct LikedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "mora.liked", provider: MoraProvider()) { entry in
            LikedWidgetView(entry: entry).containerBackground(background, for: .widget)
        }
        .configurationDisplayName("Любимое")
        .description("Последние треки, отмеченные сердцем.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

@main
struct MoraWidgets: WidgetBundle {
    var body: some Widget {
        WaveWidget()
        ContinueWidget()
        LikedWidget()
    }
}
