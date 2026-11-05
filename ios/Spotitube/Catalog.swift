import Foundation

enum Catalog {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 18
        config.timeoutIntervalForResource = 30
        config.httpAdditionalHeaders = ["User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9"]
        return URLSession(configuration: config)
    }()

    static func request(_ url: URL) async throws -> Data {
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SpotError.message("YouTube could not load this content.")
        }
        return data
    }

    static func api(_ endpoint: String, _ values: [String: Any]) async throws -> [String: Any] {
        var body = values
        body["context"] = ["client": ["clientName": "WEB", "clientVersion": "2.20241104.01.00", "hl": "en", "gl": "US"]]
        var request = URLRequest(url: URL(string: "https://www.youtube.com/youtubei/v1/" + endpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SpotError.message("YouTube search is unavailable. Try again.")
        }
        return result
    }

    static func metadata(_ id: String) async throws -> Video {
        guard validVideoID(id) else { throw SpotError.message("Invalid YouTube video ID.") }
        var url = URLComponents(string: "https://www.youtube.com/oembed")!
        url.queryItems = [URLQueryItem(name: "url", value: "https://www.youtube.com/watch?v=" + id),
                          URLQueryItem(name: "format", value: "json")]
        let data = try await request(url.url!)
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let title = value["title"] as? String else { throw SpotError.message("Video metadata unavailable.") }
        var video = Video(id: id, title: title, authorName: value["author_name"] as? String ?? "",
                          channelURL: value["author_url"] as? String)
        video.thumbnailURL = value["thumbnail_url"] as? String ?? video.thumbnailURL
        return video
    }

    static func search(_ query: String, musicOnly: Bool) async throws -> [Video] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, query.count <= 120 else { return [] }
        let data = try await api("search", ["query": query, "params": "EgIQAQ%3D%3D"])
        let candidates = videos(data)
        if !musicOnly { return Array(candidates.prefix(20)) }
        // Category checks keep the same conservative fallback as Android.
        return await withTaskGroup(of: (Int, Video?).self) { group in
            for (index, video) in candidates.prefix(9).enumerated() {
                group.addTask {
                    guard !Task.isCancelled else { return (index, nil) }
                    let music = (try? await isMusic(video.id)) ?? false
                    return (index, music ? video : nil)
                }
            }
            var result: [(Int, Video)] = []
            for await (index, video) in group { if let video { result.append((index, video)) } }
            return result.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }

    static func isMusic(_ id: String) async throws -> Bool {
        let response = try await api("player", ["videoId": id])
        if let microformat = response["microformat"] as? [String: Any],
           let renderer = microformat["playerMicroformatRenderer"] as? [String: Any],
           let category = renderer["category"] as? String {
            return category.caseInsensitiveCompare("Music") == .orderedSame
        }
        let html = String(decoding: try await request(URL(string: "https://www.youtube.com/watch?v=" + id)!), as: UTF8.self)
        let player = try embeddedObject(html, marker: "ytInitialPlayerResponse")
        let microformat = player["microformat"] as? [String: Any]
        let renderer = microformat?["playerMicroformatRenderer"] as? [String: Any]
        return (renderer?["category"] as? String)?.caseInsensitiveCompare("Music") == .orderedSame
    }

    static func radio(_ id: String, musicOnly: Bool) async throws -> [Video] {
        if musicOnly {
            let seed = try await metadata(id)
            // Prefer the title's "Artist - Song" split when the uploader is a
            // topic/lyrics channel that doesn't belong to the artist.
            let stripped = seed.authorName.replacingOccurrences(of: #"(?i)( - Topic|VEVO| Official)$"#,
                                                                with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            var artist = stripped
            if let dash = seed.title.range(of: " - ") {
                let titleArtist = seed.title[..<dash.lowerBound].trimmingCharacters(in: .whitespaces)
                let collapse: (String) -> String = { $0.lowercased().replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression) }
                if !titleArtist.isEmpty && !collapse(stripped).contains(collapse(titleArtist)) {
                    artist = titleArtist
                }
            }
            if artist.isEmpty { artist = seed.authorName }
            return try await search(artist, musicOnly: true).filter { $0.id != id }
        }
        let response = try await api("next", ["videoId": id])
        return videos(response).filter { $0.id != id }
    }

    static func playlist(_ id: String) async throws -> [String: Any] {
        guard id.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil else {
            throw SpotError.message("Invalid playlist link.")
        }
        let html = String(decoding: try await request(URL(string: "https://www.youtube.com/playlist?list=" + id)!),
                          as: UTF8.self)
        let initial = try embeddedObject(html, marker: "ytInitialData")
        let lists = objects(initial, named: "playlistVideoListRenderer")
        guard let list = lists.first else { throw SpotError.message("This playlist is private or unavailable.") }
        let header = objects(initial, named: "playlistSidebarPrimaryInfoRenderer").first
        let name = header.map { text($0["title"]) }.flatMap { $0.isEmpty ? nil : $0 } ?? "YouTube playlist"
        var items = videos(list, keepDuplicates: true)
        var continuation = continuationToken(list)
        var seen = Set<String>()
        var page = 0
        while let token = continuation {
            try Task.checkCancellation()
            guard seen.insert(token).inserted, page < 100 else {
                throw SpotError.message("Playlist pagination could not finish. Your saved copy was kept.")
            }
            page += 1
            let response = try await api("browse", ["continuation": token])
            let actions = objects(response, named: "appendContinuationItemsAction")
            let legacy = objects(response, named: "playlistVideoListContinuation")
            guard let content = actions.first ?? legacy.first else {
                throw SpotError.message("Playlist refresh was incomplete. Try again.")
            }
            items.append(contentsOf: videos(content, keepDuplicates: true))
            continuation = continuationToken(content)
        }
        return ["name": name, "videos": jsonObject(items)]
    }

    static func artist(_ address: String) async throws -> [String: Any] {
        guard let url = URL(string: address), url.scheme == "https",
              ["www.youtube.com", "youtube.com", "music.youtube.com"].contains(url.host ?? "") else {
            throw SpotError.message("Invalid artist page.")
        }
        let html = String(decoding: try await request(url), as: UTF8.self)
        let initial = try embeddedObject(html, marker: "ytInitialData")
        let metadata = objects(initial, named: "channelMetadataRenderer").first ?? [:]
        let name = metadata["title"] as? String ?? "Artist"
        return ["name": name, "description": metadata["description"] as? String ?? "",
                "avatar_url": "", "channel_url": address, "uploads": jsonObject(try await search(name, musicOnly: true)),
                "playlists": []]
    }

    static func text(_ value: Any?) -> String {
        if let value = value as? String { return value }
        guard let value = value as? [String: Any] else { return "" }
        if let simple = value["simpleText"] as? String { return simple }
        return (value["runs"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
    }

    static func objects(_ value: Any, named key: String) -> [[String: Any]] {
        if let object = value as? [String: Any] {
            var output = (object[key] as? [String: Any]).map { [$0] } ?? []
            for (name, child) in object where name != key { output += objects(child, named: key) }
            return output
        }
        if let array = value as? [Any] { return array.flatMap { objects($0, named: key) } }
        return []
    }

    private static func continuationToken(_ value: Any) -> String? {
        objects(value, named: "continuationCommand").compactMap { $0["token"] as? String }.first
    }

    static func videos(_ value: Any, keepDuplicates: Bool = false) -> [Video] {
        let renderers = ["videoRenderer", "compactVideoRenderer", "playlistVideoRenderer"]
            .flatMap { objects(value, named: $0) }
        var seen = Set<String>()
        return renderers.compactMap { item in
            guard let id = item["videoId"] as? String, validVideoID(id),
                  keepDuplicates || seen.insert(id).inserted else { return nil }
            let title = text(item["title"])
            guard !title.isEmpty else { return nil }
            let byline = (item["ownerText"] ?? item["shortBylineText"] ?? item["longBylineText"]) as? [String: Any]
            let run = (byline?["runs"] as? [[String: Any]])?.first
            let endpoint = run?["navigationEndpoint"] as? [String: Any]
            let browse = endpoint?["browseEndpoint"] as? [String: Any]
            let channel = browse?["browseId"] as? String
            let duration = text(item["lengthText"]).split(separator: ":").reduce(0.0) { $0 * 60 + (Double($1) ?? 0) }
            return Video(id: id, title: title, authorName: text(byline),
                         channelURL: channel.map { "https://www.youtube.com/channel/" + $0 },
                         duration: duration > 0 ? duration : nil)
        }
    }

    /// Extract a balanced JSON object without stopping at braces inside quoted strings.
    static func embeddedObject(_ html: String, marker: String) throws -> [String: Any] {
        guard let markerRange = html.range(of: marker),
              let start = html[markerRange.upperBound...].firstIndex(of: "{") else {
            throw SpotError.message("YouTube returned an unsupported page.")
        }
        var depth = 0, quoted = false, escaped = false
        for index in html[start...].indices {
            let character = html[index]
            if quoted {
                if escaped { escaped = false }
                else if character == "\\" { escaped = true }
                else if character == "\"" { quoted = false }
            } else if character == "\"" { quoted = true }
            else if character == "{" { depth += 1 }
            else if character == "}" {
                depth -= 1
                if depth == 0 {
                    let data = Data(html[start...index].utf8)
                    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { break }
                    return object
                }
            }
        }
        throw SpotError.message("YouTube page data was incomplete.")
    }
}
