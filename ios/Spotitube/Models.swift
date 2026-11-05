import Foundation

struct Video: Codable, Equatable {
    var id: String
    var title: String
    var authorName: String
    var thumbnailURL: String
    var channelURL: String?
    var duration: Double?

    enum CodingKeys: String, CodingKey {
        case id, title, duration
        case authorName = "author_name"
        case thumbnailURL = "thumbnail_url"
        case channelURL = "channel_url"
    }

    init(id: String, title: String, authorName: String = "", channelURL: String? = nil, duration: Double? = nil) {
        self.id = id
        self.title = title
        self.authorName = authorName
        self.thumbnailURL = "https://i.ytimg.com/vi/\(id)/mqdefault.jpg"
        self.channelURL = channelURL
        self.duration = duration
    }
}

struct QueueEntry: Codable, Equatable {
    var id: String
    var title: String
    var authorName: String
    var key: String
    enum CodingKeys: String, CodingKey {
        case id, title, key
        case authorName = "author_name"
    }
}

enum SpotError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}

func jsonObject<T: Encodable>(_ value: T) -> Any {
    guard let data = try? JSONEncoder().encode(value),
          let result = try? JSONSerialization.jsonObject(with: data) else { return NSNull() }
    return result
}

func jsonString(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object),
          let string = String(data: data, encoding: .utf8) else { return "{}" }
    return string
}

func validVideoID(_ id: String) -> Bool {
    id.range(of: #"^[A-Za-z0-9_-]{11}$"#, options: .regularExpression) != nil
}
