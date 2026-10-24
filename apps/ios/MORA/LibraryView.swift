import SwiftUI

struct LibraryView: View {
    @ObservedObject var library: LocalLibrary
    let player: NativePlayer
    @Binding var likedOnly: Bool
    let searching: Bool
    let addFiles: () -> Void
    @State private var query = ""

    private var tracks: [LocalTrack] {
        library.tracks.filter { (!likedOnly || $0.liked) && $0.matches(query) }
    }

    var body: some View {
        List {
            if !searching {
                Picker("Раздел медиатеки", selection: $likedOnly) {
                    Text("Все треки").tag(false)
                    Text("Любимое").tag(true)
                }.pickerStyle(.segmented).listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            if tracks.isEmpty {
                ContentUnavailableView {
                    Label(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? (likedOnly ? "Твоё любимое" : "Твоя музыка здесь") : "Ничего не найдено", systemImage: likedOnly ? "heart" : "music.note")
                } description: {
                    Text(library.tracks.isEmpty ? "Добавь аудиофайлы. Они сохранятся на iPhone." : (likedOnly && query.isEmpty ? "Отмечай треки сердечком в плеере или смахни строку вправо." : "Попробуй другое название или исполнителя."))
                } actions: {
                    if library.tracks.isEmpty {
                        Button("Добавить музыку", action: addFiles).buttonStyle(.borderedProminent)
                            .foregroundStyle(MORAStyle.onAccent).disabled(library.importing)
                    }
                }.listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            ForEach(tracks) { track in
                TrackRow(track: track, library: library) { player.play(track, from: tracks, library: library) }
                    .listRowSeparator(.hidden)
                    .swipeActions(edge: .leading) {
                        Button { library.toggleLike(track) } label: {
                            Label(track.liked ? "Убрать из любимого" : "В любимое", systemImage: track.liked ? "heart.slash" : "heart.fill")
                        }.tint(MORAStyle.accent)
                    }
                    .contextMenu {
                        Button { library.toggleLike(track) } label: {
                            Label(track.liked ? "Убрать из любимого" : "В любимое", systemImage: track.liked ? "heart.slash" : "heart")
                        }
                    }
            }
            .listRowBackground(Color.clear)
        }
        .listStyle(.plain).scrollContentBackground(.hidden).background(MORAStyle.background)
        .foregroundStyle(MORAStyle.text)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Трек или исполнитель")
        .scrollDismissesKeyboard(.interactively)
    }
}

struct TrackRow: View {
    let track: LocalTrack
    let library: LocalLibrary
    let play: () -> Void
    var body: some View {
        Button(action: play) {
            HStack(spacing: 12) {
                Artwork(track: track, library: library).frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text(track.title).font(.body.weight(.semibold)).foregroundStyle(MORAStyle.text).lineLimit(2)
                    Text(track.artist).font(.subheadline).foregroundStyle(MORAStyle.secondary).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(spacing: 6) {
                    if track.liked { Image(systemName: "heart.fill").foregroundStyle(MORAStyle.accent).accessibilityLabel("В любимом") }
                    Text(playbackTime(track.duration)).font(.caption.monospacedDigit()).foregroundStyle(MORAStyle.secondary)
                }
            }.padding(.vertical, 4).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityHint("Воспроизвести трек")
    }
}
