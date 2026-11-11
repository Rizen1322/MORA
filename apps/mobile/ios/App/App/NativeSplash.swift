import UIKit

/// Cold-launch intro «Одна линия» (the scene of apps/web/src/lib/splash.ts), drawn with Core Animation
/// over the window from the first frame. It starts on LaunchScreen's night colour, so there is no blank gap
/// while the WebView loads: a sheet blooms, the brush draws the mark, MORA is set letter by letter, an amber
/// period, then ink eats the sheet and the app shows through. Tap skips.
@MainActor final class NativeSplashView: UIView {
    private static let night = UIColor(red: 5 / 255, green: 13 / 255, blue: 10 / 255, alpha: 1)
    private static let paper = UIColor(red: 0xec / 255, green: 0xe3 / 255, blue: 0xcf / 255, alpha: 1)
    private static let sun = UIColor(red: 0xe8 / 255, green: 0xa1 / 255, blue: 0x3a / 255, alpha: 1)
    /// Scene seconds: the mark is drawn by `line`, the word lands at `word`, the period at `dot`; from `hold` it waits for the app.
    private enum T { static let bloom = 0.5, line = 1.7, word = 2.0, dot = 2.5, hold = 2.75, flood = 0.8, maxWait = 10.0 }
    /// Where the ink breaks through, as [x, y, delay] in screen and flood fractions; the first sits on the period.
    private static let erode: [(CGFloat, CGFloat, Double)] = [(0, 0, 0), (0.16, 0.2, 0.1), (0.84, 0.76, 0.16), (0.24, 0.84, 0.24), (0.8, 0.14, 0.3), (0.5, 0.5, 0.36), (0.08, 0.52, 0.42)]

    private let ready: @MainActor () -> Bool
    private let started = CACurrentMediaTime()
    private var period = CGPoint.zero
    private var ending = false

