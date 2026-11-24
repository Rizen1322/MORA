import SwiftUI
import WidgetKit
import AppIntents

/// Home-screen widgets: «Моя волна», «Продолжить» and «Любимое». Each opens the app through
/// mora:// (NativeDeepLink); the app writes their data (NativeWidgetData) and reloads them.

private let mint = Color(red: 74 / 255, green: 222 / 255, blue: 154 / 255)
private let background = Color(red: 5 / 255, green: 13 / 255, blue: 10 / 255)
private let emeraldTop = Color(red: 11 / 255, green: 34 / 255, blue: 25 / 255)
private let emeraldMid = Color(red: 7 / 255, green: 21 / 255, blue: 15 / 255)
private let mintDeep = Color(red: 19 / 255, green: 56 / 255, blue: 41 / 255)

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

private struct MoraWidgetBackdrop: View {
    var glowAlignment: UnitPoint = .topTrailing
    var glowOpacity: Double = 0.26

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [emeraldTop, emeraldMid, background],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [mint.opacity(glowOpacity), .clear],
                center: glowAlignment,
                startRadius: 6,
                endRadius: 170
            )
        }
    }
}

private struct MoraWordmark: View {
    var body: some View {
        Text("MORA")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .tracking(1.4)
            .foregroundStyle(mint.opacity(0.85))
            .unredacted()
    }
}

private struct WaveBarsArtwork: View {
    let heights: [CGFloat]
    let barWidth: CGFloat
    let spacing: CGFloat
    let maxHeight: CGFloat

    var body: some View {
        HStack(alignment: .center, spacing: spacing) {
            ForEach(Array(heights.enumerated()), id: \.offset) { _, ratio in
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [mint, mint.opacity(0.32)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: barWidth, height: max(4, maxHeight * ratio))
            }
        }
        .unredacted()
    }
}

private struct Header: View {
    let title: String, symbol: String

    var body: some View {
        HStack(spacing: 6) {
            Label(title, systemImage: symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(mint)
                .lineLimit(1)
            Spacer(minLength: 4)
            MoraWordmark()
        }
        .unredacted()
    }
}

struct WaveWidgetView: View {
    let source: WaveSourceChoice
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if family == .systemMedium {
                HStack(alignment: .center, spacing: 14) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 5) {
                            Image(systemName: source.symbol)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(mint)
                            MoraWordmark()
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(mintDeep.opacity(0.75), in: Capsule())
                        .overlay(Capsule().stroke(mint.opacity(0.24), lineWidth: 0.75))

                        Spacer(minLength: 0)

                        Text("Моя волна")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Text(source.title)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.68))
                            .lineLimit(1)

                        HStack(spacing: 5) {
                            Image(systemName: "play.fill")
                                .font(.system(size: 9, weight: .bold))
                            Text("Слушать")
                                .font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(background)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(mint, in: Capsule())
                        .padding(.top, 2)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

                    ZStack {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(mintDeep.opacity(0.55))
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .stroke(mint.opacity(0.22), lineWidth: 0.75)
                            )
                        WaveBarsArtwork(
                            heights: [0.32, 0.62, 0.92, 0.54, 0.80, 0.44, 0.68],
                            barWidth: 5,
                            spacing: 4,
                            maxHeight: 58
                        )
                    }
                    .frame(width: 96, maxHeight: .infinity)
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .top) {
                        Image(systemName: source.symbol)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(mint)
                            .frame(width: 34, height: 34)
                            .background(mintDeep.opacity(0.8), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .stroke(mint.opacity(0.24), lineWidth: 0.75)
                            )
                        Spacer(minLength: 0)
                        WaveBarsArtwork(
                            heights: [0.38, 0.78, 1.0, 0.56],
                            barWidth: 3.5,
                            spacing: 3,
                            maxHeight: 22
                        )
                    }
                    Spacer(minLength: 0)
                    MoraWordmark()
                    Text("Моя волна")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(source.title)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.68))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            }
        }
        .unredacted()
        .widgetURL(source.url)
    }
}

