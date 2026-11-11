import SwiftUI
import UIKit

struct NativeSoundView: View {
    @EnvironmentObject private var store: NativeShellStore
    @State private var sound: NativeSoundState?
    @State private var draft: [Int: Double] = [:]
    @State private var editing = false
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                        Button("Обновить настройки") { Task { await load() } }.disabled(busy || editing)
                    }
                }
                if let sound {
                    controls(sound)
                    Section("Полосы") {
                        ForEach(NativeSoundState.bands.indices, id: \.self) { index in band(index, sound) }
                    }
                } else if failure == nil { ProgressView("Загружаем настройки звука…") }
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
                    await load()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in Task { await load() } }
        }
    }
    private func controls(_ sound: NativeSoundState) -> some View {
        Section {
            Toggle("Эквалайзер", isOn: Binding(get: { sound.enabled }, set: { save(.enabled($0)) }))
                .accessibilityIdentifier("native-sound-enabled")
            Picker("Пресет", selection: Binding(get: { sound.selectedPreset ?? -1 }, set: { index in
                guard sound.presets.indices.contains(index) else { return }
                save(.preset(sound.presets[index]))
            })) {
                if sound.selectedPreset == nil { Text("Свой").tag(-1) }
                ForEach(sound.presets.indices, id: \.self) { Text(sound.presets[$0].name).tag($0) }
            }.pickerStyle(.menu).accessibilityIdentifier("native-sound-preset")
        } footer: { Text("Вывод звука (AirPlay, Bluetooth) выбирается кнопкой в плеере.") }
            .disabled(busy || editing)
    }
    private func band(_ index: Int, _ sound: NativeSoundState) -> some View {
        let label = NativeSoundState.bandLabel(NativeSoundState.bands[index])
        let value = draft[index] ?? sound.gains[index]
        let detail = String(format: "%.1f дБ", value)
        return VStack(alignment: .leading, spacing: 8) {
            HStack { Text(label); Spacer(); Text(detail).monospacedDigit().foregroundStyle(.secondary) }
            Slider(value: Binding(get: { draft[index] ?? sound.gains[index] }, set: { draft[index] = $0 }),
                   in: -NativeSoundState.maxDB...NativeSoundState.maxDB, step: 0.5,
                   onEditingChanged: { active in
                editing = active
                if !active, let value = draft[index] { save(.band(index, value)) }
            })
            .accessibilityLabel(label).accessibilityValue(detail)
            .accessibilityIdentifier("native-sound-band-\(index)")
        }.disabled(busy)
    }
    @MainActor private func load() async {
        guard !busy, !editing else { return }
        busy = true
        defer { busy = false }
        do {
            let response = try await NativeServerApp.request("GET", "/api/settings")
            guard !Task.isCancelled else { return }
            sound = try NativeSoundState(response)
            draft = [:]; failure = nil
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
    private func save(_ edit: NativeSoundState.Edit) {
        guard !busy, sound != nil else { return }
        busy = true; failure = nil
        Task { @MainActor in
            defer { busy = false; draft = [:] }
            do {
                let latest = try await NativeServerApp.request("GET", "/api/settings")
                let state = try NativeSoundState(latest)
                let response = try await NativeServerApp.request("PUT", "/api/settings", body: state.patch(edit))
                sound = try NativeSoundState(response)
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
