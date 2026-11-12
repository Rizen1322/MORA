import Foundation
import CoreFoundation

enum NativeLibraryReactions {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    static func path(_ id: String) throws -> String {
        guard !id.isEmpty, id.utf8.count <= 512,
              let escaped = id.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~")) else {
            throw Failure(message: "Некорректный ID трека")
        }
        return "/api/tracks/\(escaped)/reaction"
    }
    static func validate(_ response: [String: Any], value: Int) throws {
        guard let ok = response["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue,
              let saved = response["value"] as? NSNumber, CFGetTypeID(saved) != CFBooleanGetTypeID(), saved.doubleValue == Double(value) else {
            throw Failure(message: "Сохранение реакции не подтверждено")
        }
        // Yandex sync may still be pending/error: the local write is already committed.
    }
    static func toLike(_ ids: [String], reaction: (String) -> Int?) -> [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted && reaction($0) == 0 }
    }
    @MainActor static func drain(next: @MainActor () -> (String, Int)?,
        send: @MainActor (String, Int) async throws -> Void,
        acknowledge: @MainActor (String, Int) -> Void) async throws {
        while let (id, value) = next() {
            try await send(id, value)
            acknowledge(id, value)
        }
    }
}
