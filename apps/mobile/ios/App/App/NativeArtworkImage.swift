import CoreGraphics
import Foundation
import ImageIO

/// Decode a bounded thumbnail before playback, never in a producer/audio callback.
enum NativeArtworkImage {
    static func decode(_ base64: String) -> CGImage? {
        guard !base64.isEmpty, base64.utf8.count <= 2_800_000,
              let data = Data(base64Encoded: base64), data.count <= 2 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 8192, height <= 8192 else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 512,
        ] as CFDictionary)
    }
}
