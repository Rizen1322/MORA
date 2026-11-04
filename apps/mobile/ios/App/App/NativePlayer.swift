import AVKit
import MediaPlayer
import SwiftUI
import UIKit

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
    /// When `state.position` was read: the scrubber runs the clock on from there between polls.
    private(set) var receivedAt = Date()
    weak var controller: UIViewController?
    var onFinish: ((String) -> Void)?
    private var action = "close"
    private let host: NativeMixHost
    private var timer: Timer?
    private var artworkKey = ""
    /// Queue edits, swap and likes are the page's (lib/native-ui.ts); nil when the native shell is not installed.
    private(set) weak var shell = NativeShellStore.shared
    @Published private var edit: NativeQueueEdit?
    var upcoming: [NativePlayerRow] { edit?.apply(state.upcoming) ?? state.upcoming }

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
            if !next.active { self.stop(); self.close("close"); return }
            if next.entryId != self.state.entryId { self.scrub = nil }
            // shortcut: 20 s covers re-preparing a few tracks; a stuck page shows the host's order again after that.
            if let edit = self.edit, edit.landed(next.upcoming) || Date().timeIntervalSince(edit.at) > 20 { self.edit = nil }
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

    func jump(_ row: NativePlayerRow) { shell?.run("queueJump", ["entryId": row.id]) }
    func remove(_ offsets: IndexSet) {
        var rows = upcoming
        let gone = offsets.map { rows[$0].id }
        rows.remove(atOffsets: offsets)
        edit = NativeQueueEdit(order: rows.map(\.id), removed: Set(gone))
        for id in gone { shell?.run("queueRemove", ["entryId": id]) }
    }
    /// List.onMove semantics: `destination` is the slot before the move.
    func move(_ offsets: IndexSet, to destination: Int) {
        var rows = upcoming
        // Nothing goes ahead of the track already blending in.
        guard offsets.count == 1, let from = offsets.first, rows.indices.contains(from), !(state.blending && destination == 0) else { return }
        let id = rows[from].id, target = rows[min(rows.count - 1, destination > from ? destination - 1 : destination)].id
        guard id != target else { return }
        rows.move(fromOffsets: offsets, toOffset: destination)
        edit = NativeQueueEdit(order: rows.map(\.id))
        shell?.run("queueMove", ["entryId": id, "to": target])
    }
    /// Wave: the page puts the best tempo/key match from its reserve in place of the upcoming track.
    func swap() {
        guard let shell, let first = upcoming.first else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { @MainActor in
            do { _ = try await shell.call("swap") } catch { return } // refused (blend started, no Wave): the queue stays
            self.edit = NativeQueueEdit(order: [], removed: [first.id])
        }
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

/// The page's `react` (server, Yandex sync, dislike skips on in a Wave); the shell shows it at once.
private struct RatingButtons: View {
    @ObservedObject var shell: NativeShellStore
    let trackId: String
    var body: some View {
        if let track = shell.byId[trackId] {
            HStack(spacing: 0) {
                IconButton(symbol: track.reaction < 0 ? "hand.thumbsdown.fill" : "hand.thumbsdown",
                           label: track.reaction < 0 ? "Убрать «Не нравится»" : "Не нравится") { shell.react(track, track.reaction < 0 ? 0 : -1) }
                    .foregroundStyle(.white.opacity(track.reaction < 0 ? 1 : 0.7))
                IconButton(symbol: track.liked ? "heart.fill" : "heart",
                           label: track.liked ? "Убрать из любимого" : "Нравится") { shell.react(track, track.liked ? 0 : 1) }
                    .foregroundStyle(track.liked ? Color.moraMint : .white.opacity(0.7))
            }
        }
    }
}

/// Only in «Моя волна» (own or Yandex): elsewhere the next track is the listener's own choice.
private struct SwapButton: View {
    @ObservedObject var shell: NativeShellStore
    let enabled: Bool
    let action: () -> Void
    var body: some View {
        if shell.ui.wave.active == .own || shell.ui.wave.active == .yandex {
            IconButton(symbol: "arrow.triangle.2.circlepath", label: "Заменить следующий трек", action: action)
                .disabled(!enabled)
        }
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
    @State private var lyricsOpen = false
    @State private var versionTarget: NativeVersionTarget?

    var body: some View {
        let s = model.state
        VStack(spacing: 0) {
            HStack {
                IconButton(symbol: "chevron.down", label: "Свернуть плеер") { model.close("close") }
                Spacer()
                Text("Сейчас играет").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.6))
                    .accessibilityHidden(true)
                Spacer()
                Menu {
                    if model.shell != nil {
                        Button { lyricsOpen = true } label: { Label("Текст песни", systemImage: "quote.bubble") }
                        versionAction(s.entryId)
                    }
                    Button { model.close("more") } label: { Label("Полный плеер", systemImage: "rectangle.expand.vertical") }
                } label: {
                    Image(systemName: "ellipsis").font(.title3.weight(.semibold))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Ещё")
            }
            .padding(.horizontal, -10)
            Spacer(minLength: 12)
            cover(playing: s.playing)
            Spacer(minLength: 12)
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(s.title.isEmpty ? "MORA" : s.title).font(.title2.bold()).lineLimit(2)
                    Text(s.artist).font(.title3).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .contextMenu { versionAction(s.entryId) }
                if let shell = model.shell { RatingButtons(shell: shell, trackId: s.trackId) }
            }
            NativeScrubber(state: s, receivedAt: model.receivedAt, pending: model.scrub) { model.seek(to: $0) }
                .id(s.entryId).padding(.top, 18)
            transport(playing: s.playing).padding(.vertical, 6)
            if let label = s.nextLabel {
                Button { queueOpen = true } label: {
                    Label(label, systemImage: s.automix ? "sparkles" : "music.note.list")
                        .font(.footnote.weight(.medium)).lineLimit(1)
                        .padding(.horizontal, 14).frame(minHeight: 44)
                        .foregroundStyle(s.automix ? Color.moraGold : Color.white.opacity(0.8))
                        .background(s.automix ? Color.moraGold.opacity(0.14) : Color.white.opacity(0.08), in: Capsule())
                }
                .accessibilityHint("Открыть очередь")
            }
            HStack {
                RoutePicker().frame(width: 44, height: 44)
                Spacer()
                if let shell = model.shell {
                    SwapButton(shell: shell, enabled: !s.blending && !model.upcoming.isEmpty) { model.swap() }
                        .foregroundStyle(.white.opacity(0.7))
                }
                IconButton(symbol: "list.bullet", label: "Очередь") { queueOpen = true }
                    .foregroundStyle(.white.opacity(0.7))
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
        .sheet(isPresented: $queueOpen) { NativeQueueView(model: model) }
        .sheet(isPresented: $lyricsOpen) { NativeLyricsView(model: model) }
        .sheet(item: $versionTarget) { target in if let shell = model.shell { NativeVersionPicker(target: target, shell: shell) } }
    }

    @ViewBuilder private func versionAction(_ entryId: String) -> some View {
        if model.shell != nil {
            Button {
                versionTarget = NativeVersionTarget(args: ["entryId": entryId], title: model.state.title, artist: model.state.artist)
            } label: { Label("Выбрать версию", systemImage: "waveform") }
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
            .frame(maxWidth: 360)
            .overlay {
                if let image = model.artwork {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    ZStack {
                        Color.moraMint.opacity(0.12)
                        Image(systemName: "music.note").font(.system(size: 64)).foregroundStyle(.white.opacity(0.4))
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.6), radius: playing ? 30 : 14, y: playing ? 20 : 10)
            .scaleEffect(playing || reduceMotion ? 1 : 0.84)
            .animation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.75), value: playing)
            .contextMenu { versionAction(model.state.entryId) }
            .layoutPriority(-1)
            .accessibilityHidden(true)
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
                Image(systemName: playing ? "pause.fill" : "play.fill").font(.system(size: 34))
                    .foregroundStyle(Color.moraBackground)
                    .frame(width: 80, height: 80)
                    .background(Color.moraMint, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .shadow(color: Color.moraMint.opacity(0.5), radius: 18, y: 10)
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

private struct NativeQueueView: View {
    @ObservedObject var model: NativePlayerModel
    @Environment(\.dismiss) private var dismiss
    @State private var versionTarget: NativeVersionTarget?

    var body: some View {
        NavigationStack {
            List {
                let rows = model.upcoming, editable = model.shell != nil
                if rows.isEmpty {
                    Text("Очередь пуста").foregroundStyle(.secondary).listRowBackground(Color.clear)
                }
                ForEach(rows) { row in
                    // The track already blending in cannot be dropped or moved.
                    let locked = !editable || (model.state.blending && row.id == rows.first?.id)
                    Button { model.jump(row); dismiss() } label: {
                        HStack(spacing: 12) {
                            NativeCover(url: row.cover, size: 44, radius: 6)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title).font(.body.weight(.medium)).lineLimit(1)
                                Text(row.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                                if row.automix {
                                    HStack(spacing: 4) { Image(systemName: "sparkles"); Text("AutoMix") }
                                        .font(.caption.weight(.medium)).foregroundStyle(Color.moraGold)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!editable)
                    .contextMenu {
                        if editable {
                            Button {
                                versionTarget = NativeVersionTarget(args: ["entryId": row.id], title: row.title, artist: row.artist)
                            } label: { Label("Выбрать версию", systemImage: "waveform") }
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Играть сейчас")
                    // Drag reordering is not reachable with VoiceOver.
                    .accessibilityAction(named: "Выше") {
                        if !locked, let i = rows.firstIndex(of: row), i > 0 { model.move([i], to: i - 1) }
                    }
                    .accessibilityAction(named: "Ниже") {
                        if !locked, let i = rows.firstIndex(of: row), i + 1 < rows.count { model.move([i], to: i + 2) }
                    }
                    .deleteDisabled(locked)
                    .moveDisabled(locked)
                    .listRowBackground(Color.clear)
                }
                .onDelete { model.remove($0) }
                .onMove { model.move($0, to: $1) }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .navigationTitle("Далее")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.ultraThinMaterial)
        .sheet(item: $versionTarget) { target in if let shell = model.shell { NativeVersionPicker(target: target, shell: shell) } }
    }
}

/// Timeline: the finger owns the thumb while it drags (polls cannot pull it back), the clock runs on
/// between polls, and the gold band marks where the AutoMix transition into the next track plays.
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

/// Lyrics of the audible track (the page's lyrics source and saved offset): synced lines follow the native
/// clock and seek on tap; plain text otherwise.
private struct NativeLyricsView: View {
    @ObservedObject var model: NativePlayerModel
    @Environment(\.dismiss) private var dismiss
    @State private var lines: [(t: Double, text: String)] = []
    @State private var plain = ""
    @State private var status = "Загружаю текст…"

    var body: some View {
        NavigationStack {
            Group {
                if !lines.isEmpty {
                    TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                        let s = model.state
                        let now = s.position + (s.playing ? Date().timeIntervalSince(model.receivedAt) : 0)
                        let active = lines.lastIndex(where: { $0.t <= now })
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 16) {
                                    ForEach(lines.indices, id: \.self) { i in
                                        Button { model.seek(to: max(0, lines[i].t)) } label: {
                                            Text(lines[i].text.isEmpty ? "♪" : lines[i].text).font(.title3.weight(.semibold))
                                                .foregroundStyle(i == active ? Color.moraMint : .white.opacity(i < (active ?? -1) ? 0.4 : 0.75))
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                        }
                                        .buttonStyle(.plain)
                                        .accessibilityHint("Перейти к этой строке")
                                        .id(i)
                                    }
                                }
                                .padding(20)
                            }
                            .onChange(of: active) { _, i in
                                if let i { withAnimation(.easeInOut(duration: 0.3)) { proxy.scrollTo(i, anchor: .center) } }
                            }
                        }
                    }
                } else if !plain.isEmpty {
                    ScrollView { Text(plain).font(.body).frame(maxWidth: .infinity, alignment: .leading).padding(20) }
                } else {
                    Text(status).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(model.state.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } } }
        }
        .task(id: model.state.trackId) { await load(model.state.trackId) }
        .presentationDetents([.large])
        .presentationBackground(.ultraThinMaterial)
    }

    @MainActor private func load(_ id: String) async {
        lines = []; plain = ""; status = "Загружаю текст…"
        guard let shell = model.shell, !id.isEmpty else { status = "Текст недоступен"; return }
        do {
            let value = try await shell.call("lyrics", ["id": id]) as? [String: Any] ?? [:]
            if value["synced"] as? Bool == true {
                lines = (value["lines"] as? [[String: Any]] ?? []).compactMap { row in
                    (row["t"] as? Double).map { (t: $0, text: row["text"] as? String ?? "") }
                }
            }
            plain = value["plain"] as? String ?? ""
            if lines.isEmpty && plain.isEmpty { status = "Текст не найден" }
        } catch {
            status = "Не удалось загрузить текст"
        }
    }
}

/// What «Выбрать версию» was opened for: a library track (`id`) or a queue entry (`entryId`).
struct NativeVersionTarget: Identifiable {
    let id = UUID()
    let args: [String: Any]
    let title: String
    let artist: String
}

/// «Выбрать версию»: one source at a time; search, preview audio and the permanent binding run in the page
/// (lib/native-ui.ts `versions` / `versionPreview` / `versionApply`, the same logic as the web VersionPanel).
struct NativeVersionPicker: View {
    let target: NativeVersionTarget
    @ObservedObject var shell: NativeShellStore
    @Environment(\.dismiss) private var dismiss
    @State private var source = "youtube"
    @State private var items: [Item] = []
    @State private var bound = false
    @State private var status: String? = "Ищу версии…"
    @State private var chosen: String?
    @State private var playing: String?
    @State private var formats: [String: String] = [:]
    @State private var busy = false

    struct Item: Identifiable {
        let id: String, title: String, artist: String
        let duration: Double
        let cover: String?
        let explicit: Bool
        let labels: [String]
    }

    private var sources: [(id: String, name: String)] {
        [("youtube", "YouTube"), ("ytmusic", "YT Music"), ("soundcloud", "SoundCloud")] + (shell.ui.wave.yandex ? [("yandex", "Яндекс")] : [])
    }
    private var sourceName: String { sources.first { $0.id == source }?.name ?? "" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("\(target.artist) — \(target.title)").font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    Picker("Источник", selection: $source) {
                        ForEach(sources, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.segmented)
                }
                .listRowBackground(Color.clear)
                if let status { Text(status).foregroundStyle(.secondary).listRowBackground(Color.clear) }
                ForEach(items) { row($0) }
                if !items.isEmpty {
                    Text("«E» отмечает источник, остальные метки — по названию. Название и обложка трека не меняются.")
                        .font(.caption).foregroundStyle(.secondary).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .navigationTitle("Выбрать версию")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Закрыть") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else { Button("Выбрать") { apply(chosen) }.disabled(chosen == nil) }
                }
                if bound {
                    ToolbarItem(placement: .bottomBar) { Button("Вернуть исходную запись") { apply(nil) }.disabled(busy) }
                }
            }
        }
        .task(id: source) { await search() }
        .onDisappear { Task { @MainActor in _ = try? await shell.call("versionPreview", ["key": ""]) } }
        .presentationDetents([.large])
        .presentationBackground(.ultraThinMaterial)
        .preferredColorScheme(.dark)
    }

    private func row(_ item: Item) -> some View {
        HStack(spacing: 8) {
            Button { chosen = item.id } label: {
                HStack(spacing: 12) {
                    NativeCover(url: item.cover, size: 48, radius: 6)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.body.weight(.medium)).lineLimit(1)
                        if item.explicit || !item.labels.isEmpty {
                            HStack(spacing: 4) {
                                if item.explicit { badge("E") }
                                ForEach(item.labels, id: \.self) { badge($0) }
                            }
                        }
                        Text(details(item)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if chosen == item.id { Image(systemName: "checkmark").foregroundStyle(Color.moraMint) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(chosen == item.id ? .isSelected : [])
            Button { preview(item.id) } label: {
                Image(systemName: playing == item.id ? "stop.fill" : "play.fill").frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(playing == item.id ? "Остановить прослушивание" : "Прослушать: \(item.title)")
        }
        .listRowBackground(Color.clear)
    }

    private func badge(_ text: String) -> some View {
        Text(text).font(.caption2.weight(.bold)).padding(.horizontal, 5).padding(.vertical, 1)
            .background(Color.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
    }

    private func details(_ item: Item) -> String {
        let seconds = Int(item.duration.rounded())
        return ([item.artist, sourceName, String(format: "%d:%02d", seconds / 60, seconds % 60), formats[item.id]] as [String?])
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    @MainActor private func search() async {
        let wanted = source
        items = []; chosen = nil; status = "Ищу версии…"
        if playing != nil { playing = nil; _ = try? await shell.call("versionPreview", ["key": ""]) }
        do {
            let value = try await shell.call("versions", target.args.merging(["source": wanted]) { $1 }, timeout: 40) as? [String: Any] ?? [:]
            guard wanted == source else { return }
            bound = value["bound"] as? Bool == true
            items = (value["items"] as? [[String: Any]] ?? []).compactMap { v in
                guard let key = v["key"] as? String else { return nil }
                return Item(id: key, title: v["title"] as? String ?? "", artist: v["artist"] as? String ?? "", duration: v["duration"] as? Double ?? 0,
                            cover: v["cover"] as? String, explicit: v["explicit"] as? Bool == true, labels: v["labels"] as? [String] ?? [])
            }
            status = items.isEmpty ? "Ничего не нашлось" : nil
        } catch {
            if wanted == source { status = wanted == "yandex" ? "Яндекс Музыка не ответила. Аккаунт подключён?" : "Поиск не удался. Попробуйте ещё раз." }
        }
    }

    private func preview(_ key: String) {
        let next = playing == key ? "" : key
        playing = next.isEmpty ? nil : next
        Task { @MainActor in
            do {
                let value = try await shell.call("versionPreview", ["key": next], timeout: 60) as? [String: Any]
                if let format = value?["format"] as? String, !format.isEmpty { formats[key] = format }
            } catch {
                if playing == key { playing = nil }
            }
        }
    }

    private func apply(_ key: String?) {
        busy = true
        var args = target.args
        if let key { args["key"] = key }
        Task { @MainActor in
            do { _ = try await shell.call("versionApply", args, timeout: 90); dismiss() }
            catch { busy = false; status = "Не удалось применить версию. Попробуйте ещё раз." }
        }
    }
}
