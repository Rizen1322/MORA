import SwiftUI
import WidgetKit
import AppIntents

/// Home-screen widgets: «Моя волна», «Продолжить» and «Любимое». Each opens the app through
/// mora:// (NativeDeepLink); the app writes their data (NativeWidgetData) and reloads them.

private let mint = Color(red: 74 / 255, green: 222 / 255, blue: 154 / 255)
private let background = Color(red: 5 / 255, green: 13 / 255, blue: 10 / 255)

enum WaveSourceChoice: String, AppEnum {
    case app, own, online, yandex
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Источник волны"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .app: .init(title: "Как в приложении", image: .init(systemName: "waveform")),
        .own: .init(title: "Коллекция", image: .init(systemName: "music.note.list")),
        .online: .init(title: "Онлайн-радио", image: .init(systemName: "dot.radiowaves.left.and.right")),
        .yandex: .init(title: "Яндекс Музыка", image: .init(systemName: "music.note")),
    ]
    var title: String {
        switch self {
        case .app: return "Как в приложении"
        case .own: return "Коллекция"
        case .online: return "Онлайн-радио"
        case .yandex: return "Яндекс Музыка"
        }
    }
    var symbol: String {
        switch self {
        case .app: return "waveform"
        case .own: return "music.note.list"
        case .online: return "dot.radiowaves.left.and.right"
        case .yandex: return "music.note"
        }
    }
    var url: URL { URL(string: self == .app ? "mora://wave" : "mora://wave?source=\(rawValue)")! }
}

struct WaveWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Моя волна"
    static var description = IntentDescription("Выберите источник для этого виджета.")
    @Parameter(title: "Какую волну запускать") var source: WaveSourceChoice?
}

struct WaveEntry: TimelineEntry {
    let date: Date
    let source: WaveSourceChoice
}

struct WaveProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WaveEntry { WaveEntry(date: .now, source: .app) }
    func snapshot(for configuration: WaveWidgetIntent, in context: Context) async -> WaveEntry {
        WaveEntry(date: .now, source: configuration.source ?? .app)
    }
    func timeline(for configuration: WaveWidgetIntent, in context: Context) async -> Timeline<WaveEntry> {
        Timeline(entries: [await snapshot(for: configuration, in: context)], policy: .never)
    }
}

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
    let source: WaveSourceChoice
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: source.symbol).font(.title.weight(.semibold)).foregroundStyle(mint)
            Spacer(minLength: 0)
            Text("Моя волна").font(.headline).foregroundStyle(.white)
            Text(source.title).font(.caption).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(source.url)
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
            if let updated = entry.data?.updatedAt {
                HStack(spacing: 3) {
                    Text("Обновлено")
                    Text(updated, style: .relative)
                }.font(.caption2).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
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
        AppIntentConfiguration(kind: "mora.wave", intent: WaveWidgetIntent.self, provider: WaveProvider()) { entry in
            WaveWidgetView(source: entry.source).containerBackground(background, for: .widget)
        }
        .configurationDisplayName("Моя волна")
        .description("Запускает бесконечный поток под ваше настроение.")
        .supportedFamilies([.systemSmall, .systemMedium])
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

struct LockScreenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "mora.lockscreen", provider: MoraProvider()) { entry in
            LockScreenWidgetView(entry: entry).containerBackground(background, for: .widget)
        }
        .configurationDisplayName("MORA на экране блокировки")
        .description("Текущий трек или быстрый запуск волны.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

private struct LockScreenWidgetView: View {
    let entry: MoraEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                Image(systemName: "waveform").font(.title2).widgetURL(URL(string: "mora://wave"))
            case .accessoryInline:
                Label(entry.data?.now?.title ?? "Откройте MORA", systemImage: "music.note").widgetURL(URL(string: "mora://player"))
            default:
                VStack(alignment: .leading) {
                    Text(entry.data?.now?.title ?? "Откройте MORA").font(.headline).lineLimit(1)
                    Text(entry.data?.now?.artist ?? "Моя волна").font(.caption).lineLimit(1)
                }.widgetURL(URL(string: "mora://player"))
            }
        }
    }
}

#Preview(as: .systemSmall) { WaveWidget() } timeline: {
    WaveEntry(date: .now, source: .app)
    WaveEntry(date: .now, source: .yandex)
}
#Preview(as: .systemMedium) { WaveWidget() } timeline: {
    WaveEntry(date: .now, source: .own)
    WaveEntry(date: .now, source: .online)
}

@main
struct MoraWidgets: WidgetBundle {
    var body: some Widget {
        WaveWidget()
        ContinueWidget()
        LikedWidget()
        LockScreenWidget()
        MoraActivityWidget()
        if #available(iOSApplicationExtension 18.0, *) { MoraPlaybackControl() }
    }
}
