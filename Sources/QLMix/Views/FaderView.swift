import AppKit
import SwiftUI
import YamahaQLProtocol

/// Vertical fader with a Yamaha-like scale.
///
/// * Drag is **relative** (clicking the track never makes the level jump – safe for live use).
/// * Hold ⌥ while dragging for fine control.
/// * Scroll wheel / trackpad: ±0.5 dB per step (⌥: 0.1 dB).
/// * Context menu: set to 0 dB / −∞.
struct FaderView: View {
    var level: FaderLevel
    var accent: Color
    var isEnabled: Bool = true
    var onChange: (FaderLevel) -> Void
    var onEditingChanged: (Bool) -> Void

    @State private var dragStartPosition: Double?
    @State private var dragStartY: CGFloat = 0
    @State private var fineAnchor: (y: CGFloat, position: Double)?

    private static let marks: [(dB: Double?, label: String)] = [
        (10, "+10"), (5, "+5"), (0, "0"), (-5, "5"), (-10, "10"), (-20, "20"),
        (-30, "30"), (-40, "40"), (-60, "60"), (nil, "∞"),
    ]
    private let capHeight: CGFloat = 38
    private let scaleWidth: CGFloat = 24

    var body: some View {
        GeometryReader { geo in
            let travel = max(1, geo.size.height - capHeight)
            let position = level.position

            let trackWidth = geo.size.width - scaleWidth
            let capWidth = min(36, trackWidth - 2)

            ZStack(alignment: .topLeading) {
                scale(travel: travel)

                // Slot
                Capsule()
                    .fill(Color.black.opacity(0.85))
                    .overlay(Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1))
                    .frame(width: 5, height: travel)
                    .offset(x: scaleWidth + (trackWidth - 5) / 2, y: capHeight / 2)

                FaderCap(accent: accent, isActive: dragStartPosition != nil)
                    .frame(width: capWidth, height: capHeight)
                    .offset(x: scaleWidth + (trackWidth - capWidth) / 2, y: CGFloat(1 - position) * travel)
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .gesture(dragGesture(travel: travel))
            .overlay(ScrollWheelCatcher { delta, fine in
                guard isEnabled else { return }
                let step = fine ? 0.1 : 0.5
                onChange(level.adding(dB: delta > 0 ? step : -step))
            })
            .contextMenu {
                Button("Auf 0 dB setzen") { onChange(.unity) }
                Button("Auf −∞ setzen") { onChange(.off) }
                Button("−10 dB") { onChange(FaderLevel(dB: -10)) }
            }
        }
        .opacity(isEnabled ? 1 : 0.55)
    }

    private func dragGesture(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .local)
            .onChanged { value in
                guard isEnabled else { return }
                if dragStartPosition == nil {
                    dragStartPosition = level.position
                    dragStartY = value.startLocation.y
                    fineAnchor = nil
                    onEditingChanged(true)
                }
                let fine = NSEvent.modifierFlags.contains(.option)
                let newPosition: Double
                if fine {
                    // Re-anchor when ⌥ is pressed mid-drag so the cap doesn't jump.
                    if fineAnchor == nil { fineAnchor = (value.location.y, level.position) }
                    let dy = value.location.y - fineAnchor!.y
                    newPosition = fineAnchor!.position - Double(dy / travel) * 0.2
                } else {
                    if let anchor = fineAnchor {
                        // Leaving fine mode: continue from the current position.
                        dragStartPosition = anchor.position - Double((value.location.y - anchor.y) / travel) * 0.2
                        dragStartY = value.location.y
                        fineAnchor = nil
                    }
                    newPosition = dragStartPosition! - Double((value.location.y - dragStartY) / travel)
                }
                let newLevel = FaderLevel(position: newPosition)
                if newLevel != level { onChange(newLevel) }
            }
            .onEnded { _ in
                guard dragStartPosition != nil else { return }
                dragStartPosition = nil
                fineAnchor = nil
                onEditingChanged(false)
            }
    }

    private func scale(travel: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Self.marks.indices, id: \.self) { index in
                let mark = Self.marks[index]
                let pos = mark.dB.map { FaderLevel(dB: $0).position } ?? 0
                let y = CGFloat(1 - pos) * travel + capHeight / 2
                HStack(spacing: 2) {
                    Text(mark.label)
                        .font(.system(size: 8, weight: mark.dB == 0 ? .bold : .regular).monospacedDigit())
                        .foregroundStyle(mark.dB == 0 ? Color.white.opacity(0.9) : Color.white.opacity(0.45))
                        .lineLimit(1)
                        .fixedSize()
                        .frame(width: 17, alignment: .trailing)
                    Rectangle()
                        .fill(Color.white.opacity(mark.dB == 0 ? 0.6 : 0.25))
                        .frame(width: mark.dB == 0 ? 5 : 3, height: 1)
                }
                .offset(x: 0, y: y - 5)
            }
        }
        .frame(width: scaleWidth, height: travel + capHeight, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}

struct FaderCap: View {
    var accent: Color
    var isActive: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(
                LinearGradient(
                    colors: [Color(white: 0.78), Color(white: 0.52), Color(white: 0.35), Color(white: 0.6)],
                    startPoint: .top, endPoint: .bottom
                )
            )
            .overlay(
                Rectangle()
                    .fill(isActive ? accent : Color.black.opacity(0.85))
                    .frame(height: 3)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(isActive ? accent : Color.black.opacity(0.6), lineWidth: isActive ? 2 : 1)
            )
            .shadow(color: .black.opacity(0.6), radius: 3, y: 2)
    }
}

/// Bridges scroll wheel events (SwiftUI has no scroll-wheel modifier on macOS).
struct ScrollWheelCatcher: NSViewRepresentable {
    var onScroll: (_ delta: CGFloat, _ fine: Bool) -> Void

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.onScroll = onScroll
        return view
    }

    func updateNSView(_ nsView: CatcherView, context: Context) {
        nsView.onScroll = onScroll
    }

    final class CatcherView: NSView {
        var onScroll: ((CGFloat, Bool) -> Void)?
        private var accumulated: CGFloat = 0

        override func hitTest(_ point: NSPoint) -> NSView? {
            // Only intercept scroll events; let clicks & drags through to SwiftUI.
            guard let event = NSApp.currentEvent, event.type == .scrollWheel else { return nil }
            return super.hitTest(point)
        }

        override func scrollWheel(with event: NSEvent) {
            // Horizontal scrolling goes to the enclosing scroll view.
            if abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) {
                nextResponder?.scrollWheel(with: event)
                return
            }
            let threshold: CGFloat = event.hasPreciseScrollingDeltas ? 12 : 1
            accumulated += event.scrollingDeltaY * (event.isDirectionInvertedFromDevice ? -1 : 1)
            while abs(accumulated) >= threshold {
                let sign: CGFloat = accumulated > 0 ? 1 : -1
                accumulated -= sign * threshold
                onScroll?(sign, event.modifierFlags.contains(.option))
            }
        }
    }
}