struct ContinueWidgetView: View {
    let entry: MoraEntry
    @Environment(\.widgetFamily) private var family

    private var trackContent: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let now = entry.data?.now {
                Text(now.title)
                    .font(family == .systemMedium ? .title3.weight(.bold) : .headline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                Text(now.artist)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Откройте MORA")
                        .font(family == .systemMedium ? .title3.weight(.bold) : .headline.weight(.semibold))
                        .foregroundStyle(.white)
                    Text("Нажмите, чтобы открыть плеер")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                }
                .unredacted()
            }
            if let updated = entry.data?.updatedAt {
                HStack(spacing: 3) {
                    Text("Обновлено")
                    Text(updated, style: .relative)
                }
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.48))
                .lineLimit(1)
            }
        }
    }

    private var playBadge: some View {
        ZStack {
            Circle()
                .fill(mintDeep.opacity(0.85))
                .overlay(Circle().stroke(mint.opacity(0.28), lineWidth: 1))
            Image(systemName: entry.data?.playing == true ? "waveform" : "play.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(mint)
        }
        .frame(width: 48, height: 48)
        .unredacted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Header(
                title: entry.data?.playing == true ? "Сейчас играет" : "Продолжить",
                symbol: entry.data?.playing == true ? "speaker.wave.2.fill" : "play.fill"
            )
            Spacer(minLength: 0)
            HStack(alignment: .bottom, spacing: 12) {
                trackContent
                if family == .systemMedium {
                    Spacer(minLength: 0)
                    playBadge
                }
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
        VStack(alignment: .leading, spacing: 7) {
            Header(title: entry.data.map { "Любимое · \($0.likedCount)" } ?? "Любимое", symbol: "heart.fill")
            if rows.isEmpty {
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.data == nil ? "Откройте MORA" : "Отмечайте треки сердцем")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.85))
                    Text("Избранное появится здесь автоматически")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                }
                .unredacted()
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { index, song in
                HStack(spacing: 8) {
                    Text("\(index + 1)")
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(mint.opacity(0.75))
                        .frame(width: 14, alignment: .leading)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(song.title)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Text(song.artist)
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.55))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
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
            WaveWidgetView(source: entry.source)
                .containerBackground(for: .widget) {
                    MoraWidgetBackdrop(glowAlignment: .trailing, glowOpacity: 0.30)
                }
        }
        .configurationDisplayName("Моя волна")
        .description("Запускает бесконечный поток под ваше настроение.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct ContinueWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "mora.continue", provider: MoraProvider()) { entry in
            ContinueWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    MoraWidgetBackdrop(glowAlignment: .topTrailing, glowOpacity: 0.24)
                }
        }
        .configurationDisplayName("Продолжить слушать")
        .description("Последний трек: продолжить или открыть плеер.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct LikedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "mora.liked", provider: MoraProvider()) { entry in
            LikedWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    MoraWidgetBackdrop(glowAlignment: .topLeading, glowOpacity: 0.22)
                }
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
                Image(systemName: "waveform")
                    .font(.title2)
                    .unredacted()
                    .widgetURL(URL(string: "mora://wave"))
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

@available(iOSApplicationExtension 18.0, *)
struct MoraPlaybackControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "mora.playback") {
            ControlWidgetButton(action: NativePlaybackToggleIntent()) {
                Label("Пауза / продолжить", systemImage: "playpause.fill")
            }
        }.displayName("Плеер MORA").description("Пауза или продолжение нативного воспроизведения.")
    }
}

@main
struct MoraWidgets: WidgetBundle {
    var body: some Widget {
        WaveWidget()
        ContinueWidget()
        LikedWidget()
        LockScreenWidget()
        if #available(iOSApplicationExtension 18.0, *) { MoraPlaybackControl() }
    }
}
