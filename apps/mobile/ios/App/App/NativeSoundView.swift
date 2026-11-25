import SwiftUI
import UIKit

struct NativeSoundView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var sound: NativeSoundState?
    @State private var draft: [Int: Double] = [:]
    @State private var draftSpeed: Double?
    @State private var draftSemitones: Double?
    @State private var draftBalance: Double?
    @State private var draftReverb: Double?
    @State private var pendingEnabled: Bool?
    @State private var pendingPreset: Int?
    @State private var pendingMono: Bool?
    @State private var editing = false
    @State private var busy = false
    @State private var loading = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                        Button("Обновить настройки") { Task { await load() } }.disabled(busy || editing)
                    }.listRowBackground(Color.moraSurface)
                }
                if let sound {
                    controls(sound)
                    playbackSection(sound)
                    stageSection(sound)
                    Section("Полосы") {
                        ForEach(NativeSoundState.bands.indices, id: \.self) { index in band(index, sound) }
                    }.listRowBackground(Color.moraSurface)
                } else if failure == nil { ProgressView("Загружаем настройки звука…").listRowBackground(Color.clear) }
                Section { Color.clear.frame(height: 56).listRowBackground(Color.clear) }
            }
            .scrollContentBackground(.hidden)
            .background(Color.moraBackground)
            .tint(Color.moraMint)
            .navigationTitle("Звук")
            .accessibilityIdentifier("native-sound-screen")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { store.back() } label: { Label("Назад", systemImage: "chevron.backward") } }
                if busy { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
            }
            .refreshable { await load() }
            .task {
                await load()
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(10)) } catch { return }
                    await load(silent: true)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in Task { await load(silent: true) } }
        }
    }
    private func controls(_ sound: NativeSoundState) -> some View {
        Section {
            Toggle("Эквалайзер", isOn: Binding(get: { pendingEnabled ?? sound.enabled }, set: { save(.enabled($0)) }))
                .accessibilityIdentifier("native-sound-enabled")
            Picker("Пресет", selection: Binding(get: { pendingPreset ?? sound.selectedPreset ?? -1 }, set: { index in
                guard sound.presets.indices.contains(index) else { return }
                pendingPreset = index
                pendingEnabled = true
                save(.preset(sound.presets[index]))
            })) {
                if sound.selectedPreset == nil { Text("Свой").tag(-1) }
                ForEach(sound.presets.indices, id: \.self) { Text(sound.presets[$0].name).tag($0) }
            }.pickerStyle(.menu).accessibilityIdentifier("native-sound-preset")
            NativeEQCurveView(
                gains: displayedGains(sound),
                enabled: pendingEnabled ?? sound.enabled
            )
            .listRowSeparator(.hidden)
        } footer: { Text("Вывод звука (AirPlay, Bluetooth) выбирается кнопкой в плеере.") }
            .listRowBackground(Color.moraSurface)
            .disabled(busy || editing)
    }
    private func playbackSection(_ sound: NativeSoundState) -> some View {
        let speedValue = draftSpeed ?? sound.speed
        let semitonesValue = draftSemitones ?? sound.semitones
        return Section("Скорость и тон") {
            sliderRow(
                "Скорость",
                detail: String(format: "%.2f×", speedValue),
                draft: $draftSpeed,
                committed: sound.speed,
                range: NativeSoundState.speedRange,
                step: 0.05,
                identifier: "native-sound-speed"
            ) { .speed($0) }
            sliderRow(
                "Высота тона",
                detail: Self.semitonesText(semitonesValue),
                draft: $draftSemitones,
                committed: sound.semitones,
                range: NativeSoundState.semitonesRange,
                step: 0.5,
                identifier: "native-sound-semitones"
            ) { .semitones($0) }
            if abs(sound.speed - 1.0) > 0.001 || abs(sound.semitones) > 0.01 {
                Button("Сбросить скорость и тон") { save(.resetPlayback) }
                    .foregroundStyle(Color.moraMint)
                    .disabled(busy || editing)
                    .accessibilityIdentifier("native-sound-reset-playback")
            }
        }.listRowBackground(Color.moraSurface)
    }
    private func stageSection(_ sound: NativeSoundState) -> some View {
        let balanceValue = draftBalance ?? sound.balance
        let reverbValue = draftReverb ?? sound.reverbMix
        return Section("Сцена и баланс") {
            sliderRow(
                "Баланс",
                detail: Self.balanceText(balanceValue),
                draft: $draftBalance,
                committed: sound.balance,
                range: NativeSoundState.balanceRange,
                step: 0.05,
                identifier: "native-sound-balance"
            ) { .balance($0) }
            Toggle(isOn: Binding(get: { pendingMono ?? sound.mono }, set: { save(.mono($0)) })) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Моно")
                    Text("Сводить оба канала в один").font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("native-sound-mono")
            .disabled(busy || editing)
            sliderRow(
                "Пространство",
                detail: Self.reverbText(reverbValue),
                draft: $draftReverb,
                committed: sound.reverbMix,
                range: NativeSoundState.reverbRange,
                step: 0.01,
                identifier: "native-sound-reverb"
            ) { .reverbMix($0) }
            if abs(sound.balance) > 0.01 || sound.mono || sound.reverbMix > 0.005 {
                Button("Сбросить сцену") { save(.resetTone) }
                    .foregroundStyle(Color.moraMint)
                    .disabled(busy || editing)
                    .accessibilityIdentifier("native-sound-reset-tone")
            }
        }.listRowBackground(Color.moraSurface)
    }
    private func displayedGains(_ sound: NativeSoundState) -> [Double] {
        let presetGains: [Double]? = pendingPreset.flatMap { index in
            sound.presets.indices.contains(index) ? sound.presets[index].gains : nil
        }
        return NativeSoundState.bands.indices.map { index in
            if let value = draft[index] { return value }
            if let presetGains, presetGains.indices.contains(index) { return presetGains[index] }
            return sound.gains.indices.contains(index) ? sound.gains[index] : 0
        }
    }
    private func band(_ index: Int, _ sound: NativeSoundState) -> some View {
        let label = NativeSoundState.bandLabel(NativeSoundState.bands[index])
        let value = draft[index] ?? sound.gains[index]
        return sliderRow(
            label,
            detail: String(format: "%.1f дБ", value),
            draft: Binding(get: { draft[index] }, set: { draft[index] = $0 }),
            committed: sound.gains[index],
            range: -NativeSoundState.maxDB...NativeSoundState.maxDB,
            step: 0.5,
            identifier: "native-sound-band-\(index)"
        ) { .band(index, $0) }
    }
    private func sliderRow(
        _ title: String,
        detail: String,
        draft: Binding<Double?>,
        committed: Double,
        range: ClosedRange<Double>,
        step: Double,
        identifier: String,
        commit: @escaping (Double) -> NativeSoundState.Edit
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(title); Spacer(); Text(detail).monospacedDigit().foregroundStyle(.secondary) }
            Slider(value: Binding(get: { draft.wrappedValue ?? committed }, set: { draft.wrappedValue = $0 }),
                   in: range, step: step,
                   onEditingChanged: { active in
                editing = active
                if !active, let value = draft.wrappedValue { save(commit(value)) }
            })
            .accessibilityLabel(title).accessibilityValue(detail)
            .accessibilityIdentifier(identifier)
        }.disabled(busy)
    }
    private static func semitonesText(_ value: Double) -> String {
        let v = abs(value) < 0.05 ? 0.0 : value
        if v == 0 { return "0 пт" }
        let sign = v > 0 ? "+" : "−"
        let mag = abs(v)
        if abs(mag - mag.rounded()) < 0.05 { return "\(sign)\(Int(mag.rounded())) пт" }
        return "\(sign)" + String(format: "%.1f пт", mag)
    }
    private static func balanceText(_ value: Double) -> String {
        if abs(value) <= 0.01 { return "Центр" }
        let percent = Int((abs(value) * 100).rounded())
        return value < 0 ? "Л \(percent)%" : "П \(percent)%"
    }
    private static func reverbText(_ value: Double) -> String {
        let clamped = min(NativeSoundState.reverbRange.upperBound, max(NativeSoundState.reverbRange.lowerBound, value))
        return "\(Int((clamped * 100).rounded()))%"
    }
    @MainActor private func clearDrafts() {
        draft = [:]
        draftSpeed = nil
        draftSemitones = nil
        draftBalance = nil
        draftReverb = nil
        pendingEnabled = nil
        pendingPreset = nil
        pendingMono = nil
    }
    @MainActor private func load(silent: Bool = false) async {
        guard !busy, !loading, !editing else { return }
        if silent { loading = true } else { busy = true }
        defer { if silent { loading = false } else { busy = false } }
        do {
            let response = try await NativeServerApp.request("GET", "/api/settings")
            guard !Task.isCancelled else { return }
            sound = try NativeSoundState(response)
            clearDrafts(); failure = nil
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
    private func save(_ edit: NativeSoundState.Edit) {
        guard !busy, sound != nil else { return }
        switch edit {
        case .enabled(let enabled): pendingEnabled = enabled
        case .mono(let mono):
            pendingMono = mono
            if mono { pendingEnabled = true }
        case .balance(let value) where abs(value) >= 0.025:
            pendingEnabled = true
        case .reverbMix(let value) where value >= 0.005:
            pendingEnabled = true
        default: break
        }
        busy = true; failure = nil
        Task { @MainActor in
            defer { busy = false; clearDrafts() }
            do {
                let latest = try await NativeServerApp.request("GET", "/api/settings")
                let state = try NativeSoundState(latest)
                let response = try await NativeServerApp.request("PUT", "/api/settings", body: state.patch(edit))
                if let sound = response["sound"] as? [String: Any], let tone = sound["tone"] {
                    NativeMixHost.shared.settings(["tone": tone]) { _ in }
                }
                sound = try NativeSoundState(response)
                if NativeMixHost.shared.active, let soundObj = response["sound"] as? [String: Any] {
                    var mixValues: [String: Any] = [:]
                    if let tone = soundObj["tone"] as? [String: Any] { mixValues["tone"] = tone }
                    if let playback = soundObj["playback"] as? [String: Any] { mixValues["playback"] = playback }
                    if !mixValues.isEmpty {
                        NativeMixHost.shared.settings(mixValues) { _ in }
                    }
                }
            } catch {
                let saveError = error.localizedDescription
                // Re-read after an uncertain write; never persist an old snapshot as a rollback.
                do {
                    let response = try await NativeServerApp.request("GET", "/api/settings")
                    sound = try NativeSoundState(response)
                }
                catch { sound = nil }
                failure = "Не удалось подтвердить сохранение: \(saveError)"
            }
        }
    }
}

/// Interactive 10-band equalizer curve drawn from live slider drafts or committed gains.
private struct NativeEQCurveView: View {
    let gains: [Double]
    let enabled: Bool

    private static let tickLabels = ["31", "125", "1к", "4к", "16к"]

    var body: some View {
        VStack(spacing: 6) {
            Canvas { context, size in
                let hPad: CGFloat = 12
                let topPad: CGFloat = 14
                let bottomPad: CGFloat = 14
                let plotHeight = max(1, size.height - topPad - bottomPad)
                let midY = topPad + plotHeight / 2
                let lineStartX = hPad - 4
                let lineEndX = size.width - hPad + 4

                for db in [6.0, -6.0] {
                    let y = midY - CGFloat(db / NativeSoundState.maxDB) * (plotHeight / 2)
                    var grid = Path()
                    grid.move(to: CGPoint(x: lineStartX, y: y))
                    grid.addLine(to: CGPoint(x: lineEndX, y: y))
                    context.stroke(grid, with: .color(Color.white.opacity(0.07)), lineWidth: 0.75)
                }

                var zeroLine = Path()
                zeroLine.move(to: CGPoint(x: lineStartX, y: midY))
                zeroLine.addLine(to: CGPoint(x: lineEndX, y: midY))
                context.stroke(
                    zeroLine,
                    with: .color(Color.white.opacity(0.16)),
                    style: StrokeStyle(lineWidth: 1, dash: [4, 4])
                )

                let points = Self.points(for: gains, size: size, hPad: hPad, topPad: topPad, bottomPad: bottomPad)
                guard !points.isEmpty else { return }

                let curve = Self.smoothPath(through: points)
                let accent = enabled ? Color.moraMint : Color.white.opacity(0.38)

                if let first = points.first, let last = points.last {
                    var fill = curve
                    fill.addLine(to: CGPoint(x: last.x, y: size.height))
                    fill.addLine(to: CGPoint(x: first.x, y: size.height))
                    fill.closeSubpath()
                    let topFill = enabled ? Color.moraMint.opacity(0.28) : Color.white.opacity(0.08)
                    let minY = points.map(\.y).min() ?? topPad
                    context.fill(
                        fill,
                        with: .linearGradient(
                            Gradient(colors: [topFill, .clear]),
                            startPoint: CGPoint(x: 0, y: minY),
                            endPoint: CGPoint(x: 0, y: size.height)
                        )
                    )
                }

                context.stroke(
                    curve,
                    with: .color(accent),
                    style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round)
                )

                for pt in points {
                    let halo = Path(ellipseIn: CGRect(x: pt.x - 4, y: pt.y - 4, width: 8, height: 8))
                    context.fill(halo, with: .color(Color.moraBackground.opacity(0.6)))
                    let dot = Path(ellipseIn: CGRect(x: pt.x - 3, y: pt.y - 3, width: 6, height: 6))
                    context.fill(dot, with: .color(accent))
                }
            }
            .frame(height: 116)
            .background(Color.moraSurfaceElevated.opacity(0.65), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.1), lineWidth: 0.75))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            HStack {
                ForEach(Self.tickLabels, id: \.self) { label in
                    Text(label)
                    if label != Self.tickLabels.last { Spacer(minLength: 4) }
                }
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.white.opacity(0.45))
            .padding(.horizontal, 6)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Кривая эквалайзера")
        .accessibilityIdentifier("native-sound-eq-curve")
    }

    private static func points(for gains: [Double], size: CGSize, hPad: CGFloat, topPad: CGFloat, bottomPad: CGFloat) -> [CGPoint] {
        guard !gains.isEmpty else { return [] }
        let plotWidth = max(1, size.width - hPad * 2)
        let plotHeight = max(1, size.height - topPad - bottomPad)
        let midY = topPad + plotHeight / 2
        let maxDB = NativeSoundState.maxDB
        return gains.enumerated().map { index, gain in
            let x = gains.count > 1
                ? hPad + CGFloat(index) / CGFloat(gains.count - 1) * plotWidth
                : size.width / 2
            let clamped = min(maxDB, max(-maxDB, gain.isFinite ? gain : 0))
            let y = midY - CGFloat(clamped / maxDB) * (plotHeight / 2)
            return CGPoint(x: x, y: y)
        }
    }

    private static func smoothPath(through points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        let n = points.count
        guard n > 1 else { return path }
        if n == 2 {
            path.addLine(to: points[1])
            return path
        }

        // Monotone cubic Hermite (Fritsch–Carlson) so the curve passes through every band dot without overshoot.
        var deltas = [CGFloat](repeating: 0, count: n - 1)
        for i in 0..<(n - 1) {
            deltas[i] = points[i + 1].y - points[i].y
        }
        var tangents = [CGFloat](repeating: 0, count: n)
        tangents[0] = deltas[0]
        tangents[n - 1] = deltas[n - 2]
        for i in 1..<(n - 1) {
            let prev = deltas[i - 1], next = deltas[i]
            tangents[i] = (prev * next <= 0) ? 0 : (prev + next) / 2
        }
        for i in 0..<(n - 1) {
            let d = deltas[i]
            if abs(d) < 1e-6 {
                tangents[i] = 0
                tangents[i + 1] = 0
                continue
            }
            let a = tangents[i] / d
            let b = tangents[i + 1] / d
            let magSq = a * a + b * b
            if magSq > 9 {
                let scale = 3 / sqrt(magSq)
                tangents[i] = scale * a * d
                tangents[i + 1] = scale * b * d
            }
        }
        for i in 0..<(n - 1) {
            let p0 = points[i], p1 = points[i + 1]
            let dx = (p1.x - p0.x) / 3
            let c1 = CGPoint(x: p0.x + dx, y: p0.y + tangents[i] / 3)
            let c2 = CGPoint(x: p1.x - dx, y: p1.y - tangents[i + 1] / 3)
            path.addCurve(to: p1, control1: c1, control2: c2)
        }
        return path
    }
}
