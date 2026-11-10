import AVKit
import MediaPlayer
import SwiftUI
import UIKit
import WebKit

/// iPhone full player over the WebView while NativeMixHost plays. It reads native state only,
/// so it keeps working while WebContent is suspended or reloading.
enum NativePlayerSheet {
    /// `finished` receives "close" or "more" («Ещё»: the page opens its own full player).
    static func present(host: NativeMixHost, from parent: UIViewController, finished: @escaping (String) -> Void) {
        let model = NativePlayerModel(host: host)
        let controller = UIHostingController(rootView: NativePlayerView(model: model))
        model.controller = controller
        model.onFinish = finished
        controller.modalPresentationStyle = .pageSheet
        controller.sheetPresentationController?.prefersGrabberVisible = true
        controller.overrideUserInterfaceStyle = .dark
        controller.view.backgroundColor = UIColor(red: 5 / 255, green: 13 / 255, blue: 10 / 255, alpha: 1)
        parent.present(controller, animated: true)
    }
}

final class NativePlayerModel: ObservableObject {
    @Published var state = NativePlayerState()
    @Published private(set) var artwork: UIImage?
    /// The seek target from the moment the finger lifts until the host reports it.
    @Published var scrub: Double?
    @Published private(set) var reaction = 0
    /// When `state.position` was read: the scrubber runs the clock on from there between polls.
    private(set) var receivedAt = Date()
    weak var controller: UIViewController?
    var onFinish: ((String) -> Void)?
    private var action = "close"
    private let host: NativeMixHost
    private var timer: Timer?
    private var artworkKey = ""

    init(host: NativeMixHost) { self.host = host }

    /// Polls only while the sheet is on screen and the app is in the foreground.
    func start() {
        guard timer == nil else { return }
        refresh()
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
    func stop() { timer?.invalidate(); timer = nil }

    func refresh(then: (() -> Void)? = nil) {
        host.playerState { [weak self] result in
            defer { then?() }
            guard let self, case .success(let value) = result else { return }
            let next = NativePlayerState(value)
            self.reaction = NativeShellStore.shared?.reaction(next.trackId) ?? 0
            if !next.active { self.stop(); self.close("close"); return }
            if next.entryId != self.state.entryId { self.scrub = nil }
            self.receivedAt = Date()
            if next != self.state { self.state = next }
            let key = "\(next.entryId)|\(next.artworkReady)"
            if key != self.artworkKey {
                self.artworkKey = key
                self.artwork = (value["artwork"] as? MPMediaItemArtwork)?.image(at: CGSize(width: 600, height: 600))
            }
        }
    }

    /// The same command path as the lock screen.
    private func send(_ action: String, time: Double? = nil, then: (() -> Void)? = nil) {
        // `then` runs once the post-command state is shown, so a seek target never flashes back to the old position.
        host.command(action, time: time, source: "player") { [weak self] _ in
            if let self { self.refresh(then: then) } else { then?() }
        }
    }
    func transport(_ action: String) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if action == "play" || action == "pause" { state.playing = action == "play" }
        send(action)
    }
    func seek(to time: Double) {
        scrub = time
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        send("seekto", time: time) { [weak self] in
            if self?.scrub == time { self?.scrub = nil }
        }
    }

    func react(_ value: Int) {
        guard let store = NativeShellStore.shared else { return }
        reaction = reaction == value ? 0 : value
        store.react(id: state.trackId, value: reaction)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    func close(_ action: String) {
        self.action = action
        // From the presenter: dismissing this controller would only close the queue sheet above it.
        controller?.presentingViewController?.dismiss(animated: true)
    }
    /// Also reached by swipe-down, which dismisses without close().
    func finish() {
        stop()
        onFinish?(action); onFinish = nil
    }
}

extension Color {
    static let moraBackground = Color(red: 5 / 255, green: 13 / 255, blue: 10 / 255)
    static let moraMint = Color(red: 74 / 255, green: 222 / 255, blue: 154 / 255)
    static let moraGold = Color(red: 245 / 255, green: 200 / 255, blue: 110 / 255)
}

private struct IconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.title3.weight(.semibold))
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel(label)
    }
}

private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = UIColor.white.withAlphaComponent(0.7)
        view.activeTintColor = UIColor(red: 74 / 255, green: 222 / 255, blue: 154 / 255, alpha: 1)
        view.prioritizesVideoDevices = false
        view.accessibilityLabel = "Устройство вывода"
        return view
    }
    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

