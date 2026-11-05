import Testing
@testable import YamahaQLProtocol

@Suite("EQ")
struct EQTests {
    let schema = EQSchema.peq

    @Test func addresses() {
        let ch = ChannelID(.input, 4)
        #expect(EQKey(ch, .on).address(schema: schema) == "MIXER:Current/InCh/PEQ/On")
        #expect(RCPCommand.get(EQKey(ch, .bandGain(2)), schema: schema).line == "get MIXER:Current/InCh/PEQ/Band/Gain 4 2")
        #expect(RCPCommand.get(EQKey(ch, .hpfFreq), schema: schema).line == "get MIXER:Current/InCh/HPF/Freq 4 0")
        #expect(EQKey(ch, .lowShelf).address(schema: .eq) == "MIXER:Current/InCh/EQ/LowShelving/On")
        let st = EQKey(ChannelID(.stereoInput, 1), .bandQ(3))
        #expect(RCPCommand.set(st, 700, schema: schema).map(\.line) == [
            "set MIXER:Current/StInCh/PEQ/Band/Q 2 3 700",
            "set MIXER:Current/StInCh/PEQ/Band/Q 3 3 700",
        ])
    }

    @Test func decodeRoundTrip() {
        for kind in ChannelKind.allCases where kind.hasEQ {
            let id = ChannelID(kind, 0)
            for p in EQKey.Parameter.all {
                let key = EQKey(id, p)
                let t = key.wireTargets()[0]
                #expect(EQKey.decode(address: key.address(schema: schema), x: t.x, y: t.y, schema: schema) == key)
            }
        }
        #expect(EQKey.decode(address: "MIXER:Current/InCh/Fader/Level", x: 0, y: 0, schema: schema) == nil)
        #expect(EQKey.decode(address: "MIXER:Current/InCh/PEQ/Band/Gain", x: 0, y: 7, schema: schema) == nil)
        #expect(EQKey.decode(address: "MIXER:Current/DCA/PEQ/On", x: 0, y: 0, schema: schema) == nil)
    }

    @Test func rawConversion() {
        var eq = EQSettings()
        eq.apply(.bandFreq(1), raw: 25000, schema: schema)
        eq.apply(.bandGain(1), raw: -450, schema: schema)
        eq.apply(.bandQ(1), raw: 2500, schema: schema)
        eq.apply(.hpfFreq, raw: 1000, schema: schema)
        #expect(eq.bands[1] == .init(frequency: 2500, gain: -4.5, q: 2.5))
        #expect(eq.hpfFrequency == 100)
        #expect(eq.rawValue(for: .bandGain(1), schema: schema) == -450)
        #expect(eq.rawValue(for: .bandFreq(1), schema: schema) == 25000)
    }

    @Test func responseShapes() {
        var eq = EQSettings()
        #expect(abs(eq.response(at: 1000)) < 0.001, "flat EQ is flat")

        eq.bands[1] = .init(frequency: 1000, gain: 6, q: 1)
        #expect(abs(eq.response(at: 1000) - 6) < 0.05, "bell peaks at its gain")
        #expect(abs(eq.response(at: 50)) < 0.3)

        eq.isOn = false
        #expect(abs(eq.response(at: 1000)) < 0.001, "EQ off is flat")

        var hpf = EQSettings()
        hpf.hpfOn = true
        hpf.hpfFrequency = 100
        #expect(abs(hpf.response(at: 100) + 3) < 0.2, "-3 dB at cutoff")
        #expect(hpf.response(at: 25) < -20)

        var shelf = EQSettings()
        shelf.lowShelf = true
        shelf.bands[0] = .init(frequency: 200, gain: -9, q: 0.7)
        #expect(abs(shelf.response(at: 25) + 9) < 0.5, "low shelf reaches full gain below corner")
        #expect(abs(shelf.response(at: 5000)) < 0.3)
    }

    @Test func formatting() {
        #expect(EQFormat.frequency(1000) == "1.00k")
        #expect(EQFormat.frequency(12500) == "12.5k")
        #expect(EQFormat.frequency(80) == "80.0")
        #expect(EQFormat.gain(3) == "+3.0")
        #expect(EQFormat.gain(-0.04) == "0.0")
    }
}
