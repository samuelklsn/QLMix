import SwiftUI
import YamahaQLProtocol

/// Colors for the four bands + HPF.
enum EQColors {
    static let bands: [Color] = [
        Color(red: 0.95, green: 0.35, blue: 0.30),
        Color(red: 0.98, green: 0.75, blue: 0.20),
        Color(red: 0.35, green: 0.85, blue: 0.45),
        Color(red: 0.35, green: 0.65, blue: 1.00),
    ]
    static let hpf = Color(white: 0.85)
    static let curve = Color(red: 0.45, green: 0.85, blue: 1.0)
}

/// Log-frequency / linear-gain coordinate mapping.
struct EQGeometry {
    var size: CGSize
    var minDB: Double = -18
    var maxDB: Double = 18

    static let minF = 20.0, maxF = 20000.0

    func x(_ f: Double) -> CGFloat {
        CGFloat(log10(f / Self.minF) / log10(Self.maxF / Self.minF)) * size.width
    }

    func frequency(atX x: CGFloat) -> Double {
        Self.minF * pow(Self.maxF / Self.minF, Double(x / max(size.width, 1)))
    }

    func y(_ dB: Double) -> CGFloat {
        CGFloat((maxDB - dB) / (maxDB - minDB)) * size.height
    }

    func gain(atY y: CGFloat) -> Double {
        maxDB - Double(y / max(size.height, 1)) * (maxDB - minDB)
    }
}

/// Large interactive EQ graph.
///
/// * Drag a numbered node: frequency (x) and gain (y). HPF node: frequency only.
/// * Scroll over the graph: Q of the selected band (⌥ = fine).
/// * Double-click a node: gain to 0 dB.
struct EQGraphView: View {
    @Environment(MixerStore.self) private var store
    let channel: ChannelState
    @Binding var selectedBand: Int?

    @State private var dragTarget: DragTarget?

    enum DragTarget: Equatable {
        case band(Int)
        case hpf
    }