struct NativePlayerView: View {
    @ObservedObject var model: NativePlayerModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var queueOpen = false
    @State private var showLyrics = false

    var body: some View {
        let s = model.state
        VStack(spacing: 0) {
            HStack {
                IconButton(symbol: "chevron.down", label: "Свернуть плеер") { model.close("close") }
                Spacer()
                Text("Сейчас играет").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.6))
                    .accessibilityHidden(true)
                Spacer()
                IconButton(symbol: "ellipsis", label: "Ещё") { model.close("more") }
            }
            .padding(.horizontal, -10)
            Spacer(minLength: 12)
            if queueOpen {
                HStack(spacing: 12) {
                    NativeCover(url: nil, size: 64, radius: 10, image: model.artwork)
                    metadata
                }
                NativeQueueContent(model: model).frame(maxHeight: .infinity)
            } else {
                cover(playing: s.playing)
                Spacer(minLength: 16)
                metadata
            }
            NativeScrubber(state: s, receivedAt: model.receivedAt, pending: model.scrub) { model.seek(to: $0) }
                .id(s.entryId).padding(.top, 18)
            transport(playing: s.playing).padding(.vertical, 12)
            Spacer(minLength: 8)
            NativeSystemVolume().frame(height: 32).padding(.top, 12)
            HStack {
                IconButton(symbol: "quote.bubble", label: "Текст песни") {
                    queueOpen = false; showLyrics.toggle()
                }.foregroundStyle(showLyrics ? Color.moraMint : .white.opacity(0.7))
                Spacer()
                RoutePicker().frame(width: 44, height: 44)
                Spacer()
                IconButton(symbol: "list.bullet", label: queueOpen ? "Показать обложку" : "Очередь") {
                    queueOpen.toggle()
                }.foregroundStyle(queueOpen ? Color.moraMint : .white.opacity(0.7))
            }
            .padding(.top, 10)
        }
        .padding(.horizontal, 24)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .foregroundStyle(.white)
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .background { backdrop.ignoresSafeArea() }
        .onAppear { model.start() }
        .onDisappear { model.finish() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in model.stop() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in model.start() }

    }

    private var metadata: some View {
        HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.state.title.isEmpty ? "MORA" : model.state.title).font(.title2.bold()).lineLimit(1)
                Text(model.state.artist).font(.title3).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
            }.frame(maxWidth: .infinity, alignment: .leading)
            IconButton(symbol: model.reaction > 0 ? "heart.fill" : "heart", label: model.reaction > 0 ? "Убрать лайк" : "Нравится") { model.react(1) }
                .foregroundStyle(model.reaction > 0 ? Color.moraMint : .white)
                .accessibilityValue(model.reaction > 0 ? "Включено" : "Выключено")
            IconButton(symbol: model.reaction < 0 ? "hand.thumbsdown.fill" : "hand.thumbsdown", label: "Не нравится") { model.react(-1) }
                .foregroundStyle(model.reaction < 0 ? Color.moraGold : .white.opacity(0.7))
                .accessibilityValue(model.reaction < 0 ? "Включено" : "Выключено")
        }
    }

    private var backdrop: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.10, green: 0.24, blue: 0.17), .moraBackground], startPoint: .top, endPoint: .bottom)
            if let image = model.artwork {
                Image(uiImage: image).resizable().scaledToFill().blur(radius: 60).opacity(0.35)
            }
        }
    }

    private func cover(playing: Bool) -> some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: 430)
            .overlay {
                ZStack(alignment: .bottomTrailing) {
                    Group {
                        if showLyrics {
                            NativeLyricsView(model: model)
                        } else if let image = model.artwork {
                            Image(uiImage: image).resizable().scaledToFill().accessibilityHidden(true)
                        } else {
                            ZStack {
                                Color.moraMint.opacity(0.12)
                                Image(systemName: "music.note").font(.system(size: 64)).foregroundStyle(.white.opacity(0.4))
                            }
                            .accessibilityHidden(true)
                        }
                    }
                    .transition(.opacity)
                    Button { showLyrics.toggle() } label: {
                        Image(systemName: showLyrics ? "square.stack" : "text.alignleft")
                            .font(.body.weight(.semibold)).frame(width: 44, height: 44)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel(showLyrics ? "Показать обложку" : "Показать текст песни")
                    .padding(12)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.6), radius: playing ? 30 : 14, y: playing ? 20 : 10)
            .scaleEffect(showLyrics || playing || reduceMotion ? 1 : 0.84)
            .animation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.75), value: playing)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: showLyrics)
            .layoutPriority(-1)
    }

    private func transport(playing: Bool) -> some View {
        HStack {
            Spacer()
            Button { model.transport("previoustrack") } label: {
                Image(systemName: "backward.fill").font(.system(size: 34)).frame(width: 64, height: 64)
            }
            .accessibilityLabel("Предыдущий")
            Spacer()
            Button { model.transport(playing ? "pause" : "play") } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: 48, weight: .semibold))
                    .frame(width: 80, height: 80)
            }
            .accessibilityLabel(playing ? "Пауза" : "Играть")
            Spacer()
            Button { model.transport("nexttrack") } label: {
                Image(systemName: "forward.fill").font(.system(size: 34)).frame(width: 64, height: 64)
            }
            .accessibilityLabel("Следующий")
            Spacer()
        }
    }
}

