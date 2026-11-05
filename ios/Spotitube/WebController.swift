import UIKit
import WebKit

/// WKWebView host: serves the bundled web app over the custom `spotitube://` scheme,
/// and bridges JS <-> native (playback, downloads, catalog, artist lookup).
/// There is no synchronous JS->native channel in WKWebView, so the JS side caches
/// state pushed via `__spotEvent` and calls `__spotMessage` for responses.
@MainActor
final class WebController: UIViewController {

    private let playback: PlaybackEngine
    private let downloads: DownloadCoordinator
    private let engine = WebEngineBridge()
    private let schemeHandler = SpotSchemeHandler()
    private var stateTimer: Timer?
    private var webView: WKWebView!
    private var downloadThrottle: [String: Date] = [:]
    private var lastDownloadStatus: [String: String] = [:]
    private let bundleVersion: String = {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.13"
    }()

    init() {
        let resolveStream: (String) async throws -> URL = { id in
            if let cached = DownloadCoordinator.file(id) { return cached }
            return try await StreamResolver.resolve(id)
        }
        playback = PlaybackEngine(resolve: resolveStream)
        downloads = DownloadCoordinator(resolve: resolveStream)
        super.init(nibName: nil, bundle: nil)
        playback.onChange = { [weak self] in self?.pushState() }
        downloads.onChange = { [weak self] in self?.pushDownloads() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        NSLog("SpotiWeb: viewDidLoad")
        view.backgroundColor = UIColor(red: 0x12/255, green: 0x12/255, blue: 0x12/255, alpha: 1)

        let contentController = WKUserContentController()
        contentController.add(engine, name: "spotitube")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "spotitube")
        configuration.allowsInlineMediaPlayback = true

        engine.owner = self
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x12/255, green: 0x12/255, blue: 0x12/255, alpha: 1)
        webView.navigationDelegate = self
        webView.scrollView.bounces = false
        webView.accessibilityIdentifier = "spotitube-webview"
        view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        if let url = URL(string: "spotitube://local/") {
            NSLog("SpotiWeb: loading %@", url.absoluteString)
            webView.load(URLRequest(url: url))
        } else {
            NSLog("SpotiWeb: could not construct spotitube://local/ URL")
        }
        stateTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pushState() }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        pushState()
    }

    deinit { stateTimer?.invalidate() }

    var nowPlaying: PlaybackEngine { playback }
    var offline: DownloadCoordinator { downloads }

    // MARK: - JS -> native dispatch

    @MainActor
    fileprivate func handle(_ message: [String: Any]) {
        let method = message["method"] as? String ?? ""
        let args = message["args"] as? [String: Any] ?? [:]
        let id = message["id"] as? Int ?? Int(message["id"] as? Double ?? -1)
        switch method {
        case "playQueue":
            let entries = queueEntries(args["items"])
            guard !entries.isEmpty else { return }
            let start = (args["startIndex"] as? Int) ?? Int((args["startIndex"] as? Double) ?? 0)
            let position = ((args["positionMs"] as? Double) ?? 0) / 1000.0
            playback.replaceQueue(entries, start: start, position: position)
        case "enqueue":
            let entries = queueEntries(args["items"])
            if !entries.isEmpty { playback.enqueue(entries) }
        case "setRepeat":
            playback.setRepeat((args["mode"] as? Int) ?? Int((args["mode"] as? Double) ?? 0))
        case "control":
            handleControl(action: args["action"] as? String ?? "", value: (args["value"] as? Double) ?? 0)
        case "search":
            let request = (args["request"] as? Int) ?? Int((args["request"] as? Double) ?? 0)
            let query = (args["query"] as? String) ?? ""
            Task { @MainActor in
                let videos = (try? await Catalog.search(query, musicOnly: false)) ?? []
                dispatchEvent("spotitube-search", ["request": request, "videos": videos.map(videoPayload)])
            }
        case "radio":
            let request = (args["request"] as? Int) ?? Int((args["request"] as? Double) ?? 0)
            let videoId = (args["id"] as? String) ?? ""
            Task { @MainActor in
                let result = try? await Catalog.radio(videoId, musicOnly: false)
                let filtered = (result ?? []).filter { $0.id != videoId }
                dispatchEvent("spotitube-radio", ["request": request, "seed": videoId, "videos": filtered.map(videoPayload)])
            }
        case "importPlaylist":
            let playlistId = (args["id"] as? String) ?? ""
            Task { @MainActor in
                let result = try? await Catalog.playlist(playlistId)
                if let result {
                    dispatchEvent("spotitube-playlist", ["id": playlistId,
                                                          "playlist": ["name": result["name"] ?? "YouTube playlist",
                                                                       "videos": result["videos"] ?? []]])
                } else {
                    dispatchEvent("spotitube-playlist", ["id": playlistId, "playlist": NSNull()])
                }
            }
        case "metadata":
            let videoId = (args["id"] as? String) ?? ""
            Task { @MainActor in
                let result = try? await Catalog.metadata(videoId)
                if let result, let responseId = optionalValidResponseId(id) {
                    respond(responseId, ["id": result.id,
                                         "title": result.title,
                                         "author_name": result.authorName,
                                         "thumbnail_url": result.thumbnailURL])
                } else if let responseId = optionalValidResponseId(id) {
                    respond(responseId, NSNull())
                }
            }
        case "downloads":
            if let responseId = optionalValidResponseId(id) { respond(responseId, downloads.completed) }
        case "artist":
            let request = (args["request"] as? Int) ?? Int((args["request"] as? Double) ?? 0)
            let url = (args["url"] as? String) ?? ""
            Task { @MainActor in
                let result = try? await Catalog.artist(url)
                if let result {
                    dispatchEvent("spotitube-artist", ["request": request, "artist": result])
                } else {
                    dispatchEvent("spotitube-artist", ["request": request, "artist": NSNull()])
                }
            }
        case "setNormalize":
            break // not supported yet; toggle is hidden on iOS
        case "editQueue":
            playback.edit(key: (args["key"] as? String) ?? "",
                          direction: (args["direction"] as? Int) ?? Int((args["direction"] as? Double) ?? 0))
        case "cancelDownload":
            downloads.cancel((args["id"] as? String) ?? "")
        case "retryDownload":
            downloads.retry((args["id"] as? String) ?? "")
        case "checkUpdates":
            if let url = URL(string: "https://github.com/just-crow/Spotitube/releases/latest") {
                UIApplication.shared.open(url)
            }
        case "download":
            let video = Video(id: (args["id"] as? String) ?? "",
                              title: (args["title"] as? String) ?? "",
                              authorName: (args["artist"] as? String) ?? "",
                              channelURL: nil,
                              duration: nil)
            var thumbnail = Video(id: video.id, title: video.title)
            thumbnail.thumbnailURL = (args["thumb"] as? String) ?? video.thumbnailURL
            downloads.enqueue(thumbnail)
        case "deleteDownload":
            downloads.remove((args["id"] as? String) ?? "")
            dispatchEvent("spotitube-download", ["id": (args["id"] as? String) ?? "",
                                                  "status": "removed",
                                                  "progress": 0, "received": 0, "total": 0])
        default:
            break
        }
    }

    private func handleControl(action: String, value: Double) {
        switch action {
        case "play": playback.play()
        case "pause": playback.pause()
        case "seek": playback.seek(value)
        case "next": playback.step(1)
        case "prev": playback.step(-1)
        case "volume": playback.player.volume = Float(max(0, min(1, value > 1 ? value / 100 : value)))
        default: break
        }
    }

    private func queueEntries(_ raw: Any?) -> [QueueEntry] {
        guard let items = raw as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let id = item["id"] as? String, validVideoID(id) else { return nil }
            return QueueEntry(id: id,
                              title: (item["title"] as? String) ?? "",
                              authorName: (item["author_name"] as? String) ?? "",
                              key: (item["key"] as? String) ?? id)
        }
    }

    nonisolated private func videoPayload(_ video: Video) -> [String: Any] {
        var output: [String: Any] = ["id": video.id,
                                     "title": video.title,
                                     "author_name": video.authorName,
                                     "thumbnail_url": video.thumbnailURL]
        if let duration = video.duration { output["duration"] = duration }
        if let channel = video.channelURL { output["channel_url"] = channel }
        return output
    }

    private func optionalValidResponseId(_ id: Int) -> Int? { id >= 0 ? id : nil }

    // MARK: - Native -> JS push

    @MainActor
    fileprivate func dispatchEvent(_ name: String, _ detail: Any) {
        evaluateJavaScript("window.__spotEvent('\(name)', \(jsonString(detail)))")
    }

    @MainActor
    fileprivate func respond(_ id: Int, _ result: Any) {
        evaluateJavaScript("window.__spotMessage({ id: \(id), result: \(jsonString(result)) })")
    }

    private func evaluateJavaScript(_ source: String) {
        webView?.evaluateJavaScript(source, completionHandler: nil)
    }

    @MainActor
    func pushState() {
        var state = playback.state
        state["version"] = bundleVersion
        state["editableQueue"] = true
        evaluateJavaScript("window.__spotEvent('spotitube-state', \(jsonString(state)))")
    }

    @MainActor
    func pushDownloads() {
        let jobs = downloads.jobs.map { job -> [String: Any] in
            ["id": job.id, "title": job.title, "author_name": job.authorName,
             "thumbnail_url": job.thumbnailURL, "status": job.status,
             "received": job.received, "total": job.total, "at": job.at]
        }
        evaluateJavaScript("window.__spotEvent('spotitube-downloads', \(jsonString(jobs)))")
        for job in downloads.jobs {
            let previous = lastDownloadStatus[job.id]
            let force = previous != job.status
            let throttled = Date().timeIntervalSince(downloadThrottle[job.id] ?? .distantPast) >= 0.25
            if force || throttled || job.status == "completed" {
                downloadThrottle[job.id] = Date()
                lastDownloadStatus[job.id] = job.status
                let status: String
                switch job.status {
                case "completed": status = "done"
                case "failed", "canceled": status = "error"
                default: status = "downloading"
                }
                let progress = job.total > 0 ? Double(job.received) / Double(job.total) : 0
                dispatchEvent("spotitube-download", ["id": job.id, "status": status,
                                                     "progress": progress,
                                                     "received": job.received,
                                                     "total": job.total])
            }
        }
    }
}

