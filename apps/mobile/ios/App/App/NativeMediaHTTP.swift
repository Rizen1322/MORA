import Foundation

final class NativePreparationTicket: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var tasks: [ObjectIdentifier: URLSessionTask] = [:]
    var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func add(_ task: URLSessionTask) {
        lock.lock(); tasks[ObjectIdentifier(task)] = task; let stop = stopped; lock.unlock()
        if stop { task.cancel() }
    }
    func remove(_ task: URLSessionTask) { lock.lock(); tasks.removeValue(forKey: ObjectIdentifier(task)); lock.unlock() }
    func cancel() {
        lock.lock(); stopped = true; let pending = Array(tasks.values); lock.unlock()
        for task in pending { task.cancel() }
    }
}

/// Native file transport while the background-audio process is running. No WebView
/// fetch, JS wake-up, page timer or finite beginBackgroundTask is involved.
final class NativeMediaHTTP: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    enum Failure: LocalizedError {
        case invalidURL, http(Int), transport(Int), network, cancelled, tooLarge

        static func isConnectionLoss(_ error: Error) -> Bool {
            let code: Int
            switch error {
            case Failure.transport(let value): code = value
            case let url as URLError: code = url.errorCode
            default: return false
            }
            switch URLError.Code(rawValue: code) {
            case .timedOut, .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost:
                return true
            default: return false
            }
        }

