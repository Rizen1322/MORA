import SwiftUI
import MediaPlayer

struct MiniPlayer: View {
    let library: LocalLibrary
    @ObservedObject var player: NativePlayer
    let expand: () -> Void
    var body: some View {
        if let track = player.current {
            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    Button(action: expand) {
                        HStack(spacing: 12) {
                            Artwork(track: track, library: library).frame(width: 46, height: 46).clipShape(RoundedRectangle(cornerRadius: 10))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(track.title).font(.subheadline.weight(.bold)).foregroundStyle(MORAStyle.text).lineLimit(1)
                                Text(track.artist).font(.caption).foregroundStyle(MORAStyle.secondary).lineLimit(1)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Открыть плеер: \(track.title), \(track.artist)")
                    Button { player.toggle() } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 18, weight: .semibold))
                            .frame(width: 46, height: 46).background(MORAStyle.accent, in: RoundedRectangle(cornerRadius: 15))
                            .foregroundStyle(MORAStyle.onAccent)
                    }.accessibilityLabel(player.isPlaying ? "Пауза" : "Продолжить")
                    Button { player.next() } label: { Image(systemName: "forward.end.fill").frame(width: 44, height: 46) }
                        .accessibilityLabel("Следующий трек")
                }.padding(10)
                ProgressView(value: min(max(0, player.position), track.duration), total: max(1, track.duration))
                    .tint(MORAStyle.accent).accessibilityHidden(true)
            }
            .background(MORAStyle.raised, in: RoundedRectangle(cornerRadius: 22))
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(MORAStyle.line) }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
    }
}

struct PlayerView: View {
    @ObservedObject var library: LocalLibrary
    @ObservedObject var player: NativePlayer
    @Environment(\.dismiss) private var dismiss
    @State private var seeking: Double?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let track = player.current {
                    VStack(alignment: .leading, spacing: 24) {
                        Artwork(track: track, library: library).aspectRatio(1, contentMode: .fit)
                            .frame(maxWidth: 340).clipShape(RoundedRectangle(cornerRadius: 26)).frame(maxWidth: .infinity)
                        HStack(alignment: .top, spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(track.title).font(.system(.title, design: .rounded, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                                Text(track.artist).font(.title3).foregroundStyle(MORAStyle.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Button { library.toggleLike(track) } label: {
                                Image(systemName: liked(track) ? "heart.fill" : "heart").font(.title2).frame(minWidth: 44, minHeight: 44)
                            }.accessibilityLabel(liked(track) ? "Убрать из любимого" : "В любимое")
                        }
                        VStack(spacing: 4) {
                            Slider(value: Binding(get: { seeking ?? player.position }, set: { seeking = $0 }), in: 0...max(1, track.duration), onEditingChanged: { editing in
                                if !editing, let value = seeking { player.seek(value); seeking = nil }
                            }).accessibilityLabel("Позиция в треке")
                            HStack { Text(playbackTime(seeking ?? player.position)); Spacer(); Text(playbackTime(track.duration)) }
                                .font(.caption.monospacedDigit()).foregroundStyle(MORAStyle.secondary)
                        }
                        HStack(spacing: 24) {
                            Spacer(minLength: 0)
                            Button { player.previous() } label: {
                                Image(systemName: "backward.end.fill").font(.system(size: 24)).frame(width: 52, height: 52)
                                    .background(MORAStyle.raised, in: RoundedRectangle(cornerRadius: 18))
                            }.accessibilityLabel("Предыдущий трек")
                            Button { player.toggle() } label: {
                                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 28, weight: .semibold))
                                    .frame(width: 76, height: 76).background(MORAStyle.accent, in: RoundedRectangle(cornerRadius: 25))
                                    .foregroundStyle(MORAStyle.onAccent)
                            }.accessibilityLabel(player.isPlaying ? "Пауза" : "Продолжить")
                            Button { player.next() } label: {
                                Image(systemName: "forward.end.fill").font(.system(size: 24)).frame(width: 52, height: 52)
                                    .background(MORAStyle.raised, in: RoundedRectangle(cornerRadius: 18))
                            }.accessibilityLabel("Следующий трек")
                            Spacer(minLength: 0)
                        }
                        SystemVolume().frame(height: 44).accessibilityLabel("Системная громкость и устройство вывода")
                        Label("Сохранено на iPhone", systemImage: "checkmark.circle.fill")
                            .font(.footnote).foregroundStyle(MORAStyle.secondary).frame(maxWidth: .infinity)
                    }.padding(24).frame(maxWidth: 460).frame(maxWidth: .infinity)
                }
            }
            .background {
                LinearGradient(colors: [MORAStyle.raised, MORAStyle.background], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            }
            .foregroundStyle(MORAStyle.text)
            .navigationTitle("Сейчас играет").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "chevron.down").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Свернуть плеер")
                }
            }
        }.tint(MORAStyle.accent).onChange(of: player.current?.id) { _, _ in seeking = nil }
    }

    private func liked(_ track: LocalTrack) -> Bool { library.tracks.first(where: { $0.id == track.id })?.liked == true }
}

private struct SystemVolume: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView { MPVolumeView(frame: .zero) }
    func updateUIView(_ view: MPVolumeView, context: Context) {}
}
