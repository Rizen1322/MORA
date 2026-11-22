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
