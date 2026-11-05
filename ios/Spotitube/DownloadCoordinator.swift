import Foundation
import UIKit

struct DownloadJob: Codable {
    var id: String
    var title: String
    var authorName: String
    var thumbnailURL: String
    var status: String
    var received: Int64 = 0
    var total: Int64 = 0
    var at = Date().timeIntervalSince1970 * 1000
    enum CodingKeys: String, CodingKey {
        case id, title, status, received, total, at
        case authorName = "author_name"
        case thumbnailURL = "thumbnail_url"
    }
}

@MainActor
final class DownloadCoordinator: NSObject, URLSessionDownloadDelegate {
    static let directory: URL = {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("offline", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()
    static func file(_ id: String) -> URL? {
        guard validVideoID(id) else { return nil }
        let url = directory.appendingPathComponent(id + ".media")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
    private let resolve: (String) async throws -> URL
    private(set) var jobs: [DownloadJob] = []
    private var preparing: [String: Task<Void, Never>] = [:]
    private var transfers: [String: URLSessionDownloadTask] = [:]
    private var restoring = true
    var onChange: (() -> Void)?
    private var storeURL: URL { Self.directory.appendingPathComponent("queue.json") }
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: "com.spotitube.downloads")
        configuration.httpMaximumConnectionsPerHost = 3
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 3600
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(resolve: @escaping (String) async throws -> URL) {
        self.resolve = resolve
        super.init()
        if let data = try? Data(contentsOf: storeURL), let stored = try? JSONDecoder().decode([DownloadJob].self, from: data) {
            jobs = stored
            for index in jobs.indices where ["queued", "preparing", "downloading"].contains(jobs[index].status) {
                jobs[index].status = "queued"
            }
        }
        session.getAllTasks { [weak self] tasks in
            Task { @MainActor in
                guard let self else { return }
                for task in tasks {
                    guard let task = task as? URLSessionDownloadTask, let id = task.taskDescription,
                          let index = self.jobs.firstIndex(where: { $0.id == id }),
                          self.jobs[index].status == "queued" else { task.cancel(); continue }
                    self.transfers[id] = task
                    self.jobs[index].status = "downloading"
                    task.resume()
                }
                self.restoring = false
                self.persist()
                self.pump()
            }
        }
    }

    func enqueue(_ video: Video) {
        guard validVideoID(video.id) else { return }
        if let index = jobs.firstIndex(where: { $0.id == video.id }) {
            if ["queued", "preparing", "downloading"].contains(jobs[index].status) { return }
            if Self.file(video.id) != nil { jobs[index].status = "completed"; persist(); return }
            jobs[index].status = "queued"
            jobs[index].received = 0
            jobs[index].total = 0
        } else {
            jobs.append(DownloadJob(id: video.id, title: video.title, authorName: video.authorName,
                                    thumbnailURL: video.thumbnailURL, status: "queued"))
        }
        persist()
        pump()
    }

    func cancel(_ id: String) {
        guard let index = jobs.firstIndex(where: { $0.id == id }),
              ["queued", "preparing", "downloading"].contains(jobs[index].status) else { return }
        jobs[index].status = "canceled"
        preparing.removeValue(forKey: id)?.cancel()
        transfers.removeValue(forKey: id)?.cancel()
        persist()
        pump()
    }
    func retry(_ id: String) {
        guard let job = jobs.first(where: { $0.id == id }) else { return }
        var video = Video(id: job.id, title: job.title, authorName: job.authorName)
        video.thumbnailURL = job.thumbnailURL
        enqueue(video)
    }
    func remove(_ id: String) {
        cancel(id)
        if let url = Self.file(id) { try? FileManager.default.removeItem(at: url) }
        jobs.removeAll { $0.id == id }
        persist()
    }
    var completed: [[String: Any]] {
        jobs.filter { $0.status == "completed" && Self.file($0.id) != nil }.map { job in
            let bytes = (try? Self.file(job.id)?.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return ["id": job.id, "title": job.title, "author_name": job.authorName,
                    "thumbnail_url": job.thumbnailURL, "size": bytes, "at": job.at]
        }
    }
    private func persist() {
        do { try JSONEncoder().encode(jobs).write(to: storeURL, options: .atomic) }
        catch { NSLog("Could not persist download queue: %@", error.localizedDescription) }
        onChange?()
    }
    private func pump() {
        guard !restoring else { return }
        for job in jobs where job.status == "queued" {
            guard preparing.count + transfers.count < 3 else { break }
            guard let index = jobs.firstIndex(where: { $0.id == job.id }) else { continue }
            jobs[index].status = "preparing"
            preparing[job.id] = Task { [weak self] in
                guard let self else { return }
                do {
                    let url = try await self.resolve(job.id)
                    try Task.checkCancellation()
                    guard let index = self.jobs.firstIndex(where: { $0.id == job.id }),
                          self.jobs[index].status == "preparing" else { return }
                    if url.isFileURL {
                        let target = Self.directory.appendingPathComponent(job.id + ".media")
                        try FileManager.default.copyItem(at: url, to: target)
                        self.jobs[index].status = "completed"
                        let size = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                        self.jobs[index].received = Int64(size)
                        self.jobs[index].total = Int64(size)
                    } else {
                        self.jobs[index].status = "downloading"
                        let task = self.session.downloadTask(with: url)
                        task.taskDescription = job.id
                        self.transfers[job.id] = task
                        task.resume()
                    }
                } catch {
                    if let index = self.jobs.firstIndex(where: { $0.id == job.id }),
                       self.jobs[index].status != "canceled" {
                        self.jobs[index].status = "failed"
                    }
                }
                self.preparing.removeValue(forKey: job.id)
                self.persist()
                self.pump()
            }
        }
        persist()
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                               didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                               totalBytesExpectedToWrite: Int64) {
        guard let id = downloadTask.taskDescription else { return }
        Task { @MainActor in
            guard let index = self.jobs.firstIndex(where: { $0.id == id }),
                  self.jobs[index].status == "downloading" else { return }
            self.jobs[index].received = totalBytesWritten
            self.jobs[index].total = max(0, totalBytesExpectedToWrite)
            self.persist()
        }
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                               didFinishDownloadingTo location: URL) {
        guard let id = downloadTask.taskDescription, validVideoID(id) else { return }
        // URLSession deletes its temporary file when this delegate call returns.
        let staging = location.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        let response = downloadTask.response as? HTTPURLResponse
        let size = (try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let expected = response?.expectedContentLength ?? -1
        let valid = response?.statusCode == 200 && size > 0 && (expected <= 0 || Int64(size) == expected)
        let moved = valid && (try? FileManager.default.moveItem(at: location, to: staging)) != nil
        Task { @MainActor in
            guard let index = self.jobs.firstIndex(where: { $0.id == id }),
                  self.jobs[index].status == "downloading" else {
                try? FileManager.default.removeItem(at: staging)
                return
            }
            do {
                guard moved else { throw SpotError.message("Incomplete download.") }
                let target = Self.directory.appendingPathComponent(id + ".media")
                if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
                try FileManager.default.moveItem(at: staging, to: target)
                self.jobs[index].status = "completed"
                self.jobs[index].received = Int64(size)
                self.jobs[index].total = Int64(size)
                self.jobs[index].at = Date().timeIntervalSince1970 * 1000
            } catch {
                self.jobs[index].status = "failed"
                try? FileManager.default.removeItem(at: staging)
            }
            self.transfers.removeValue(forKey: id)
            self.persist()
            self.pump()
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error != nil, let id = task.taskDescription else { return }
        Task { @MainActor in
            if let index = self.jobs.firstIndex(where: { $0.id == id }),
               self.jobs[index].status == "downloading" { self.jobs[index].status = "failed" }
            self.transfers.removeValue(forKey: id)
            self.persist()
            self.pump()
        }
    }
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in
            let delegate = UIApplication.shared.delegate as? AppDelegate
            delegate?.backgroundDownloadCompletion?()
            delegate?.backgroundDownloadCompletion = nil
        }
    }
}
