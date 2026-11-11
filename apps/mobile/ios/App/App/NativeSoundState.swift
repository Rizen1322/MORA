import Foundation
import CoreFoundation

/// The native /sound screen edits only EQ; playback and the rest of tone stay server-owned.
struct NativeSoundState {
    static let bands = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    static let maxDB = 12.0
    struct Preset {
        let name: String, gains: [Double]
    }
    static let builtins: [Preset] = [
        Preset(name: "Ровно", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        Preset(name: "Больше баса", gains: [4, 3.5, 2.5, 1, 0, 0, 0, 0, 0, 0]),
        Preset(name: "Вокал", gains: [-1.5, -1, 0, 0.5, 1.5, 2.5, 2.5, 1.5, 0, -0.5]),
        Preset(name: "Тихое прослушивание", gains: [3, 2.5, 1.5, 0, 0, 0, 0, 0.5, 1.5, 2]),
        Preset(name: "Электроника", gains: [3.5, 3, 1, 0, -1, -0.5, 0.5, 1.5, 2.5, 2]),
    ]
    enum Edit {
        case enabled(Bool)
        case band(Int, Double)
        case preset(Preset)
    }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    let enabled: Bool, gains: [Double], presets: [Preset]

    init(_ settings: [String: Any]) throws {
        guard let sound = settings["sound"] as? [String: Any], let tone = sound["tone"] as? [String: Any],
              let enabled = tone["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
              let gains = Self.readGains(tone["gains"]) else {
            throw Failure(message: "Сервер вернул неполные настройки звука")
        }
        self.enabled = enabled.boolValue; self.gains = gains
        let custom = (sound["presets"] as? [[String: Any]] ?? []).compactMap { value -> Preset? in
            guard let name = value["name"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let gains = Self.readGains(value["gains"]) else { return nil }
            return Preset(name: name, gains: gains)
        }
        presets = Self.builtins + custom
    }
    var selectedPreset: Int? {
        presets.firstIndex { preset in zip(preset.gains, gains).allSatisfy { abs($0.0 - $0.1) < 0.05 } }
    }
    static func bandLabel(_ frequency: Int) -> String {
        frequency >= 1000 ? "\(frequency / 1000) кГц" : "\(frequency) Гц"
    }
    private static func readGains(_ value: Any?) -> [Double]? {
        guard let values = value as? [NSNumber], values.count == bands.count,
              values.allSatisfy({ CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite && abs($0.doubleValue) <= maxDB }) else { return nil }
        return values.map(\.doubleValue)
    }

    /// The API deep-merges sound.tone; omit all untouched keys so concurrent playback/tone edits survive.
    /// Band edits use gains from a fresh GET, not the screen's earlier snapshot.
    func patch(_ edit: Edit) throws -> [String: Any] {
        let tone: [String: Any]
        switch edit {
        case .enabled(let enabled): tone = ["enabled": enabled]
        case .band(let index, let value):
            guard gains.indices.contains(index), value.isFinite else { throw Failure(message: "Некорректная полоса эквалайзера") }
            var next = gains
            // Match Math.round(value * 2) / 2, including negative half-step ties.
            next[index] = floor(min(Self.maxDB, max(-Self.maxDB, value)) * 2 + 0.5) / 2
            tone = ["enabled": true, "gains": next]
        case .preset(let preset):
            guard Self.readGains(preset.gains) != nil else { throw Failure(message: "Некорректный пресет эквалайзера") }
            tone = ["enabled": true, "gains": preset.gains]
        }
        return ["sound": ["tone": tone]]
    }
}
