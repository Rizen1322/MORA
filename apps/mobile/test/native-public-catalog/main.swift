import Foundation

// Self-check for NativePublicCatalog.swift: ID validation, duration parsing, YouTube Music browse & search
// parsing (artist & album headers, tracks, greyed-out skip, album cards, thumbnail host whitelist, breaker).

func fail(_ message: String) -> Never { fatalError("FAIL: " + message) }
func check(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
func jsonData(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }

// MARK: IDs & duration

let artistId = "UC1234567890123456789012"
let albumId = "MPREb_12345678"
check(NativePublicCatalog.validCatalogId(type: "artist", id: artistId), "valid UC artist id")
check(!NativePublicCatalog.validCatalogId(type: "artist", id: "UCshort"), "short artist id rejected")
check(NativePublicCatalog.validCatalogId(type: "album", id: albumId), "valid MPRE album id")
check(!NativePublicCatalog.validCatalogId(type: "album", id: "../evil"), "bad album id rejected")
check(NativePublicCatalog.parseDuration("3:45") == 225, "mm:ss duration")
check(NativePublicCatalog.parseDuration("1:02:03") == 3723, "hh:mm:ss duration")
check(NativePublicCatalog.parseDuration("bad") == 0, "invalid duration returns 0")

// MARK: browse parsing (artist & album)

func artistRun(_ name: String, id: String) -> [String: Any] {
    ["text": name, "navigationEndpoint": ["browseEndpoint": ["browseId": id, "browseEndpointContextSupportedConfigs": ["browseEndpointContextMusicConfig": ["pageType": "MUSIC_PAGE_TYPE_ARTIST"]]]]]
}

let artistJson: [String: Any] = [
    "header": [
        "musicImmersiveHeaderRenderer": [
            "title": ["simpleText": "Test Artist"],
            "description": ["simpleText": "Artist bio"],
            "thumbnail": ["musicThumbnailRenderer": ["thumbnail": ["thumbnails": [
                ["url": "https://evil.example/bad.jpg", "width": 640],
                ["url": "https://lh3.googleusercontent.com/good=w640-h640", "width": 640],
            ]]]],
        ],
    ],
    "contents": [
        "singleColumnBrowseResultsRenderer": [
            "tabs": [[
                "tabRenderer": [
                    "content": [
                        "sectionListRenderer": [
                            "contents": [
                                [
                                    "musicShelfRenderer": [
                                        "contents": [
                                            [
                                                "musicResponsiveListItemRenderer": [
                                                    "playlistItemData": ["videoId": "dQw4w9WgXcQ"],
                                                    "flexColumns": [
                                                        ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Song One"]]]]],
                                                        ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [artistRun("Test Artist", id: artistId)]]]],
                                                    ],
                                                    "fixedColumns": [
                                                        ["musicResponsiveListItemFixedColumnRenderer": ["text": ["simpleText": "3:20"]]],
                                                    ],
                                                    "badges": [["musicInlineBadgeRenderer": ["icon": ["iconType": "MUSIC_EXPLICIT_BADGE"]]]],
                                                ],
                                            ],
                                            [
                                                "musicResponsiveListItemRenderer": [
                                                    "playlistItemData": ["videoId": "aaaaaaaaaaa"],
                                                    "musicItemRendererDisplayPolicy": "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT",
                                                    "flexColumns": [
                                                        ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Greyed"]]]]],
                                                    ],
                                                ],
                                            ],
                                        ],
                                    ],
                                ],
                                [
                                    "musicCarouselShelfRenderer": [
                                        "contents": [[
                                            "musicTwoRowItemRenderer": [
                                                "title": ["runs": [["text": "Album Title", "navigationEndpoint": ["browseEndpoint": ["browseId": albumId, "browseEndpointContextSupportedConfigs": ["browseEndpointContextMusicConfig": ["pageType": "MUSIC_PAGE_TYPE_ALBUM"]]]]]]],
                                                "subtitle": ["runs": [artistRun("Test Artist", id: artistId)]],
                                                "thumbnailRenderer": ["musicThumbnailRenderer": ["thumbnail": ["thumbnails": [["url": "https://i.ytimg.com/vi/abc/hqdefault.jpg", "width": 480]]]]],
                                            ],
                                        ]],
                                    ],
                                ],
                            ],
                        ],
                    ],
                ],
            ]],
        ],
    ],
]

