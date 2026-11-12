import Foundation
import CoreFoundation

enum NativeLibraryActions {
    typealias Request = (_ method: String, _ path: String, _ body: [String: Any]?) async throws -> [String: Any]
    struct Export { let name: String, text: String }
    struct Result {
        var mutated = false
        var go: String? = nil
        var message: String? = nil
        var export: Export? = nil
    }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    static func supports(_ name: String) -> Bool {
        ["createPlaylist", "renamePlaylist", "deletePlaylist", "addToPlaylist", "removeFromPlaylist", "reorderPlaylist", "exportPlaylist", "clearHistory"].contains(name)
    }
    private static func component(_ value: Any?) throws -> String {
        guard let value = value as? String, !value.isEmpty,
              let encoded = value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) else {
            throw Failure(message: "Плейлист не найден")
        }
        return encoded
    }
    private static func integer(_ value: Any?, positive: Bool = false) throws -> Int {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, abs(value.doubleValue) <= 9_007_199_254_740_991,
              let number = Int(exactly: value.doubleValue), number >= (positive ? 1 : 0) else {
            throw Failure(message: "Порядок плейлиста изменился. Обновите страницу и повторите.")
        }
        return number
    }
    static func reordered(_ entries: Any?, from: Any?, to: Any?) throws -> [Int] {
        guard let raw = entries as? [Any] else { throw Failure(message: "Не найден порядок плейлиста") }
        var ids = try raw.map { try integer($0, positive: true) }
        let start = try integer(from), destination = try integer(to)
        guard Set(ids).count == ids.count, ids.indices.contains(start), destination <= ids.count else {
            throw Failure(message: "Порядок плейлиста изменился. Обновите страницу и повторите.")
        }
        let id = ids.remove(at: start)
        ids.insert(id, at: destination > start ? destination - 1 : destination)
        return ids
    }

    /// nil means unsupported. A supported failure always throws; it must never retry through the page.
    static func execute(_ name: String, _ args: [String: Any], request: Request) async throws -> Result? {
        guard supports(name) else { return nil }
        switch name {
        case "clearHistory":
            _ = try await request("DELETE", "/api/history", nil)
            return Result(mutated: true)
        case "createPlaylist":
            let name = (args["value"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return Result() }
            let created = try await request("POST", "/api/playlists", ["name": name])
            let id = try component(created["id"])
            return Result(mutated: true, go: "/playlist/\(id)")
        case "renamePlaylist":
            let name = (args["value"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return Result() }
            let id = try component(args["id"])
            _ = try await request("PATCH", "/api/playlists/\(id)", ["name": name])
            return Result(mutated: true)
        case "deletePlaylist":
            let id = try component(args["id"])
            _ = try await request("DELETE", "/api/playlists/\(id)", nil)
            return Result(mutated: true, go: "/library/playlists")
        case "removeFromPlaylist":
            let id = try component(args["id"]), entry = try integer(args["entry"], positive: true)
            _ = try await request("DELETE", "/api/playlists/\(id)/tracks/\(entry)", nil)
            return Result(mutated: true, message: "Убрано из плейлиста")
        case "reorderPlaylist":
            let id = try component(args["id"])
            let entries = try reordered(args["entries"], from: args["from"], to: args["to"])
            _ = try await request("PUT", "/api/playlists/\(id)/order", ["entryIds": entries])
            return Result(mutated: true)
        case "exportPlaylist":
            let id = try component(args["id"])
            let backup = try await request("GET", "/api/backup/playlists?playlist=\(id)", nil)
            let data = try JSONSerialization.data(withJSONObject: backup, options: [.sortedKeys])
            return Result(export: Export(name: "MORA-playlist.json", text: String(decoding: data, as: UTF8.self)))
        case "addToPlaylist":
            guard let ids = args["ids"] as? [String], !ids.isEmpty, ids.allSatisfy({ !$0.isEmpty }) else { throw Failure(message: "Трек не найден") }
            if let playlist = args["playlistId"] as? String, !playlist.isEmpty {
                let id = try component(playlist)
                let current = try await request("GET", "/api/playlists/\(id)", nil)
                let added = try await request("POST", "/api/playlists/\(id)/tracks", ["trackIds": ids])
                let count = (added["added"] as? NSNumber)?.intValue ?? 0
                return Result(mutated: true, message: "Добавлено в «\(current["name"] as? String ?? "плейлист")»: \(count)")
            }
            let name = (args["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { throw Failure(message: "Введите название плейлиста") }
            _ = try await request("POST", "/api/playlists", ["name": name, "trackIds": ids])
            return Result(mutated: true, message: "Создан плейлист «\(name)»")
        default: return nil
        }
    }
}
