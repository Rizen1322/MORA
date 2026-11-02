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

    func refresh() {
        host.playerState { [weak self] result in
            guard let self, case .success(let value) = result else { return }
            let next = NativePlayerState(value)
            if !next.active { self.stop(); self.close("close"); return }
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
        host.command(action, time: time, source: "player") { [weak self] _ in then?(); self?.refresh() }
    }
    func transport(_ action: String) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if action == "play" || action == "pause" { state.playing = action == "play" }
        send(action)
    }
    func seek(to time: Double) {
        scrub = time
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        send("seekto", time: time) { [weak self] in self?.scrub = nil }
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

    var body: some View {
        let s = model.state
        VStack(spacing: 0) {
            HStack {
                IconButton(symbol: "chevron.down", label: "Свернуть плеер") { model.close("close") }
                Spacer()
                Text("Сейчас играет").font(.footnote.weight(.semibold)).foregroundStyle(.white.opacity(0.6))
                    .accessibilityHidden(true)
                Spacer()
                IconButton(symbol: "ellipsis", label: "Ещё: нравится, текст песни") { model.close("more") }
            }
            .padding(.horizontal, -10)
            Spacer(minLength: 12)
            cover(playing: s.playing)
            Spacer(minLength: 12)
            VStack(alignment: .leading, spacing: 4) {
                Text(s.title.isEmpty ? "MORA" : s.title).font(.title2.bold()).lineLimit(2)
                Text(s.artist).font(.title3).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            NativeScrubber(state: s, receivedAt: model.receivedAt, pending: model.scrub) { model.seek(to: $0) }.padding(.top, 18)
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

    var body: some View {
        NavigationStack {
            List {
                if model.state.upcoming.isEmpty {
                    Text("Очередь пуста").foregroundStyle(.secondary).listRowBackground(Color.clear)
                }
                ForEach(model.state.upcoming) { row in
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
                    }
                    .frame(minHeight: 56)
                    .accessibilityElement(children: .combine)
                    .listRowBackground(Color.clear)
                }
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