    var body: some View {
        GeometryReader { geo in
            let g = EQGeometry(size: geo.size)
            let eq = channel.eq
            ZStack {
                Canvas { context, size in
                    drawGrid(context, g)
                    if let band = selectedBand {
                        drawBandFill(context, g, eq: eq, band: band)
                    }
                    drawCurve(context, g, eq: eq)
                }
                ForEach(0..<eqBandCount, id: \.self) { i in
                    node(label: "\(i + 1)", color: EQColors.bands[i], selected: selectedBand == i)
                        .position(x: g.x(eq.bands[i].frequency), y: g.y(eq.bands[i].gain))
                        .opacity(eq.isOn ? 1 : 0.4)
                }
                node(label: "H", color: EQColors.hpf, selected: dragTarget == .hpf)
                    .position(x: g.x(eq.hpfFrequency), y: hpfNodeY(g, eq))
                    .opacity(eq.hpfOn ? 1 : 0.35)
            }
            .contentShape(Rectangle())
            .gesture(drag(g))
            .simultaneousGesture(SpatialTapGesture(count: 2).onEnded { value in
                if case .band(let i) = hitTest(value.location, g) {
                    store.updateEQ(channel, [.bandGain(i)], immediate: true) { $0.bands[i].gain = 0 }
                }
            })
            .overlay(ScrollWheelCatcher { delta, fine in
                guard let band = selectedBand else { return }
                let factor = pow(fine ? 1.02 : 1.1, Double(delta))
                store.updateEQ(channel, [.bandQ(band)]) { $0.bands[band].q *= factor }
            })
        }
        .background(Color(white: 0.06))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.1)))
    }

    private func node(label: String, color: Color, selected: Bool) -> some View {
        Text(label)
            .font(.system(size: 10, weight: .heavy))
            .foregroundStyle(.black)
            .frame(width: 18, height: 18)
            .background(Circle().fill(color))
            .overlay(Circle().stroke(Color.white, lineWidth: selected ? 2 : 0))
            .shadow(color: .black.opacity(0.6), radius: 2)
            .allowsHitTesting(false)
    }

    /// HPF node sits on the curve at its cutoff (−3 dB point), clamped into the graph.
    private func hpfNodeY(_ g: EQGeometry, _ eq: EQSettings) -> CGFloat {
        let dB = eq.hpfOn ? eq.response(at: eq.hpfFrequency) : -3
        return min(max(g.y(dB), 10), g.size.height - 24)
    }

    private func hitTest(_ p: CGPoint, _ g: EQGeometry) -> DragTarget? {
        let eq = channel.eq
        var best: (DragTarget, CGFloat)?
        for i in 0..<eqBandCount {
            let d = hypot(g.x(eq.bands[i].frequency) - p.x, g.y(eq.bands[i].gain) - p.y)
            if d < 22, d < (best?.1 ?? .infinity) { best = (.band(i), d) }
        }
        let dh = hypot(g.x(eq.hpfFrequency) - p.x, hpfNodeY(g, eq) - p.y)
        if dh < 22, dh < (best?.1 ?? .infinity) { best = (.hpf, dh) }
        return best?.0
    }

    private func drag(_ g: EQGeometry) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if dragTarget == nil {
                    guard let target = hitTest(value.startLocation, g) else { return }
                    dragTarget = target
                    switch target {
                    case .band(let i):
                        selectedBand = i
                        store.beginEQTouch(channel, [.bandFreq(i), .bandGain(i)])
                    case .hpf:
                        store.beginEQTouch(channel, [.hpfFreq])
                    }
                }
                let p = CGPoint(
                    x: min(max(value.location.x, 0), g.size.width),
                    y: min(max(value.location.y, 0), g.size.height)
                )
                switch dragTarget {
                case .band(let i):
                    let f = g.frequency(atX: p.x)
                    let gain = (g.gain(atY: p.y) * 2).rounded() / 2   // 0.5 dB steps
                    store.updateEQ(channel, [.bandFreq(i), .bandGain(i)]) {
                        $0.bands[i].frequency = f
                        $0.bands[i].gain = gain
                    }
                case .hpf:
                    let f = g.frequency(atX: p.x)
                    store.updateEQ(channel, [.hpfFreq]) { $0.hpfFrequency = f }
                case nil:
                    break
                }
            }
            .onEnded { _ in
                switch dragTarget {
                case .band(let i): store.endEQTouch(channel, [.bandFreq(i), .bandGain(i)])
                case .hpf: store.endEQTouch(channel, [.hpfFreq])
                case nil: break
                }
                dragTarget = nil
            }
    }

    // MARK: Drawing

    private func drawGrid(_ context: GraphicsContext, _ g: EQGeometry) {
        let freqs: [Double] = [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900,
                               1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000]
        let labeled: Set<Double> = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
        for f in freqs {
            let x = g.x(f)
            var path = Path()
            path.move(to: CGPoint(x: x, y: 0))
            path.addLine(to: CGPoint(x: x, y: g.size.height))
            context.stroke(path, with: .color(.white.opacity(labeled.contains(f) ? 0.12 : 0.05)), lineWidth: 1)
            if labeled.contains(f), f < 20000 {
                context.draw(
                    Text(f >= 1000 ? "\(Int(f / 1000))k" : "\(Int(f))")
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundStyle(Color.white.opacity(0.4)),
                    at: CGPoint(x: x + 3, y: g.size.height - 8), anchor: .leading
                )
            }
        }
        for dB in stride(from: -18.0, through: 18.0, by: 6.0) {
            let y = g.y(dB)
            var path = Path()
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: g.size.width, y: y))
            context.stroke(path, with: .color(.white.opacity(dB == 0 ? 0.25 : 0.08)), lineWidth: 1)
            if abs(dB) < 18 {
                context.draw(
                    Text(dB > 0 ? "+\(Int(dB))" : "\(Int(dB))")
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundStyle(Color.white.opacity(0.4)),
                    at: CGPoint(x: 4, y: y - 7), anchor: .leading
                )
            }
        }
    }

    private func curvePath(_ g: EQGeometry, steps: Int = 240, _ fn: (Double) -> Double) -> Path {
        var path = Path()
        for i in 0...steps {
            let x = g.size.width * CGFloat(i) / CGFloat(steps)
            let dB = fn(g.frequency(atX: x))
            let p = CGPoint(x: x, y: min(max(g.y(dB), -50), g.size.height + 50))
            i == 0 ? path.move(to: p) : path.addLine(to: p)
        }
        return path
    }

    private func drawCurve(_ context: GraphicsContext, _ g: EQGeometry, eq: EQSettings) {
        let path = curvePath(g) { eq.response(at: $0) }
        var fill = path
        fill.addLine(to: CGPoint(x: g.size.width, y: g.y(0)))
        fill.addLine(to: CGPoint(x: 0, y: g.y(0)))
        fill.closeSubpath()
        let color = eq.isOn ? EQColors.curve : Color.gray
        context.fill(fill, with: .color(color.opacity(0.12)))
        context.stroke(path, with: .color(color), lineWidth: 2)
    }

    private func drawBandFill(_ context: GraphicsContext, _ g: EQGeometry, eq: EQSettings, band: Int) {
        guard eq.isOn else { return }
        var path = curvePath(g, steps: 160) { eq.bandResponse(band, at: $0) }
        path.addLine(to: CGPoint(x: g.size.width, y: g.y(0)))
        path.addLine(to: CGPoint(x: 0, y: g.y(0)))
        path.closeSubpath()
        context.fill(path, with: .color(EQColors.bands[band].opacity(0.22)))
    }
}

/// Small non-interactive EQ curve for channel strips.
struct EQThumbnail: View {
    let eq: EQSettings
    var synced: Bool

    var body: some View {
        Canvas { context, size in
            let g = EQGeometry(size: size, minDB: -18, maxDB: 18)
            var zero = Path()
            zero.move(to: CGPoint(x: 0, y: g.y(0)))
            zero.addLine(to: CGPoint(x: size.width, y: g.y(0)))
            context.stroke(zero, with: .color(.white.opacity(0.15)), lineWidth: 0.5)
            guard synced else { return }
            var path = Path()
            let steps = 48
            for i in 0...steps {
                let x = size.width * CGFloat(i) / CGFloat(steps)
                let y = min(max(g.y(eq.response(at: g.frequency(atX: x))), 0), size.height)
                i == 0 ? path.move(to: CGPoint(x: x, y: y)) : path.addLine(to: CGPoint(x: x, y: y))
            }
            context.stroke(path, with: .color(eq.isOn ? EQColors.curve : .gray), lineWidth: 1.2)
        }
    }
}
