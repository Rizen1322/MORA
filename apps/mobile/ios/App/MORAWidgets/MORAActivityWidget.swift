import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

private struct ActivityControls: View {
    let state: NativeActivityState
    var body: some View {
        HStack(spacing: 28) {
            Button(intent: NativePlaybackActionIntent(action: .toggle)) { Label(state.isPlaying ? "Пауза" : "Продолжить", systemImage: state.isPlaying ? "pause.fill" : "play.fill") }
            Button(intent: NativePlaybackActionIntent(action: .next)) { Label("Следующий", systemImage: "forward.end.fill") }
            Button(intent: NativePlaybackActionIntent(action: .like)) { Label("Нравится", systemImage: state.liked ? "heart.fill" : "heart") }
        }.labelStyle(.iconOnly).tint(.mint).buttonStyle(.bordered)
    }
}

private struct ActivityProgress: View {
    let state: NativeActivityState
    var body: some View {
        if state.isPlaying && state.duration > state.position {
            ProgressView(timerInterval: Date().addingTimeInterval(-state.position)...Date().addingTimeInterval(state.duration - state.position), countsDown: false).labelsHidden().tint(.mint)
        } else {
            ProgressView(value: state.position, total: max(1, state.duration)).tint(.mint)
        }
    }
}

private struct ActivityTrack: View {
    let state: NativeActivityState
    var body: some View {
        HStack {
            if let name = state.artwork,
               let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: NativeWidgetData.group),
               let image = UIImage(contentsOfFile: root.appendingPathComponent(name).path) {
                Image(uiImage: image).resizable().scaledToFill().frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 6))
            } else { Image(systemName: "waveform").frame(width: 40, height: 40).foregroundStyle(.mint) }
            VStack(alignment: .leading) {
                Text(state.title).font(.headline).lineLimit(1)
                Text(state.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            if state.offline { Label("Нет сети", systemImage: "wifi.slash").font(.caption).labelStyle(.iconOnly) }
        }
    }
}

struct MoraActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NativeActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 10) {
                Text(context.attributes.station).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                ActivityTrack(state: context.state)
                ActivityProgress(state: context.state)
                ActivityControls(state: context.state)
            }.padding().activityBackgroundTint(Color(red: 5 / 255, green: 13 / 255, blue: 10 / 255)).activitySystemActionForegroundColor(.mint)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) { ActivityTrack(state: context.state) }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack { ActivityProgress(state: context.state); ActivityControls(state: context.state) }
                }
            } compactLeading: {
                Image(systemName: context.state.isPlaying ? "waveform" : "pause.fill").foregroundStyle(.mint)
            } compactTrailing: {
                Image(systemName: context.state.liked ? "heart.fill" : "music.note").foregroundStyle(.mint)
            } minimal: {
                Image(systemName: context.state.isPlaying ? "waveform" : "pause.fill").foregroundStyle(.mint)
            }.widgetURL(URL(string: "mora://player"))
        }
    }
}

@available(iOSApplicationExtension 18.0, *)
struct MoraPlaybackControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "mora.playback") {
            ControlWidgetButton(action: NativePlaybackActionIntent(action: .toggle)) {
                Label("Пауза / продолжить", systemImage: "playpause.fill")
            }
        }.displayName("Плеер MORA").description("Пауза или продолжение нативного воспроизведения.")
    }
}
