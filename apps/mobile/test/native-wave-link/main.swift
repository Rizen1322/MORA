import Foundation

func parse(_ text: String) -> NativeWaveLink? { URL(string: text).flatMap(NativeWaveLink.init) }
assert(parse("mora://wave")?.source == nil)
for source in ["own", "online", "yandex"] {
    assert(parse("mora://wave?source=\(source)")?.source == source)
}
assert(parse("mora://wave?source=unknown")?.source == nil)
assert(parse("mora://wave?source=")?.source == nil)
assert(parse("mora://wave?source=yandex&source=own")?.source == nil)
assert(parse("mora://wave?source=%79andex")?.source == "yandex")
assert(parse("https://wave?source=own") == nil)
assert(parse("mora://player?source=own") == nil)
assert(parse("mora://wave/other?source=own") == nil)
assert(parse("MORA://WAVE?source=own")?.source == "own")
print("Native wave links passed")
