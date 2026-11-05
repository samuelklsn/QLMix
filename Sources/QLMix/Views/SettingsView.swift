import SwiftUI
import YamahaQLNetwork

struct SettingsView: View {
    @Environment(MixerStore.self) private var store
    @Environment(AppSettings.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        Form {
            Section("Verbindung") {
                TextField("IP-Adresse des Pults", text: $settings.host)
                TextField("TCP-Port", value: $settings.port, format: .number.grouping(.never))
                Toggle("Beim Start automatisch verbinden", isOn: $settings.autoConnect)
                HStack {
                    ConnectionIndicator(state: store.connectionState)
                    Spacer()
                    Button("Verbinden") { store.connect() }
                    Button("Trennen") { store.disconnect() }
                }
                Text("Standard für CL/QL: Port \(String(ConnectionConfiguration.defaultPort)). Am Pult muss die IP unter SETUP → NETWORK passen; der Mac braucht eine Adresse im selben Subnetz.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Steuerung") {
                Stepper(value: $settings.faderSendIntervalMs, in: 10...200, step: 10) {
                    Text("Fader-Sendeintervall: \(settings.faderSendIntervalMs) ms")
                }
                Toggle("Szenen-Recall bestätigen", isOn: $settings.confirmSceneRecall)
            }

            Section("Meter") {
                Toggle("Meter anfordern (Mix & Matrix)", isOn: $settings.metersEnabled)
                    .onChange(of: settings.metersEnabled) { _, enabled in
                        enabled ? store.retryMeters() : store.stopMeters()
                    }
                Stepper(value: $settings.meterIntervalMs, in: 50...1000, step: 50) {
                    Text("Meter-Intervall: \(settings.meterIntervalMs) ms")
                }
                HStack {
                    Text("Status:")
                    Text(meterStatusText).foregroundStyle(.secondary)
                    Spacer()
                    Button("Neu anfordern") { store.retryMeters() }
                        .disabled(!store.isConnected || !settings.metersEnabled)
                }
                Text("Über das RCP-Protokoll liefern CL/QL-Pulte nur Meter für Mix- und Matrix-Busse. Eingangs-Meter sind darüber nicht verfügbar.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Pult") {
                LabeledContent("Modell", value: store.productName ?? "–")
                LabeledContent("Firmware", value: store.firmwareVersion ?? "–")
                LabeledContent("Kanäle", value: "\(store.model.count(.input)) Mono · \(store.model.count(.stereoInput)) Stereo · \(store.model.count(.mix)) Mix · \(store.model.count(.matrix)) Matrix")
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .frame(minHeight: 560)
    }

    private var meterStatusText: String {
        switch store.meterStatus {
        case .disabled: "aus"
        case .requested: "angefordert – warte auf Daten"
        case .active: "aktiv"
        case .unsupported(let reason): "nicht unterstützt (\(reason))"
        }
    }
}
