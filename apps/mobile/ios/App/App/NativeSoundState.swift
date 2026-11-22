import Foundation
import CoreFoundation

/// The native /sound screen edits tone (EQ, balance, mono, room reverb) and playback (speed, semitones).
struct NativeSoundState {
    static let bands = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    static let maxDB = 12.0
    static let balanceRange: ClosedRange<Double> = -1.0...1.0
    static let reverbRange: ClosedRange<Double> = 0.0...0.35
    static let speedRange: ClosedRange<Double> = 0.8...1.2
    static let semitonesRange: ClosedRange<Double> = -6.0...6.0
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
        case balance(Double)
        case mono(Bool)
        case reverbMix(Double)
        case speed(Double)
        case semitones(Double)
        case resetPlayback
        case resetTone
    }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    let enabled: Bool, gains: [Double], presets: [Preset]
    let balance: Double, mono: Bool, reverbMix: Double
    let speed: Double, semitones: Double

    init(_ settings: [String: Any]) throws {
        guard let sound = settings["sound"] as? [String: Any], let tone = sound["tone"] as? [String: Any],
              let enabled = tone["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
              let gains = Self.readGains(tone["gains"]) else {
            throw Failure(message: "Сервер вернул неполные настройки звука")
        }
        self.enabled = enabled.boolValue; self.gains = gains
        balance = Self.readNumber(tone["balance"], in: Self.balanceRange, fallback: 0.0)
        mono = Self.readBool(tone["mono"], fallback: false)
        reverbMix = Self.readNumber(tone["reverbMix"], in: Self.reverbRange, fallback: 0.0)
        let playback = sound["playback"] as? [String: Any]
        speed = Self.roundStep(Self.readNumber(playback?["speed"], in: Self.speedRange, fallback: 1.0), scale: 100)
        semitones = Self.roundStep(Self.readNumber(playback?["semitones"], in: Self.semitonesRange, fallback: 0.0), scale: 2)
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
    private static func readBool(_ value: Any?, fallback: Bool = false) -> Bool {
        guard let flag = value as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { return fallback }
        return flag.boolValue
    }
    private static func readNumber(_ value: Any?, in range: ClosedRange<Double>, fallback: Double) -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return fallback }
        return min(range.upperBound, max(range.lowerBound, number.doubleValue))
    }
    private static func roundStep(_ value: Double, scale: Double) -> Double {
        // Match Math.round(value * scale) / scale, including negative half-step ties, without -0.0.
        let rounded = floor(value * scale + 0.5) / scale
        return rounded == 0 ? 0 : rounded
    }
    private static func readGains(_ value: Any?) -> [Double]? {
        guard let values = value as? [NSNumber], values.count == bands.count,
              values.allSatisfy({ CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite && abs($0.doubleValue) <= maxDB }) else { return nil }
        return values.map(\.doubleValue)
    }

    /// The API deep-merges sound.tone; omit untouched tone keys so concurrent tone edits survive.
    /// PUT replaces sound.playback as an object, so speed/semitones patches send the other field from a fresh GET.
    func patch(_ edit: Edit) throws -> [String: Any] {
        switch edit {
        case .enabled(let enabled):
            return ["sound": ["tone": ["enabled": enabled]]]
        case .band(let index, let value):
            guard gains.indices.contains(index), value.isFinite else { throw Failure(message: "Некорректная полоса эквалайзера") }
            var next = gains
            next[index] = Self.roundStep(min(Self.maxDB, max(-Self.maxDB, value)), scale: 2)
            return ["sound": ["tone": ["enabled": true, "gains": next]]]
        case .preset(let preset):
            guard Self.readGains(preset.gains) != nil else { throw Failure(message: "Некорректный пресет эквалайзера") }
            return ["sound": ["tone": ["enabled": true, "gains": preset.gains]]]
        case .balance(let value):
            guard value.isFinite else { throw Failure(message: "Некорректный баланс звука") }
            let clamped = Self.roundStep(min(Self.balanceRange.upperBound, max(Self.balanceRange.lowerBound, value)), scale: 20)
            var tone: [String: Any] = ["balance": clamped]
            if clamped != 0 { tone["enabled"] = true }
            return ["sound": ["tone": tone]]
        case .mono(let value):
            var tone: [String: Any] = ["mono": value]
            if value { tone["enabled"] = true }
            return ["sound": ["tone": tone]]
        case .reverbMix(let value):
            guard value.isFinite else { throw Failure(message: "Некорректный уровень пространства") }
            let clamped = Self.roundStep(min(Self.reverbRange.upperBound, max(Self.reverbRange.lowerBound, value)), scale: 100)
            var tone: [String: Any] = ["reverbMix": clamped]
            if clamped > 0 { tone["enabled"] = true }
            return ["sound": ["tone": tone]]
        case .speed(let value):
            guard value.isFinite else { throw Failure(message: "Некорректная скорость воспроизведения") }
            let clamped = Self.roundStep(min(Self.speedRange.upperBound, max(Self.speedRange.lowerBound, value)), scale: 100)
            return ["sound": ["playback": ["speed": clamped, "semitones": semitones]]]
        case .semitones(let value):
            guard value.isFinite else { throw Failure(message: "Некорректная высота тона") }
            let clamped = Self.roundStep(min(Self.semitonesRange.upperBound, max(Self.semitonesRange.lowerBound, value)), scale: 2)
            return ["sound": ["playback": ["speed": speed, "semitones": clamped]]]
        case .resetPlayback:
            return ["sound": ["playback": ["speed": 1.0, "semitones": 0.0]]]
        case .resetTone:
            return ["sound": ["tone": ["balance": 0.0, "mono": false, "reverbMix": 0.0]]]
        }
    }
}