// MARK: - Navigation: stay in-app; push external links to Safari

extension WebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        NSLog("SpotiWeb: didStartProvisionalNavigation")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("SpotiWeb: didFinish navigation")
        webView.evaluateJavaScript("document.title + ' | mainChars=' + (document.querySelector('main')?.innerText?.length ?? -1) + ' | readyState=' + document.readyState") { value, error in
            NSLog("SpotiWeb: probe title=%@ error=%@", String(describing: value), String(describing: error))
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("SpotiWeb: didFail %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("SpotiWeb: didFailProvisionalNavigation %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        if navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true {
            let url = navigationAction.request.url
            if url?.scheme != "spotitube", let url, UIApplication.shared.canOpenURL(url) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel, preferences)
                return
            }
        }
        decisionHandler(.allow, preferences)
    }
}

/// Message sink bridging the web worker to the controller.
final class WebEngineBridge: NSObject, WKScriptMessageHandler {
    weak var owner: WebController?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if let dict = message.body as? [String: Any] {
            DispatchQueue.main.async { [weak owner] in
                guard let owner else { return }
                MainActor.assumeIsolated { owner.handle(dict) }
            }
            return
        }
        if let text = message.body as? String,
           let data = text.data(using: .utf8),
           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            DispatchQueue.main.async { [weak owner] in
                guard let owner else { return }
                MainActor.assumeIsolated { owner.handle(dict) }
            }
        }
    }
}

