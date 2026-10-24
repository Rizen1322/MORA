import Foundation
import JavaScriptCore

/// Planning only. JavaScript is bundled at build time; no Node, network or audio callback.
enum PlannerBridge {
    private static let queue = DispatchQueue(label: "ru.mora.planner", qos: .utility)

    static func plan(requestJSON: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    guard let url = Bundle.main.url(forResource: "mora-core", withExtension: "js"), let context = JSContext() else {
                        throw NSError(domain: "MORA", code: 1, userInfo: [NSLocalizedDescriptionKey: "Не найден планировщик AutoMix"])
                    }
                    var failure: String?
                    context.exceptionHandler = { _, error in failure = error?.toString() ?? "JavaScript error" }
                    context.evaluateScript(try String(contentsOf: url, encoding: .utf8))
                    let value = context.objectForKeyedSubscript("MoraCore")?.invokeMethod("planJSON", withArguments: [requestJSON])
                    guard failure == nil, let value = value, !value.isUndefined, let result = value.toString() else {
                        throw NSError(domain: "MORA", code: 2, userInfo: [NSLocalizedDescriptionKey: failure ?? "Ошибка плана перехода"])
                    }
                    continuation.resume(returning: result)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
}
