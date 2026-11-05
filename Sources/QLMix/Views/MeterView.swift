import SwiftUI

/// Vertical LED-style level meter (−60 … 0 dBFS, linear in dB).
struct MeterView: View {
    /// 0…1, `nil` = no data.
    var value: Double?
    var peak: Double

    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.black.opacity(0.85))

                if let value {
                    LinearGradient(
                        stops: [
                            .init(color: .green, location: 0),
                            .init(color: .green, location: 0.62),
                            .init(color: .yellow, location: 0.8),
                            .init(color: .orange, location: 0.92),
                            .init(color: .red, location: 1),
                        ],
                        startPoint: .bottom, endPoint: .top
                    )
                    .mask(alignment: .bottom) {
                        Rectangle().frame(height: h * value)
                    }

                    Rectangle()
                        .fill(peak > 0.97 ? Color.red : Color.white.opacity(0.8))
                        .frame(height: 2)
                        .offset(y: -h * peak + 1)
                        .opacity(peak > 0.01 ? 1 : 0)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 1.5))
        }
        .animation(.linear(duration: 0.08), value: value)
        .accessibilityLabel("Pegel")
    }
}