let albumJson: [String: Any] = [
    "header": [
        "musicDetailHeaderRenderer": [
            "title": ["runs": [["text": "Album Title"]]],
            "subtitle": ["runs": [artistRun("Test Artist", id: artistId)]],
            "thumbnail": ["musicThumbnailRenderer": ["thumbnail": ["thumbnails": [["url": "https://i.ytimg.com/vi/album/max.jpg", "width": 544]]]]],
        ],
    ],
    "contents": [
        "twoColumnBrowseResultsRenderer": [
            "secondaryContents": [
                "sectionListRenderer": [
                    "contents": [[
                        "musicShelfRenderer": [
                            "contents": [[
                                "musicResponsiveListItemRenderer": [
                                    "playlistItemData": ["videoId": "xyz12345678"],
                                    "flexColumns": [
                                        ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Track A"]]]]],
                                        ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [artistRun("Test Artist", id: artistId), ["text": " • "], ["text": "4:01"]]]]],
                                    ],
                                ],
                            ]],
                        ],
                    ]],
                ],
            ],
        ],
    ],
]

let searchJson: [String: Any] = [
    "contents": [
        "tabbedSearchResultsRenderer": [
            "tabs": [[
                "tabRenderer": [
                    "content": [
                        "sectionListRenderer": [
                            "contents": [[
                                "musicShelfRenderer": [
                                    "contents": [[
                                        "musicResponsiveListItemRenderer": [
                                            "playlistItemData": ["videoId": "dQw4w9WgXcQ"],
                                            "flexColumns": [
                                                ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [["text": "Found Song"]]]]],
                                                ["musicResponsiveListItemFlexColumnRenderer": ["text": ["runs": [artistRun("Singer", id: artistId), ["text": " • "], ["text": "Album"], ["text": " • "], ["text": "2:30"]]]]],
                                            ],
                                            "thumbnail": ["musicThumbnailRenderer": ["thumbnail": ["thumbnails": [["url": "https://lh3.googleusercontent.com/s=w120-h120"]]]]],
                                        ],
                                    ]],
                                ],
                            ]],
                        ],
                    ],
                ],
            ]],
        ],
    ],
]

var requests = 0
let publicCatalog = NativePublicCatalog { req, _ in
    requests += 1
    let body = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any]) ?? [:]
    if req.url?.path.contains("/browse") == true {
        let bid = body["browseId"] as? String ?? ""
        if bid == artistId { return (200, jsonData(artistJson)) }
        if bid == albumId { return (200, jsonData(albumJson)) }
    }
    if req.url?.path.contains("/search") == true {
        return (200, jsonData(searchJson))
    }
    return (404, Data())
}

let artist = try await publicCatalog.artist(artistId)
check(artist["title"] as? String == "Test Artist", "artist title")
check(artist["coverUrl"] as? String == "https://lh3.googleusercontent.com/good=w640-h640", "thumbnail whitelist picks valid host over bad host")
let artistTracks = artist["tracks"] as? [[String: Any]] ?? []
check(artistTracks.count == 1 && artistTracks[0]["externalId"] as? String == "dQw4w9WgXcQ", "greyed out track dropped")
check(artistTracks[0]["explicit"] as? Bool == true && (artistTracks[0]["duration"] as? NSNumber)?.doubleValue == 200, "explicit & duration parsed")
let artistAlbums = artist["albums"] as? [[String: Any]] ?? []
check(artistAlbums.count == 1 && artistAlbums[0]["id"] as? String == albumId, "album shelf parsed")

let callsBeforeCache = requests
_ = try await publicCatalog.artist(artistId)
check(requests == callsBeforeCache, "browse result cached")

let album = try await publicCatalog.album(albumId)
check(album["title"] as? String == "Album Title", "album title")
let albumTracks = album["tracks"] as? [[String: Any]] ?? []
check(albumTracks.count == 1 && albumTracks[0]["album"] as? String == "Album Title" && (albumTracks[0]["duration"] as? NSNumber)?.doubleValue == 241, "twoColumn album tracks parsed")

let found = try await publicCatalog.search("singer", kind: "song")
check(found.count == 1 && found[0]["coverUrl"] as? String == "https://lh3.googleusercontent.com/s=w544-h544", "search resized thumb")

// Circuit breaker trips after 3 consecutive failures
var failingCalls = 0
let broken = NativePublicCatalog { _, _ in
    failingCalls += 1
    return (502, Data())
}
for _ in 0..<3 {
    do { _ = try await broken.artist(artistId); fail("502 must throw") } catch {}
}
do { _ = try await broken.artist(artistId); fail("breaker open must throw") } catch {}
check(failingCalls == 3, "circuit breaker prevented 4th call while open: \(failingCalls)")

print("Native public catalog: IDs, artist/album browse, search parsing, thumbnail whitelist and circuit breaker passed")
