import XCTest
@testable import Spotitube

final class CatalogTests: XCTestCase {

    private func json(_ text: String) -> Any {
        try! JSONSerialization.jsonObject(with: Data(text.utf8))
    }

    func testValidVideoID() {
        XCTAssertTrue(validVideoID("dQw4w9WgXcQ"))
        XCTAssertFalse(validVideoID("dQw4w9WgXc"))
        XCTAssertFalse(validVideoID("dQw4w9WgXc!"))
        XCTAssertFalse(validVideoID(""))
    }

    func testTextFromRunsAndSimpleText() {
        XCTAssertEqual(Catalog.text("plain"), "plain")
        XCTAssertEqual(Catalog.text(json(#"{"simpleText":"hi"}"#)), "hi")
        XCTAssertEqual(Catalog.text(json(#"{"runs":[{"text":"foo "},{"text":"bar"}]}"#)), "foo bar")
        XCTAssertEqual(Catalog.text(nil), "")
    }

    func testVideosParsesRendererAndDuration() {
        let page = json(#"""
        {"contents": [{"videoRenderer": {
            "videoId": "dQw4w9WgXcQ",
            "title": {"runs": [{"text": "Never Gonna Give You Up"}]},
            "ownerText": {"runs": [{"text": "Rick Astley",
                "navigationEndpoint": {"browseEndpoint": {"browseId": "UC123"}}}]},
            "lengthText": {"simpleText": "3:33"}
        }}]}
        """#)
        let videos = Catalog.videos(page)
        XCTAssertEqual(videos.count, 1)
        XCTAssertEqual(videos[0].title, "Never Gonna Give You Up")
        XCTAssertEqual(videos[0].duration, 213)
        XCTAssertEqual(videos[0].channelURL, "https://www.youtube.com/channel/UC123")
    }

    func testVideosDeduplicatesByDefault() {
        let page = json(#"""
        {"a": {"videoRenderer": {"videoId": "dQw4w9WgXcQ", "title": {"simpleText": "one"}}},
         "b": {"videoRenderer": {"videoId": "dQw4w9WgXcQ", "title": {"simpleText": "one copy"}}}}
        """#)
        XCTAssertEqual(Catalog.videos(page).count, 1)
        XCTAssertEqual(Catalog.videos(page, keepDuplicates: true).count, 2)
    }

    func testEmbeddedObjectHandlesBracesInsideStrings() {
        let html = #"xx ytInitialData = {"a": "}{", "b": {"c": 2}} yy"#
        let object = try! Catalog.embeddedObject(html, marker: "ytInitialData")
        XCTAssertEqual(object["a"] as? String, "}{")
        XCTAssertEqual((object["b"] as? [String: Any])?["c"] as? Int, 2)
    }

    func testEmbeddedObjectThrowsOnMissingObject() {
        XCTAssertThrowsError(try Catalog.embeddedObject("no marker here", marker: "ytInitialData"))
    }
}
