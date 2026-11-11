import Foundation

func require(_ condition: Bool, _ message: String) { precondition(condition, message) }
func rejects(_ message: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError(message) } catch {}
}

let raw: [String: Any] = [
    "automix": ["enabled": true, "style": "smooth", "loudnessTarget": -16, "maxStretchPercent": 12.5, "futureOption": "keep"],
    "wave": ["continueRadio": false, "yandexSeeds": ["seed"]],
    "ui": ["motion": "reduced"],
    "sound": ["tone": ["enabled": true, "gains": [1, 2, 3]]],
    "analysis": ["onlyWhenIdle": true],
]
let state = try NativeSettingsState(raw)
require(state.bool("automix", "enabled", fallback: false), "Boolean value")
require(!state.bool("wave", "continueRadio", fallback: true), "Explicit false must not become the default")
require(!state.bool("downloads", "autoLiked", fallback: false), "Old settings receive download default")
require(state.bool("automix", "mixOnNext", fallback: true), "Old settings receive mix-on-next default")
require(state.string("ui", "motion", fallback: "system") == "reduced", "Motion preference")
require(state.number("automix", "maxStretchPercent", fallback: 0) == 12.5, "Fractional slider value")
require(state.number("automix", "enabled", fallback: 42) == 42, "Boolean is not a numeric slider value")
require(state.picker("automix", "loudnessTarget", fallback: "off") == "-16", "Numeric picker mapping")
require(state.picker("downloads", "keepWave", fallback: "0") == "0", "Missing numeric picker default")

let changed = try state.replacing("automix", "enabled", with: false)
require(!changed.bool("automix", "enabled", fallback: true), "Edited key changes")
require(changed.string("automix", "futureOption", fallback: "") == "keep", "Other settings survive an edit")
require((changed.value("wave", "yandexSeeds") as? [String]) == ["seed"], "Other groups survive an edit")
let sound = changed.raw["sound"] as? [String: Any]
require((sound?["tone"] as? [String: Any])?["gains"] as? [Int] == [1, 2, 3], "Sound settings are preserved")
require(state.bool("automix", "enabled", fallback: false), "Editing does not mutate confirmed state")

let patch = NativeSettingsState.patch("downloads", "keepWave", try NativeSettingsState.pickerValue("20", numeric: true))
require(patch.count == 1 && (patch["downloads"] as? [String: Any])?.count == 1, "PUT sends only the edited key")
require(((patch["downloads"] as? [String: Any])?["keepWave"] as? NSNumber)?.doubleValue == 20, "Numeric picker sends a JSON number")
let disabledLoudness = try NativeSettingsState.pickerValue("off", numeric: true)
require(disabledLoudness is NSNull, "Disabled loudness is null, never zero")
let muted = try state.replacing("automix", "loudnessTarget", with: disabledLoudness)
require(muted.picker("automix", "loudnessTarget", fallback: "-16") == "off", "Null round-trips through the picker")
require(try NativeSettingsState.pickerValue("tight", numeric: false) as? String == "tight", "String picker remains a string")
let nullPatch = NativeSettingsState.patch("automix", "loudnessTarget", disabledLoudness)
let nullJSON = try JSONSerialization.data(withJSONObject: nullPatch)
let decoded = try JSONSerialization.jsonObject(with: nullJSON) as! [String: Any]
require((decoded["automix"] as? [String: Any])?["loudnessTarget"] is NSNull, "Wire patch preserves JSON null")
for invalid in ["no-number", "NaN", "infinity", ""] {
    rejects("Invalid number was accepted: \(invalid)") { _ = try NativeSettingsState.pickerValue(invalid, numeric: true) }
}
rejects("Incomplete server response was accepted") { _ = try NativeSettingsState(["automix": [:], "wave": [:]]) }
rejects("Malformed group was accepted") { _ = try NativeSettingsState(["automix": [], "wave": [:], "ui": [:]]) }

let backupData = Data("""
    {"format":"mora-playlists","version":1,"origin":"fixture","tracks":[],"playlists":[{"key":"p","name":"Плейлист","description":"","tracks":[]}]}
    """.utf8)
let backup = try NativeSettingsBackup(data: backupData, name: "Моя копия.json")
require(backup.count == 1 && backup.name == "Моя копия.json", "Backup inspection preserves count and filename")
require(backup.raw["origin"] as? String == "fixture", "Full backup object reaches the server validator unchanged")
for invalid in [
    "[]", "{}", "{broken}",
    "{\"format\":\"other\",\"version\":1,\"playlists\":[]}",
    "{\"format\":\"mora-playlists\",\"version\":1.5,\"playlists\":[]}",
    "{\"format\":\"mora-playlists\",\"version\":true,\"playlists\":[]}",
    "{\"format\":\"mora-playlists\",\"version\":1,\"playlists\":{}}",
] {
    rejects("Invalid backup was accepted") { _ = try NativeSettingsBackup(data: Data(invalid.utf8), name: "bad.json") }
}
rejects("Oversized backup was accepted") { _ = try NativeSettingsBackup(data: Data(repeating: 0, count: 16 * 1024 * 1024 + 1), name: "large.json") }
print("Native settings: patch isolation, defaults, numeric/null pickers, preserved sound and backup inspection passed")
