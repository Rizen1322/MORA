import Foundation
import Network

@MainActor final class NativeDownloadManager: NSObject, URLSessionDownloadDelegate {
    static let shared = NativeDownloadManager()
    static let identifier = "ru.mora.player.downloads"
    static let changed = Notification.Name("mora.downloads.changed")
    nonisolated static var root: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.ru.mora.player")?.appendingPathComponent("downloads", isDirectory: true)
    }
    private(set) var jobs: [NativeDownloadJob] = []
    private var tasks: [String: URLSessionDownloadTask] = [:]
    private var started: [String: Date] = [:]
    private var readyFiles: [String: URL] = [:]
    private let io = DispatchQueue(label: "ru.mora.download-io", qos: .utility)
    private var lastSave = Date.distantPast
    private var limitBytes: Int64 = 512 * 1024 * 1024
    private var completion: (() -> Void)?
    #if DEBUG
    private var visualFixtureId: String?
    #endif
    private let network = NWPathMonitor()
    private var wifi = false
    private var wifiOnly: Bool { UserDefaults.standard.bool(forKey: "mora.downloads.wifiOnly") }
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.sharedContainerIdentifier = "group.ru.mora.player"
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.waitsForConnectivity = true
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }()

    private func rebuildReadyFilesCache() {
        guard let root = Self.root else { readyFiles = [:]; return }
        var map: [String: URL] = [:]
        for job in jobs where job.state == .done {
            let url = root.appendingPathComponent(job.id + ".media")
            if FileManager.default.isReadableFile(atPath: url.path) {
                map[job.trackId] = url
            }
        }
        readyFiles = map
    }

    private override init() {
        super.init()
        if let saved = UserDefaults.standard.object(forKey: "mora.downloads.limitBytes") as? Int64 { limitBytes = saved }
        if let root = Self.root {
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                let file = root.appendingPathComponent("queue.json")
                if FileManager.default.fileExists(atPath: file.path) {
                    let data = try Data(contentsOf: file)
                    guard data.count <= 4 * 1024 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
                    let loaded = try JSONDecoder().decode([NativeDownloadJob].self, from: data)
                    guard loaded.count <= 10000, Set(loaded.map(\.id)).count == loaded.count,
                          loaded.allSatisfy({ UUID(uuidString: $0.id) != nil && !$0.trackId.isEmpty && $0.expectedBytes >= 0 && $0.expectedBytes <= 1_099_511_627_776 && $0.receivedBytes >= 0 && $0.receivedBytes <= 1_099_511_627_776 && $0.duration.isFinite && $0.duration > 0 && $0.duration <= 86400 }) else { throw CocoaError(.fileReadCorruptFile) }
                    jobs = loaded
                }
            } catch {
                try? FileManager.default.copyItem(at: root.appendingPathComponent("queue.json"), to: root.appendingPathComponent("queue-corrupt-\(UUID().uuidString).json"))
                NativeShellStore.shared?.show("Не удалось прочитать очередь загрузок: \(error.localizedDescription)")
            }
        }
        rebuildReadyFilesCache()
        session.getAllTasks { tasks in
            DispatchQueue.main.async {
                for case let task as URLSessionDownloadTask in tasks {
                    if let id = task.taskDescription, self.jobs.contains(where: { $0.id == id }) { self.tasks[id] = task }
                    else { task.cancel() }
                }
                for i in self.jobs.indices where [.downloading, .queued].contains(self.jobs[i].state) && self.tasks[self.jobs[i].id] == nil {
                    self.jobs[i].state = .failed
                    self.jobs[i].error = "Загрузка прервана. Откройте MORA и нажмите «Повторить»"
                }
                self.publish(force: true)
            }
        }
        network.pathUpdateHandler = { path in
            DispatchQueue.main.async { self.wifi = path.status == .satisfied && path.usesInterfaceType(.wifi) }
        }
        network.start(queue: DispatchQueue(label: "ru.mora.download-network"))
    }

    func handleEvents(_ handler: @escaping () -> Void) { completion = handler; _ = session }
    func hasTask(_ id: String) -> Bool { tasks[id] != nil }
    #if DEBUG
    func installVisualFixture() -> String {
        if let id = visualFixtureId { removeVisualFixture(id) }
        var job = NativeDownloadJob(trackId: "native-download-fixture", title: "Проверка загрузки", artist: "", album: "", duration: 180, expectedBytes: 10 * 1024 * 1024)
        job.state = .downloading; job.receivedBytes = 4 * 1024 * 1024
        visualFixtureId = job.id; jobs.append(job)
        NotificationCenter.default.post(name: Self.changed, object: nil)
        return job.id
    }
    func removeVisualFixture(_ id: String) {
        guard id == visualFixtureId else { return }
        jobs.removeAll { $0.id == id }; visualFixtureId = nil
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }
    #endif
    func localFile(_ trackId: String) -> URL? {
        if let cached = readyFiles[trackId] { return cached }
        guard let root = Self.root, let job = jobs.first(where: { $0.trackId == trackId && $0.state == .done }) else { return nil }
        let url = root.appendingPathComponent(job.id + ".media")
        guard FileManager.default.isReadableFile(atPath: url.path) else { return nil }
        readyFiles[trackId] = url
        return url
    }
    func enqueue(trackId: String, album: String) async throws {
        if localFile(trackId) != nil || jobs.contains(where: { $0.trackId == trackId && tasks[$0.id] != nil }) { return }
        if Self.root != nil {
            let response = try await NativeServerApp.request("POST", "/api/mobile/native-sources", body: [
                "entries": [["trackId": trackId, "entryId": UUID().uuidString, "file": 0]], "previousId": trackId])
            if let item = (response["items"] as? [[String: Any]])?.first,
               let source = item["source"] as? [String: Any],
               NativeDownloadJob.Transfer(sourceKind: source["kind"] as? String, supportsBackground: true) == .background {
                let downloads = try await NativeServerApp.request("GET", "/api/downloads")
                if (downloads["jobs"] as? [[String: Any]])?.contains(where: {
                    $0["trackId"] as? String == trackId && ["queued", "downloading", "waiting", "paused"].contains($0["state"] as? String ?? "")
                }) == true { return }
                guard let raw = downloads["usage"] as? [String: Any] else { throw failure("Не удалось проверить место для загрузки") }
                let usage = try NativeDownloadsState.Usage(raw)
                let ticket = NativePreparationTicket()
                let request = try await withTaskCancellationHandler {
                    try await NativeMediaLoader(http: NativeMediaHTTP.sharedHTTPS).backgroundRequest(source, ticket: ticket)
                } onCancel: { ticket.cancel() }
                try Task.checkCancellation()
                _ = try add(trackId: trackId, title: item["title"] as? String ?? "Трек", artist: item["artist"] as? String ?? "",
                            album: album, duration: (item["duration"] as? NSNumber)?.doubleValue ?? 0,
                            request: request, limit: Int64(min(1e12, usage.availableForNative)))
                return
            }
        }
        try Task.checkCancellation()
        _ = try await NativeServerApp.request("POST", "/api/downloads", body: ["trackId": trackId])
    }
    func add(trackId: String, title: String, artist: String, album: String, duration: Double, request: URLRequest, limit: Int64) throws -> NativeDownloadJob {
        guard let root = Self.root, !trackId.isEmpty, trackId.utf8.count <= 512, duration.isFinite, duration > 0, duration <= 86400,
              request.url?.scheme == "https", request.url?.user == nil, request.url?.password == nil else { throw failure("Источник фоновой загрузки недоступен") }
        if let existing = jobs.first(where: { $0.trackId == trackId && (tasks[$0.id] != nil || ($0.state == .done && localFile(trackId) != nil)) }) { return existing }
        limitBytes = max(0, limit)
        UserDefaults.standard.set(limitBytes, forKey: "mora.downloads.limitBytes")
        let estimate = Int64(min(duration, 86400) * 40000)
        let occupied = jobs.filter { $0.state != .cancelled && $0.state != .failed }.reduce(Int64(0)) { $0 + $1.reservedBytes }
        let free = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard occupied + estimate <= limitBytes, estimate + 64 * 1024 * 1024 < free else { throw failure("Недостаточно места или превышен лимит кэша") }
        var job = NativeDownloadJob(trackId: trackId, title: title, artist: artist, album: album, duration: duration, expectedBytes: estimate)
        var request = request
        request.allowsCellularAccess = !wifiOnly
        request.allowsExpensiveNetworkAccess = !wifiOnly
        let task = session.downloadTask(with: request)
        task.taskDescription = job.id
        job.state = wifiOnly && !wifi ? .queued : .downloading
        let previous = jobs
        jobs.removeAll { $0.trackId == trackId }
        jobs.append(job)
        do { try save() } catch { jobs = previous; task.cancel(); throw error }
        tasks[job.id] = task; started[job.id] = .now
        task.resume(); publish(force: true)
        return job
    }
    func action(_ id: String, _ action: String) throws {
        guard let i = jobs.firstIndex(where: { $0.id == id }), ["pause", "resume", "retry", "cancel"].contains(action) else { throw failure("Загрузка не найдена") }
        if action == "pause" { tasks[id]?.suspend() }
        if action == "cancel" { tasks.removeValue(forKey: id)?.cancel() }
        if action == "resume" || action == "retry" {
            guard let task = tasks[id] else { throw failure("Откройте MORA и добавьте трек повторно — адрес загрузки нужно обновить") }
            task.resume()
        }
        jobs[i].apply(action)
        try save(); publish(force: true)
    }
    func setWiFiOnly(_ enabled: Bool) {
        guard enabled != wifiOnly else { return }
        UserDefaults.standard.set(enabled, forKey: "mora.downloads.wifiOnly")
        for (id, task) in Array(tasks) {
            guard var request = task.originalRequest else { continue }
            task.cancel(); tasks.removeValue(forKey: id)
            request.allowsCellularAccess = !enabled; request.allowsExpensiveNetworkAccess = !enabled
            let replacement = session.downloadTask(with: request)
            replacement.taskDescription = id; tasks[id] = replacement
            if jobs.first(where: { $0.id == id })?.state != .paused { replacement.resume() }
        }
        publish(force: true)
    }
    func remove(_ trackId: String) throws {
        guard let root = Self.root else { return }
        for job in jobs where job.trackId == trackId {
            tasks.removeValue(forKey: job.id)?.cancel()
            let file = root.appendingPathComponent(job.id + ".media")
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
        jobs.removeAll { $0.trackId == trackId }; readyFiles.removeValue(forKey: trackId); try save(); publish(force: true)
    }
    func remapTracks(_ mapping: [String: String]) {
        for i in jobs.indices { jobs[i].trackId = mapping[jobs[i].trackId] ?? jobs[i].trackId }
        rebuildReadyFilesCache()
        publish(force: true)
    }
    func list() -> [String: Any] {
        let rows = jobs.map { job -> [String: Any] in
            var row: [String: Any] = ["id": job.id, "key": "native:" + job.trackId, "trackId": job.trackId, "title": job.title, "artist": job.artist, "album": job.album,
                "duration": job.duration, "state": job.state.rawValue, "progress": job.progress, "bytes": job.receivedBytes, "totalBytes": job.expectedBytes]
            row["error"] = job.error.map { $0 as Any } ?? NSNull()
            if let start = started[job.id], let eta = job.eta(elapsed: Date().timeIntervalSince(start)) { row["eta"] = eta }
            return row
        }
        return ["jobs": rows, "wifiOnly": wifiOnly, "cacheBytes": jobs.filter { $0.state == .done }.reduce(Int64(0)) { $0 + $1.receivedBytes }]
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "MORADownload", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func save() throws {
        let payload = try encodedQueueData()
        guard let root = Self.root else { throw failure("Общая папка MORA недоступна") }
        let file = root.appendingPathComponent("queue.json")
        try payload.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func encodedQueueData() throws -> Data {
        var savedJobs = jobs
        #if DEBUG
        // A diagnostic row must not survive a real background callback saving the queue.
        if let id = visualFixtureId { savedJobs.removeAll { $0.id == id } }
        #endif
        return try JSONEncoder().encode(savedJobs)
    }
    private func publish(force: Bool = false) {
        guard force || Date().timeIntervalSince(lastSave) >= 0.5 else { return }
        lastSave = .now
        if let root = Self.root, let data = try? encodedQueueData() {
            let file = root.appendingPathComponent("queue.json")
            io.async {
                do {
                    try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                } catch {
                    DispatchQueue.main.async {
                        NativeShellStore.shared?.show("Не удалось сохранить очередь: \(error.localizedDescription)")
                    }
                }
            }
        }
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        DispatchQueue.main.async {
            guard let id = downloadTask.taskDescription, self.tasks[id] === downloadTask, let i = self.jobs.firstIndex(where: { $0.id == id }) else { return }
            self.jobs[i].receivedBytes = totalBytesWritten
            if totalBytesExpectedToWrite > 0 { self.jobs[i].expectedBytes = totalBytesExpectedToWrite }
            self.jobs[i].state = .downloading
            if self.jobs.filter({ $0.state != .cancelled && $0.state != .failed }).reduce(Int64(0), { $0 + $1.reservedBytes }) > self.limitBytes {
                self.jobs[i].state = .failed; self.jobs[i].error = "Превышен лимит кэша"; self.tasks.removeValue(forKey: id)?.cancel()
            }
            self.publish()
        }
    }
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let staged = Result { () throws -> URL in
            guard let root = Self.root else { throw NativeDownloadsState.Failure(message: "Общая папка MORA недоступна") }
            let file = root.appendingPathComponent(UUID().uuidString + ".partial")
            try FileManager.default.moveItem(at: location, to: file)
            return file
        }
        DispatchQueue.main.async {
            let temporaryFile = try? staged.get()
            defer { if let temporaryFile { try? FileManager.default.removeItem(at: temporaryFile) } }
            guard let id = downloadTask.taskDescription, self.tasks[id] === downloadTask, let i = self.jobs.firstIndex(where: { $0.id == id }) else { return }
            do {
                let file = try staged.get()
                guard let response = downloadTask.response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
                    throw self.failure("Сервис отклонил загрузку — обновите адрес в MORA")
                }
                let bytes = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                let other = self.jobs.filter { $0.id != id && ![.cancelled, .failed].contains($0.state) }.reduce(Int64(0)) { $0 + $1.reservedBytes }
                guard bytes > 0, Int64(bytes) + other <= self.limitBytes else { throw self.failure("Пустой файл или превышен лимит кэша") }
                let destination = file.deletingLastPathComponent().appendingPathComponent(id + ".media")
                try FileManager.default.setAttributes(NativePreparationFiles.attributes, ofItemAtPath: file.path)
                try FileManager.default.moveItem(at: file, to: destination)
                let previous = self.jobs[i]
                self.jobs[i].finish(.success(Int64(bytes)))
                do { try self.save() } catch {
                    self.jobs[i] = previous
                    try? FileManager.default.removeItem(at: destination)
                    throw error
                }
                self.readyFiles[previous.trackId] = destination
                self.lastSave = .now
                NotificationCenter.default.post(name: Self.changed, object: nil)
            } catch {
                self.jobs[i].finish(.failure(error))
                self.publish(force: true)
            }
        }
    }
    private static func friendlyDownloadError(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorNotConnectedToInternet: return "Нет подключения к интернету"
            case NSURLErrorTimedOut: return "Превышено время ожидания загрузки"
            case NSURLErrorNetworkConnectionLost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorCannotConnectToHost:
                return "Потеряно соединение при загрузке"
            default: break
            }
        }
        return error.localizedDescription
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        DispatchQueue.main.async {
            guard let id = task.taskDescription, self.tasks[id] === task, let i = self.jobs.firstIndex(where: { $0.id == id }) else { return }
            self.tasks.removeValue(forKey: id)
            guard ![.cancelled, .done, .failed, .paused].contains(self.jobs[i].state) else { return }
            guard let error else {
                self.jobs[i].finish(.failure(self.failure("Не удалось сохранить файл загрузки")))
                self.publish(force: true)
                return
            }
            let ns = error as NSError
            if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
                self.jobs[i].state = .cancelled
                self.jobs[i].error = nil
                self.publish(force: true)
                return
            }
            let httpStatus = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            let expiredOrDenied = [401, 403, 404, 410].contains(httpStatus)
            self.jobs[i].attempts += 1
            if !expiredOrDenied, self.jobs[i].attempts <= 3, let request = task.originalRequest {
                let retry = self.session.downloadTask(with: request)
                retry.taskDescription = id; retry.earliestBeginDate = Date().addingTimeInterval(NativeDownloadJob.retryDelay(attempt: self.jobs[i].attempts))
                self.tasks[id] = retry; self.jobs[i].state = .queued; retry.resume()
                self.jobs[i].error = "Нет связи — повторим автоматически"
            } else {
                self.jobs[i].state = .failed
                self.jobs[i].error = expiredOrDenied ? "Ссылка загрузки устарела — нажмите «Повторить»" : Self.friendlyDownloadError(error)
            }
            self.publish(force: true)
        }
    }
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { let handler = self.completion; self.completion = nil; handler?() }
    }
}