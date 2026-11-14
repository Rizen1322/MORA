import Foundation

struct NativeSourceAccount {
    struct Field: Identifiable {
        var id: String { key }
        let key: String, title: String, placeholder: String, help: String
        let secure: Bool, secret: Bool
    }
    let status: String, detail: String, name: String?
    let hasSecret: Bool, fields: [Field], config: [String: String], docs: [URL]
    var connected: Bool { status == "connected" }
    var linked: Bool { connected || hasSecret && status == "error" }
    var label: String {
        switch status {
        case "connected": return "Подключено"
        case "needs_credentials": return "Требуется подключение"
        case "disabled": return "Выключено"
        case "error": return "Не удалось проверить подключение"
        default: return "Недоступно"
        }
    }
    init(_ raw: [String: Any]) throws {
        guard raw["id"] as? String == "yandex", let status = raw["status"] as? String,
              ["connected", "needs_credentials", "unavailable", "not_supported", "error", "disabled"].contains(status) else {
            throw NativeSourcesState.Failure(message: "Не удалось прочитать состояние Яндекса")
        }
        self.status = status; detail = raw["statusText"] as? String ?? ""
        name = raw["account"] as? String; hasSecret = raw["hasSecret"] as? Bool == true
        config = raw["config"] as? [String: String] ?? [:]
        fields = (raw["configFields"] as? [[String: Any]] ?? []).compactMap { value in
            guard let key = value["key"] as? String, !key.isEmpty, key.count <= 64,
                  let title = value["label"] as? String else { return nil }
            let secret = value["secret"] as? Bool == true
            return Field(key: key, title: title, placeholder: value["placeholder"] as? String ?? "",
                help: value["help"] as? String ?? "", secure: secret || value["type"] as? String == "password", secret: secret)
        }
        docs = (raw["docs"] as? [String] ?? []).compactMap { text in
            guard let url = URL(string: text), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
            return url
        }
    }
    func credentials(_ values: [String: String]) throws -> [String: Any] {
        var config: [String: String] = [:], secrets: [String: String] = [:]
        for field in fields {
            let value = (values[field.key] ?? (field.secret ? "" : self.config[field.key] ?? "")).trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.count <= 8192 else { throw NativeSourcesState.Failure(message: "Значение поля слишком длинное") }
            if field.secret { secrets[field.key] = value } else { config[field.key] = value }
        }
        guard hasSecret || secrets.values.contains(where: { !$0.isEmpty }) else { throw NativeSourcesState.Failure(message: "Вставьте токен") }
        return ["config": config, "secret": secrets]
    }
}

struct NativeSourceLikes {
    let state: String, message: String
    let busy: Bool
    let total: Int, done: Int, failed: Int, skipped: Int
    var active: Bool { state == "running" || state == "listing" }
    var finished: Bool { state == "done" || state == "cancelled" }
    var progress: Double? { total > 0 ? min(1, Double(done + failed + skipped) / Double(total)) : nil }
    var title: String {
        switch state {
        case "listing": return "Получаем коллекцию…"
        case "paused": return "На паузе"
        case "done": return "Готово"
        case "error": return "Нужен повтор"
        case "cancelled": return "Импорт завершён"
        default: return "Подготавливаем"
        }
    }
    init(_ raw: [String: Any]) throws {
        guard let state = raw["state"] as? String, ["listing", "running", "paused", "done", "error", "cancelled"].contains(state) else {
            throw NativeSourcesState.Failure(message: "Не удалось прочитать состояние импорта")
        }
        self.state = state; message = raw["message"] as? String ?? ""; busy = raw["busy"] as? Bool == true
        func count(_ key: String) -> Int { max(0, (raw[key] as? NSNumber)?.intValue ?? 0) }
        total = count("total"); done = count("done"); failed = count("failed"); skipped = count("skipped")
    }
}

enum NativeSourcesState {
    typealias Request = (String, String, [String: Any]?) async throws -> [String: Any]
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    static func account(force: Bool = false, request: Request) async throws -> NativeSourceAccount {
        let raw = try await request("GET", "/api/providers" + (force ? "?force=1" : ""), nil)
        guard let provider = (raw["providers"] as? [[String: Any]])?.first(where: { $0["id"] as? String == "yandex" }) else {
            throw Failure(message: "Яндекс Музыка не найдена среди источников")
        }
        return try NativeSourceAccount(provider)
    }
    static func connect(_ account: NativeSourceAccount, values: [String: String], request: Request) async throws -> NativeSourceAccount {
        let body = try account.credentials(values)
        let raw = try await request("POST", "/api/providers/yandex/connect", body)
        guard raw["ok"] as? Bool == true, let info = raw["info"] as? [String: Any] else { throw Failure(message: "Не удалось подтвердить подключение") }
        return try NativeSourceAccount(info)
    }
    static func disconnect(request: Request) async throws {
        let raw = try await request("POST", "/api/providers/yandex/disconnect", nil)
        guard raw["ok"] as? Bool == true else { throw Failure(message: "Не удалось отключить аккаунт") }
    }
    static func likes(request: Request) async throws -> NativeSourceLikes? {
        let raw = try await request("GET", "/api/providers/yandex/likes/import?envelope=1", nil)
        if raw["job"] is NSNull { return nil }
        guard let job = raw["job"] as? [String: Any] else { throw Failure(message: "Не удалось прочитать состояние импорта") }
        return try NativeSourceLikes(job)
    }
    static func changeLikes(_ action: String, request: Request) async throws {
        guard ["start", "pause", "cancel", "resume", "retry"].contains(action) else { throw Failure(message: "Неизвестное действие импорта") }
        let suffix = action == "start" ? "" : "/" + (action == "retry" ? "resume" : action)
        _ = try await request("POST", "/api/providers/yandex/likes/import" + suffix, action == "retry" ? ["retryFailed": true] : nil)
    }
}