private struct NativeLyrics {
    let status: String
    let plain: String
    let lines: [(time: Double, text: String)]
    let offset: Double

    init(_ value: [String: Any]) {
        status = value["status"] as? String ?? "none"
        plain = value["plain"] as? String ?? ""
        let raw = value["wordLines"] as? [[String: Any]] ?? value["lines"] as? [[String: Any]] ?? []
        lines = raw.compactMap { line in
            guard let time = (line["t"] as? NSNumber)?.doubleValue, let text = line["text"] as? String else { return nil }
            return (time, text)
        }
        offset = (value["offsetMs"] as? NSNumber)?.doubleValue ?? 0
    }
}

private struct NativeLyricsView: View {
    @ObservedObject var model: NativePlayerModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lyrics: NativeLyrics?
    @State private var failure: String?
    @State private var retry = 0

    var body: some View {
        let lines = lyrics?.lines ?? []
        let now = model.state.position + (lyrics?.offset ?? 0) / 1000
        let active = lines.lastIndex { $0.time <= now } ?? -1
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 16) {
                    if let failure {
                        Text(failure).foregroundStyle(.white.opacity(0.7))
                        Button("Повторить") { retry &+= 1 }.buttonStyle(.bordered)
                    } else if let lyrics {
                        if !lines.isEmpty {
                            ForEach(lines.indices, id: \.self) { index in
                                Button { model.seek(to: max(0, lines[index].time - lyrics.offset / 1000)) } label: {
                                    Text(lines[index].text.isEmpty ? "♪" : lines[index].text)
                                        .font(.body.weight(index == active ? .semibold : .regular))
                                        .foregroundStyle(index == active ? Color.moraMint : .white.opacity(0.58))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.plain)
                                .id(index)
                            }
                        } else if lyrics.status == "plain" && !lyrics.plain.isEmpty {
                            Text(lyrics.plain).frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text("Текст для этой песни не найден.")
                            Button("Поискать снова") { retry &+= 1 }.buttonStyle(.bordered)
                        }
                    } else {
                        ProgressView("Ищем текст…")
                    }
                }
                .padding(20)
                .padding(.bottom, 48)
            }
            .onChange(of: active) { _, index in
                if index >= 0 { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { proxy.scrollTo(index, anchor: .center) } }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.moraBackground)
        .task(id: "\(model.state.trackId)|\(retry)") { await load(model.state.trackId, refresh: retry > 0) }
    }

    @MainActor private func load(_ id: String, refresh: Bool) async {
        lyrics = nil; failure = nil
        guard !id.isEmpty else { failure = "Трек недоступен"; return }
        guard let webView = NativeShellStore.shared?.webView else { failure = "Медиатека ещё загружается"; return }
        do {
            let result = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any, Error>) in
                webView.callAsyncJavaScript("const response = await fetch('/api/tracks/' + encodeURIComponent(id) + '/lyrics' + (refresh ? '?refresh=1' : '')); if (!response.ok) throw new Error('HTTP ' + response.status); return await response.json()",
                                            arguments: ["id": id, "refresh": refresh], in: nil, in: .page) { continuation.resume(with: $0) }
            }
            guard !Task.isCancelled else { return }
            if let value = result as? [String: Any] { lyrics = NativeLyrics(value) }
            else { failure = "Не удалось прочитать текст" }
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
}

