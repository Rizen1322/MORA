import Foundation
import CoreFoundation

/// Keep the server's full settings object, including fields this screen does not edit.
struct NativeSettingsState {
    let raw: [String: Any]

    init(_ raw: [String: Any]) throws {
        guard raw["automix"] is [String: Any], raw["wave"] is [String: Any], raw["ui"] is [String: Any] else {
            throw Failure(message: "Сервер вернул неполные настройки")
        }
        self.raw = raw
    }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    func value(_ group: String, _ key: String) -> Any? { (raw[group] as? [String: Any])?[key] }
    func bool(_ group: String, _ key: String, fallback: Bool) -> Bool { value(group, key) as? Bool ?? fallback }
    func string(_ group: String, _ key: String, fallback: String) -> String { value(group, key) as? String ?? fallback }
    func number(_ group: String, _ key: String, fallback: Double) -> Double {
        guard let value = value(group, key) as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return fallback }
        return value.doubleValue
    }
    func picker(_ group: String, _ key: String, fallback: String) -> String {
        guard let value = value(group, key) else { return fallback }
        if value is NSNull { return "off" }
        if let number = value as? NSNumber { return number.stringValue }
        return value as? String ?? fallback
    }
    func replacing(_ group: String, _ key: String, with value: Any) throws -> NativeSettingsState {
        var next = raw, fields = raw[group] as? [String: Any] ?? [:]
        fields[key] = value
        next[group] = fields
        return try NativeSettingsState(next)
    }
    /// PUT merges each group on the server: send only the edited key, never a stale full snapshot.
    static func patch(_ group: String, _ key: String, _ value: Any) -> [String: Any] { [group: [key: value]] }
    static func pickerValue(_ value: String, numeric: Bool) throws -> Any {
        guard numeric else { return value }
        if value == "off" { return NSNull() }
        guard let number = Double(value), number.isFinite else { throw Failure(message: "Некорректное число") }
        return number
    }
}

struct NativeSettingsBackup {
    let raw: [String: Any], name: String, count: Int
    init(data: Data, name: String) throws {
        guard data.count <= 16 * 1024 * 1024 else { throw NativeSettingsState.Failure(message: "Файл больше 16 МБ") }
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              raw["format"] as? String == "mora-playlists", let version = raw["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let playlists = raw["playlists"] as? [Any] else {
            throw NativeSettingsState.Failure(message: "Выберите резервную копию MORA")
        }
        self.raw = raw; self.name = name; count = playlists.count
    }
}