    static func present(in window: UIWindow, ready: @escaping @MainActor () -> Bool) {
        let splash = NativeSplashView(frame: window.bounds, scale: window.screen.scale, ready: ready)
        splash.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(splash)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--native-ui-check") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                try? image.pngData()?.write(to: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("native-splash.png"))
            }
        }
        #endif
    }

    private init(frame: CGRect, scale: CGFloat, ready: @escaping @MainActor () -> Bool) {
        self.ready = ready
        super.init(frame: frame)
        backgroundColor = Self.night
        accessibilityViewIsModal = true
        isAccessibilityElement = true
        accessibilityLabel = "MORA"
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(skip)))
        build(still: UIAccessibility.isReduceMotionEnabled, scale: scale)
        wait()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func build(still: Bool, scale: CGFloat) {
        let W = bounds.width, H = bounds.height
        let mw = min(W * 0.52, H * 0.36), fs = mw * 0.19
        let cx = W / 2, cy = (H - mw * 0.68 - fs * 1.55) / 2 + mw * 0.34 - H * 0.015
        let u = mw / 951
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: cx + (x - 640) * u, y: cy + (y - 628) * u) }
        func clock(_ t: Double) -> CFTimeInterval { started + t }
        func animate(_ layer: CALayer, _ key: String, from: Any, to: Any, at t: Double, for d: Double, _ curve: CAMediaTimingFunctionName = .easeInEaseOut) {
            guard !still else { return }
            let a = CABasicAnimation(keyPath: key)
            a.fromValue = from; a.toValue = to
            a.beginTime = clock(t); a.duration = d
            a.fillMode = .both; a.isRemovedOnCompletion = false; a.timingFunction = CAMediaTimingFunction(name: curve)
            layer.add(a, forKey: key)
        }

        // the sheet, with a slow push-in that keeps the still frames alive
        let sheet = CALayer()
        sheet.frame = bounds
        sheet.backgroundColor = Self.paper.cgColor
        layer.addSublayer(sheet)
        animate(sheet, "transform.scale", from: 1, to: 1.025, at: 0, for: T.hold)

        // opening: the sheet blooms out of the night from the point the brush will touch
        let origin = p(245, 870), far = hypot(W, H) * 1.3
        let bloom = CAShapeLayer()
        bloom.frame = sheet.bounds
        bloom.path = UIBezierPath(arcCenter: origin, radius: far, startAngle: 0, endAngle: 2 * .pi, clockwise: true).cgPath
        sheet.mask = bloom
        animate(bloom, "path", from: UIBezierPath(arcCenter: origin, radius: 1, startAngle: 0, endAngle: 2 * .pi, clockwise: true).cgPath,
                to: bloom.path!, at: 0, for: T.bloom, .easeIn)
        let spark = CAShapeLayer()
        spark.path = UIBezierPath(arcCenter: origin, radius: mw * 0.016, startAngle: 0, endAngle: 2 * .pi, clockwise: true).cgPath
        spark.fillColor = Self.sun.cgColor
        spark.opacity = 0
        layer.addSublayer(spark)
        if !still {
            let flash = CAKeyframeAnimation(keyPath: "opacity")
            flash.values = [0, 1, 1, 0]; flash.keyTimes = [0, 0.37, 0.45, 1]
            flash.beginTime = clock(0); flash.duration = 0.48
            spark.add(flash, forKey: "opacity")
        }

        // the mark in one stroke: up, over the big arch, under the turn, over the small arch, down
        let mark = UIBezierPath()
        mark.move(to: p(245, 870)); mark.addLine(to: p(245, 558))
        mark.addArc(withCenter: p(418, 558), radius: 173 * u, startAngle: .pi, endAngle: 2 * .pi, clockwise: true)
        mark.addLine(to: p(591, 786))
        mark.addArc(withCenter: p(682, 786), radius: 91 * u, startAngle: .pi, endAngle: 0, clockwise: false)
        mark.addLine(to: p(773, 694))
        mark.addArc(withCenter: p(907, 694), radius: 134 * u, startAngle: .pi, endAngle: 2 * .pi, clockwise: true)
        mark.addLine(to: p(1041, 890))
        let brush = CAShapeLayer()
        brush.path = mark.cgPath
        brush.fillColor = nil
        brush.strokeColor = Self.night.cgColor
        brush.lineWidth = mw * 157 / 951
        brush.lineCap = .round; brush.lineJoin = .round
        sheet.addSublayer(brush)
        animate(brush, "strokeEnd", from: 0, to: 1, at: T.bloom, for: T.line - T.bloom)

        // MORA, set letter by letter: each one drops into place on its own tenth of a second
        let font = UIFont.systemFont(ofSize: fs, weight: .heavy, width: .expanded)
        let track = fs * 0.14, pr = fs * 0.09
        let widths = "MORA".map { String($0).size(withAttributes: [.font: font]).width }
        let wordW = widths.reduce(0) { $0 + $1 + track } + pr * 2
        let baseY = cy + mw * 0.34 + fs * 1.55
        var x = cx - wordW / 2
        for (i, (ch, w)) in zip("MORA", widths).enumerated() {
            let letter = CATextLayer()
            letter.string = String(ch)
            letter.font = font; letter.fontSize = fs
            letter.foregroundColor = Self.night.cgColor
            letter.contentsScale = scale
            letter.frame = CGRect(x: x, y: baseY - font.ascender, width: w + 2, height: font.lineHeight)
            sheet.addSublayer(letter)
            let t = T.word + Double(i) * 0.1
            animate(letter, "opacity", from: 0, to: 1, at: t, for: 0.04, .linear)
            animate(letter, "transform.translation.y", from: fs * 0.16, to: 0, at: t, for: 0.16, .easeOut)
            x += w + track
        }

        // the period: stamped amber
        period = CGPoint(x: cx + wordW / 2 - pr, y: baseY - pr)
        let dot = CAShapeLayer()
        dot.frame = CGRect(x: period.x - pr, y: period.y - pr, width: pr * 2, height: pr * 2)
        dot.path = UIBezierPath(ovalIn: dot.bounds).cgPath
        dot.fillColor = Self.sun.cgColor
        sheet.addSublayer(dot)
        animate(dot, "opacity", from: 0, to: 1, at: T.dot, for: 0.12, .easeOut)
        animate(dot, "transform.scale", from: 2.3, to: 1, at: T.dot, for: 0.22, .easeOut)
    }

    /// Holds the finished logo until the app underneath is worth revealing.
    private func wait() {
        let elapsed = CACurrentMediaTime() - started
        let still = UIAccessibility.isReduceMotionEnabled
        if elapsed >= T.maxWait || ((still || elapsed >= T.hold) && ready()) { finish(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.wait() }
    }
    @objc private func skip() { finish() }

    /// Ink breaks through from the period and a few spots at once, takes the sheet, then the app shows through.
    private func finish() {
        guard !ending else { return }
        ending = true
        let flood = UIAccessibility.isReduceMotionEnabled ? 0 : T.flood
        let reach = hypot(bounds.width, bounds.height) * 0.62
        for (n, (u, v, delay)) in Self.erode.enumerated() where flood > 0 {
            let center = n == 0 ? period : CGPoint(x: u * bounds.width, y: v * bounds.height)
            let ink = CAShapeLayer()
            ink.fillColor = Self.night.cgColor
            ink.path = UIBezierPath(arcCenter: center, radius: reach, startAngle: 0, endAngle: 2 * .pi, clockwise: true).cgPath
            layer.addSublayer(ink)
            let a = CABasicAnimation(keyPath: "path")
            a.fromValue = UIBezierPath(arcCenter: center, radius: 0.5, startAngle: 0, endAngle: 2 * .pi, clockwise: true).cgPath
            a.beginTime = CACurrentMediaTime() + delay * flood; a.duration = (1 - delay) * flood
            a.fillMode = .backwards; a.timingFunction = CAMediaTimingFunction(controlPoints: 0.55, 0, 0.85, 0.45)
            ink.add(a, forKey: "path")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + flood) { [weak self] in
            guard let self else { return }
            // native screens lay out under the night first, then fade in
            NativeDeepLink.finishSplash()
            NativeShellStore.shared?.objectWillChange.send()
            UIView.animate(withDuration: 0.3, delay: 0.05, options: [.curveEaseOut]) { self.alpha = 0 } completion: { _ in self.removeFromSuperview() }
        }
    }
}