        var errorDescription: String? {
            if Self.isConnectionLoss(self) { return "Не удалось загрузить трек. Проверьте подключение к интернету." }
            switch self {
            case .invalidURL, .http, .transport, .network: return "Не удалось загрузить трек из этого источника."
            case .cancelled: return "Загрузка отменена."
            case .tooLarge: return "Аудиофайл слишком большой для воспроизведения."
            }
        }
    }
    private final class Transfer {
        let destination: URL, partial: URL, file: FileHandle, limit: Int, ticket: NativePreparationTicket
        let completion: (Result<Void, Error>) -> Void
        let sink: ((Data) -> Void)?
        var bytes = 0
        init(destination: URL, partial: URL, file: FileHandle, limit: Int, ticket: NativePreparationTicket,
             sink: ((Data) -> Void)?, completion: @escaping (Result<Void, Error>) -> Void) {
            self.destination = destination; self.partial = partial; self.file = file; self.limit = limit
            self.ticket = ticket; self.sink = sink; self.completion = completion
        }
    }
    private final class MemoryTransfer {
        let limit: Int, ticket: NativePreparationTicket
        let completion: (Result<Data, Error>) -> Void
        var buffer = Data()
        init(limit: Int, ticket: NativePreparationTicket, completion: @escaping (Result<Data, Error>) -> Void) {
            self.limit = limit; self.ticket = ticket; self.completion = completion
        }
    }
    static let sharedHTTPS = NativeMediaHTTP()
    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1; queue.qualityOfService = .userInitiated; return queue
    }()
    private let allowLoopback: Bool
    private let allowedHTTPHosts: Set<String>
    private let timeout: TimeInterval
    private var transfers: [Int: Transfer] = [:] // delegateQueue only
    private var memoryTransfers: [Int: MemoryTransfer] = [:] // delegateQueue only
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = min(20, timeout); config.timeoutIntervalForResource = timeout
        config.httpCookieStorage = nil; config.urlCache = nil; config.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }()
    init(allowLoopback: Bool = false, allowedHTTPHosts: Set<String> = [], timeout: TimeInterval = 180) {
        self.allowLoopback = allowLoopback; self.allowedHTTPHosts = allowedHTTPHosts; self.timeout = timeout; super.init()
    }
    func invalidate() { delegateQueue.addOperation { self.session.invalidateAndCancel() } }
    private func valid(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, let host = url.host, !host.isEmpty else { return false }
        return url.scheme == "https" || (url.scheme == "http" && (allowedHTTPHosts.contains(host)
            || (allowLoopback && ["127.0.0.1", "localhost", "::1"].contains(host))))
    }
    /// sink receives the bytes as they arrive (progressive decoding); the whole file is still written.
    func download(_ url: URL, to destination: URL, headers: [String: String] = [:], limit: Int = 128 * 1024 * 1024,
                  ticket: NativePreparationTicket, sink: ((Data) -> Void)? = nil) async throws {
        guard valid(url), limit > 0 else { throw Failure.invalidURL }
        if ticket.cancelled { throw Failure.cancelled }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            delegateQueue.addOperation {
                do {
                    guard !ticket.cancelled else { throw Failure.cancelled }
                    guard !FileManager.default.fileExists(atPath: destination.path) else { throw Failure.network }
                    let partial = destination.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString).download")
                    guard FileManager.default.createFile(atPath: partial.path, contents: nil, attributes: NativePreparationFiles.attributes) else { throw Failure.network }
                    let file = try FileHandle(forWritingTo: partial)
                    var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData
                    request.allHTTPHeaderFields = headers
                    let task = self.session.dataTask(with: request)
                    self.transfers[task.taskIdentifier] = Transfer(destination: destination, partial: partial, file: file, limit: limit,
                        ticket: ticket, sink: sink, completion: { continuation.resume(with: $0) })
                    ticket.add(task); task.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    func data(_ url: URL, headers: [String: String] = [:], limit: Int = 1024 * 1024,
              ticket: NativePreparationTicket) async throws -> Data {
        guard valid(url), limit > 0 else { throw Failure.invalidURL }
        if ticket.cancelled { throw Failure.cancelled }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            delegateQueue.addOperation {
                guard !ticket.cancelled else { continuation.resume(throwing: Failure.cancelled); return }
                var request = URLRequest(url: url); request.cachePolicy = .reloadIgnoringLocalCacheData
                request.allHTTPHeaderFields = headers
                let task = self.session.dataTask(with: request)
                self.memoryTransfers[task.taskIdentifier] = MemoryTransfer(limit: limit, ticket: ticket, completion: { continuation.resume(with: $0) })
                ticket.add(task); task.resume()
            }
        }
    }
    private func finishMemory(_ task: URLSessionTask, _ result: Result<Data, Error>) {
        guard let transfer = memoryTransfers.removeValue(forKey: task.taskIdentifier) else { return }
        transfer.ticket.remove(task)
        if case .success(let data) = result, data.isEmpty {
            transfer.completion(.failure(Failure.network))
            return
        }
        transfer.completion(result)
    }
    private func finish(_ task: URLSessionTask, _ result: Result<Void, Error>) {
        guard let transfer = transfers.removeValue(forKey: task.taskIdentifier) else { return }
        transfer.ticket.remove(task)
        var outcome = result
        do {
            try transfer.file.close()
            if case .success = outcome {
                guard !transfer.ticket.cancelled else { throw Failure.cancelled }
                guard transfer.bytes > 0 else { throw Failure.network }
                try FileManager.default.moveItem(at: transfer.partial, to: transfer.destination)
            }
        } catch { outcome = .failure(error) }
        try? FileManager.default.removeItem(at: transfer.partial)
        transfer.completion(outcome)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let transfer = memoryTransfers[dataTask.taskIdentifier] {
            guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
                finishMemory(dataTask, .failure(Failure.http((response as? HTTPURLResponse)?.statusCode ?? 0)))
                completionHandler(.cancel); return
            }
            guard response.expectedContentLength <= Int64(transfer.limit) else {
                finishMemory(dataTask, .failure(Failure.tooLarge)); completionHandler(.cancel); return
            }
            completionHandler(.allow); return
        }
        guard let transfer = transfers[dataTask.taskIdentifier] else { completionHandler(.cancel); return }
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
            finish(dataTask, .failure(Failure.http((response as? HTTPURLResponse)?.statusCode ?? 0)))
            completionHandler(.cancel); return
        }
        guard response.expectedContentLength <= Int64(transfer.limit) else {
            finish(dataTask, .failure(Failure.tooLarge)); completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if let transfer = memoryTransfers[dataTask.taskIdentifier] {
            guard !transfer.ticket.cancelled else { finishMemory(dataTask, .failure(Failure.cancelled)); dataTask.cancel(); return }
            guard transfer.buffer.count + data.count <= transfer.limit else { finishMemory(dataTask, .failure(Failure.tooLarge)); dataTask.cancel(); return }
            transfer.buffer.append(data)
            return
        }
        guard let transfer = transfers[dataTask.taskIdentifier] else { return }
        do {
            guard !transfer.ticket.cancelled else { throw Failure.cancelled }
            guard transfer.bytes + data.count <= transfer.limit else { throw Failure.tooLarge }
            try transfer.file.write(contentsOf: data); transfer.bytes += data.count
            transfer.sink?(data)
        } catch { finish(dataTask, .failure(error)); dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let transfer = memoryTransfers[task.taskIdentifier] {
            if transfer.ticket.cancelled { finishMemory(task, .failure(Failure.cancelled)) }
            else if let error { finishMemory(task, .failure(Failure.transport((error as NSError).code))) }
            else { finishMemory(task, .success(transfer.buffer)) }
            return
        }
        if let transfer = transfers[task.taskIdentifier], transfer.ticket.cancelled { finish(task, .failure(Failure.cancelled)) }
        else if let error { finish(task, .failure(Failure.transport((error as NSError).code))) }
        else { finish(task, .success(())) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, valid(url) else {
            if memoryTransfers[task.taskIdentifier] != nil { finishMemory(task, .failure(Failure.invalidURL)) }
            else { finish(task, .failure(Failure.invalidURL)) }
            completionHandler(nil); return
        }
        var next = request
        if response.url?.host != url.host {
            next.setValue(nil, forHTTPHeaderField: "Authorization"); next.setValue(nil, forHTTPHeaderField: "Cookie")
        }
        completionHandler(next)
    }
}
