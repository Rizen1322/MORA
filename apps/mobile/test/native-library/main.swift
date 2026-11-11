import Foundation
import SQLite3

func require(_ condition: Bool, _ message: String) {
    precondition(condition, message)
}
let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mora-library-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: folder) }
let missing = folder.appendingPathComponent("missing.sqlite").path
do { _ = try NativeLibraryStore(path: missing); fatalError("Reader created a missing database") }
catch { require(!FileManager.default.fileExists(atPath: missing), "Missing database must not be created") }

var writer: OpaquePointer?
let path = folder.appendingPathComponent("automix.sqlite").path
require(sqlite3_open(path, &writer) == SQLITE_OK, "Writer open")
defer { sqlite3_close_v2(writer) }
func write(_ sql: String) {
    require(sqlite3_exec(writer, sql, nil, nil, nil) == SQLITE_OK, "Writer: \(String(cString: sqlite3_errmsg(writer)))")
}
write("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE tracks(id TEXT PRIMARY KEY,title TEXT,artist TEXT,album TEXT,duration REAL,status TEXT,added_at INTEGER,saved INTEGER,pinned INTEGER,cover_id TEXT,provider TEXT);
    CREATE TABLE reactions(track_id TEXT PRIMARY KEY,value INTEGER,updated_at INTEGER);
    CREATE TABLE track_sources(id INTEGER PRIMARY KEY,track_id TEXT,kind TEXT,provider TEXT,meta TEXT);
    CREATE TABLE track_bindings(track_id TEXT PRIMARY KEY,asset_id TEXT);
    CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT,updated_at INTEGER);
    CREATE TABLE playlist_tracks(id INTEGER PRIMARY KEY,playlist_id TEXT,track_id TEXT,position INTEGER);
    CREATE TABLE plays(id INTEGER PRIMARY KEY,track_id TEXT,started_at INTEGER,played_ms INTEGER,end_reason TEXT);
    INSERT INTO tracks VALUES('one','Песня ё','Артист','Альбом',180,'ok',10,1,0,'cover','local');
    INSERT INTO tracks VALUES('asset','Recording','Artist','',240,'ok',11,0,0,NULL,'youtube');
    INSERT INTO tracks VALUES('two','Другая','','',120,'ok',12,1,0,NULL,'yandex');
    INSERT INTO reactions VALUES('one',1,100),('two',1,200);
    INSERT INTO track_sources VALUES(1,'one','managed','local','{}'),(2,'asset','remote','youtube','{}'),
      (3,'two','remote','yandex','{"coverUrl":"https://avatars.mds.yandex.net/get-music/x"}');
    INSERT INTO track_bindings VALUES('one','asset');
    INSERT INTO playlists VALUES('p','Любимые',20);
    INSERT INTO playlist_tracks VALUES(12,'p','one',1),(11,'p','one',0),(13,'p','asset',2);
    INSERT INTO plays VALUES(1,'one',1000,5000,'skip'),(2,'asset',2000,10000,'transition');
    """)
let reader = try NativeLibraryStore(path: path)
let first = try reader.readIfChanged()!
require(first.tracks.count == 3 && first.library.map(\.id) == ["two", "one"], "Saved library excludes playback-only tracks")
require(first.tracks.first { $0.id == "one" }?.duration == 240, "Duration follows the bound recording")
require(first.tracks.first { $0.id == "one" }?.binding == "asset", "Binding preserved")
require(first.tracks.first { $0.id == "one" }?.offline == false, "Offline availability follows the bound remote asset")
require(first.tracks.first { $0.id == "one" }?.cover == "/api/covers/cover", "Local cover")
require(first.tracks.first { $0.id == "two" }?.cover == "https://avatars.mds.yandex.net/get-music/x", "Yandex cover")
require(first.tracks.first { $0.id == "asset" }?.offline == false, "Remote unpinned asset is not offline")
require(NativeTrack.favorites(first.library).map(\.id) == ["two", "one"], "Likes keep reaction timestamp order")
require(first.entries["p"]?.map(\.id) == [11, 12, 13], "Playlist order and duplicate track entries preserved")
require(first.playlists.first?.count == 3 && first.history.map(\.id) == [2, 1], "Playlist count and history order")
require(try reader.readIfChanged() == nil, "No new snapshot for an unchanged database")

let page = try first.page("/playlist/p")!
let nativePage = NativePage(page)!
require(nativePage.sections.last?.rows.count == 3, "Native playlist renders repeated entries and unsaved assets")
let history = NativePage(try first.page("/history"))!
require(history.sections.last?.rows.count == 2, "Native history includes playback-only tracks")
do { _ = try first.page("/playlist/missing"); fatalError("Missing playlist was accepted") } catch {}

write("BEGIN; UPDATE tracks SET title='Не видно' WHERE id='one'; UPDATE reactions SET value=-1 WHERE track_id='one';")
let uncommitted = try reader.readIfChanged(force: true)!
require(uncommitted.tracks.first { $0.id == "one" }?.title == "Песня ё", "Read-only connection sees only committed WAL data")
write("COMMIT")
let committed = try reader.readIfChanged()!
let changed = committed.tracks.first { $0.id == "one" }!
require(changed.title == "Не видно" && changed.reaction == -1, "Server commit refreshes metadata and reactions together")
write("UPDATE track_sources SET meta='{\"coverUrl\":\"https://untrusted.example/x\"}' WHERE track_id='two'")
let invalidCover = try reader.readIfChanged()!
require(invalidCover.tracks.first { $0.id == "two" }?.cover == nil, "Untrusted Yandex cover is rejected")
write("DELETE FROM plays; DELETE FROM playlist_tracks; DELETE FROM playlists;")
let cleared = try reader.readIfChanged()!
require(cleared.history.isEmpty && cleared.playlists.isEmpty && cleared.entries.isEmpty, "Deletes are reflected without page events")
print("Native library: read-only WAL, commits, saved tracks, likes, bindings, duplicate entries, history and covers passed")