/// Serves the bundled Web/ folder over spotitube://local/ — mirrors Android's spotitube.local.
final class SpotSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL? = {
        Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true)
    }()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url
        var path = url?.path ?? ""
        if path == "/" { path = "/index.html" }
        NSLog("SpotiWeb: scheme request %@", url?.absoluteString ?? "nil")
        let allowed = path.range(of: #"^/(index\.html|assets/[A-Za-z0-9_.-]+)$"#, options: .regularExpression) != nil
        guard allowed, let root, let file = fileURL(path: path, under: root),
              let data = try? Data(contentsOf: file) else {
            NSLog("SpotiWeb: 404 for %@ (allowed=%d root=%@)", path, allowed, root?.path ?? "nil")
            fail(urlSchemeTask, path: path, url: url)
            return
        }
        let response = HTTPURLResponse(url: url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mimeType(path: path),
            "Cache-Control": "max-age=3600",
        ])!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fileURL(path: String, under root: URL) -> URL? {
        let relative = String(path.dropFirst())
        let candidate = root.appendingPathComponent(relative)
        let standardized = candidate.standardizedFileURL
        guard standardized.path.hasPrefix(root.standardizedFileURL.path) else { return nil }
        return standardized
    }

    private func fail(_ task: WKURLSchemeTask, path: String, url: URL?) {
        let response = HTTPURLResponse(url: url ?? URL(string: "spotitube://local/404")!,
                                       statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
        task.didReceive(response)
        task.didReceive(Data())
        task.didFinish()
    }

    private func mimeType(path: String) -> String {
        if path.hasSuffix(".js") { return "application/javascript" }
        if path.hasSuffix(".css") { return "text/css" }
        if path.hasSuffix(".html") { return "text/html; charset=utf-8" }
        if path.hasSuffix(".json") { return "application/json" }
        if path.hasSuffix(".png") { return "image/png" }
        if path.hasSuffix(".jpg") || path.hasSuffix(".jpeg") { return "image/jpeg" }
        if path.hasSuffix(".svg") { return "image/svg+xml" }
        if path.hasSuffix(".webp") { return "image/webp" }
        if path.hasSuffix(".woff2") { return "font/woff2" }
        return "application/octet-stream"
    }
}