private struct NativeQueueContent: View {
    @ObservedObject var model: NativePlayerModel
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text("Продолжение").font(.title2.bold()).padding(.top, 18)
                if let label = NativeShellStore.shared?.ui.now?.label, !label.isEmpty {
                    Text("Из: \(label)").font(.subheadline).foregroundStyle(.secondary)
                }
                if model.state.upcoming.isEmpty { Text("Очередь готовится…").foregroundStyle(.secondary) }
                ForEach(model.state.upcoming) { row in
                    HStack(spacing: 12) {
                        NativeCover(url: row.cover ?? NativeShellStore.shared?.byId[row.trackId]?.cover, size: 48, radius: 7, embedded: row.artwork)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(row.title).font(.body.weight(.medium)).lineLimit(1)
                            Text(row.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            if let label = row.mixLabel {
                                Label(label, systemImage: "sparkles").font(.caption.weight(.medium)).foregroundStyle(Color.moraGold)
                            }
                        }
                        Spacer(minLength: 0)
                    }.accessibilityElement(children: .combine)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 16)
        }
    }
}

private struct NativeSystemVolume: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView()
        view.showsRouteButton = false
        view.tintColor = UIColor.white.withAlphaComponent(0.65)
        view.accessibilityLabel = "Громкость"
        return view
    }
    func updateUIView(_ view: MPVolumeView, context: Context) {}
}


private struct NativeScrubber: View {
    let state: NativePlayerState
    let receivedAt: Date
    let pending: Double?
    let seek: (Double) -> Void
    @GestureState private var drag: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let duration = max(state.duration, 1)
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !state.playing || drag != nil || pending != nil)) { context in
            let live = min(state.duration, state.position + (state.playing ? max(0, context.date.timeIntervalSince(receivedAt)) : 0))
            let shown = drag ?? pending ?? live
            VStack(spacing: 6) {
                GeometryReader { geo in
                    let width = geo.size.width
                    let x = width * min(1, max(0, shown / duration))
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.18)).frame(height: drag == nil ? 6 : 10)
                        if let start = state.mixStart {
                            Capsule().fill(Color.moraGold.opacity(0.85))
                                .frame(width: max(4, width * state.mixLength / duration), height: drag == nil ? 6 : 10)
                                .offset(x: width * start / duration)
                        }
                        Capsule().fill(.white).frame(width: x, height: drag == nil ? 6 : 10)
                        Circle().fill(.white).frame(width: drag == nil ? 14 : 24, height: drag == nil ? 14 : 24)
                            .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
                            .offset(x: x - (drag == nil ? 7 : 12))
                    }
                    .frame(width: width, height: 44)
                    .contentShape(Rectangle())
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: drag == nil)
                    // GestureState resets when the sheet's own pan cancels the drag; a @State value stayed stuck there.
                    .gesture(DragGesture(minimumDistance: 4)
                        .updating($drag) { g, value, _ in
                            guard state.duration > 0 else { return }
                            if value == nil { UISelectionFeedbackGenerator().selectionChanged() }
                            value = min(state.duration, max(0, g.location.x / width * state.duration))
                        }
                        .onEnded { g in
                            guard state.duration > 0 else { return }
                            seek(min(state.duration, max(0, g.location.x / width * state.duration)))
                        })
                }
                .frame(height: 44)
                HStack {
                    Text(NativePlayerTime.text(shown))
                    Spacer()
                    if let start = state.mixStart {
                        HStack(spacing: 3) { Image(systemName: "sparkles"); Text("AutoMix \(NativePlayerTime.text(start))") }
                            .foregroundStyle(Color.moraGold.opacity(0.9))
                        Spacer()
                    }
                    Text(NativePlayerTime.text(state.duration))
                }
                .font(.caption.monospacedDigit().weight(.medium))
                .foregroundStyle(.white.opacity(0.55))
                .accessibilityHidden(true)
            }
            .accessibilityElement()
            .accessibilityLabel("Позиция")
            .accessibilityValue("\(NativePlayerTime.text(shown)) из \(NativePlayerTime.text(state.duration))" + (state.mixStart.map { ", AutoMix с \(NativePlayerTime.text($0))" } ?? ""))
            .accessibilityAdjustableAction { direction in
                guard state.duration > 0 else { return }
                seek(min(state.duration, max(0, shown + (direction == .increment ? 10 : -10))))
            }
        }
        .disabled(state.duration <= 0)
    }
}
