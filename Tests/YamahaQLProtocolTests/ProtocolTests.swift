import Testing
@testable import YamahaQLProtocol

@Suite("Tokenizer")
struct TokenizerTests {
    @Test func splitsWordsAndQuotedStrings() {
        let tokens = RCPTokenizer.tokenize(#"OK get MIXER:Current/InCh/Label/Name 0 0 "Lead Vox""#)
        #expect(tokens.map(\.text) == ["OK", "get", "MIXER:Current/InCh/Label/Name", "0", "0", "Lead Vox"])
        #expect(tokens.last?.isQuoted == true)
    }

    @Test func handlesEscapesAndEmptyStrings() {
        let tokens = RCPTokenizer.tokenize(#"set A 0 0 "a\"b" """#)
        #expect(tokens.map(\.text) == ["set", "A", "0", "0", "a\"b", ""])
    }

    @Test func quoteRoundTrip() {
        let s = #"He said "hi" \o/"#
        let tokens = RCPTokenizer.tokenize(RCPTokenizer.quote(s))
        #expect(tokens == [.quoted(s)])
    }
}

@Suite("Message parsing")
struct MessageTests {
    @Test func parsesNotifyFader() {
        let msg = RCPMessage.parse(#"NOTIFY set MIXER:Current/InCh/Fader/Level 3 0 -1000 "-10.00""#)
        guard case let .parameter(status, command, report) = msg else { Issue.record("wrong case \(msg)"); return }
        #expect(status == .notify)
        #expect(command == "set")
        #expect(report.address == "MIXER:Current/InCh/Fader/Level")
        #expect(report.x == 3 && report.y == 0)
        #expect(report.value == .int(-1000))
        #expect(report.display == "-10.00")
    }

    @Test func parsesStringValue() {
        let msg = RCPMessage.parse(#"OK get MIXER:Current/InCh/Label/Name 0 0 "123""#)
        guard case let .parameter(_, _, report) = msg else { Issue.record(); return }
        #expect(report.value == .string("123"), "quoted numbers stay strings")
    }

    @Test func parsesErrors() {
        #expect(RCPMessage.parse("ERROR get UnknownAddress") == .error(command: "get", reason: "UnknownAddress"))
    }

    @Test func parsesScene() {
        #expect(RCPMessage.parse("NOTIFY sscurrent_ex MIXER:Lib/Scene 12")
            == .scene(status: .notify, command: "sscurrent_ex", bank: "MIXER:Lib/Scene", number: 12))
    }

    @Test func parsesDevinfo() {
        #expect(RCPMessage.parse(#"OK devinfo productname "QL5""#)
            == .info(status: .ok, command: "devinfo", arguments: ["productname", "QL5"]))
    }

    @Test func parsesMeters() {
        #expect(RCPMessage.parse("NOTIFY mtr MIXER:Current/Mix/PostOn PostOn 7e 00 1f")
            == .meter(address: "MIXER:Current/Mix/PostOn", values: [126, 0, 31]))
        #expect(RCPMessage.parse("NOTIFY mtr MIXER:Current/Mix/PostOn 7e001f")
            == .meter(address: "MIXER:Current/Mix/PostOn", values: [126, 0, 31]))
    }

    @Test func unknownLines() {
        #expect(RCPMessage.parse("hello") == .unknown("hello"))
    }
}

@Suite("Commands")
struct CommandTests {
    @Test func encodesCommands() {
        let key = ParameterKey.channel(ChannelID(.input, 0), .level)
        #expect(RCPCommand.get(key).line == "get MIXER:Current/InCh/Fader/Level 0 0")
        #expect(RCPCommand.set(key, .int(-32768)).map(\.line) == ["set MIXER:Current/InCh/Fader/Level 0 0 -32768"])
        let name = ParameterKey.channel(ChannelID(.input, 4), .name)
        #expect(RCPCommand.set(name, .string("Vox")).map(\.line) == [#"set MIXER:Current/InCh/Label/Name 4 0 "Vox""#])
        #expect(RCPCommand.sceneRecall(number: 5).line == "ssrecall_ex MIXER:Lib/Scene 5")
        #expect(RCPCommand.meterStart(address: MeterSource.mixPostOn.rawValue, intervalMs: 100).line
            == "mtrstart MIXER:Current/Mix/PostOn 100")
        #expect(RCPCommand.raw("devinfo productname\n").wireData == Array("devinfo productname\n".utf8))
    }

    @Test func stereoPairsWriteBothSides() {
        let st = ParameterKey.channel(ChannelID(.stereoInput, 2), .on)
        #expect(RCPCommand.set(st, .int(0)).map(\.line) == [
            "set MIXER:Current/StInCh/Fader/On 4 0 0",
            "set MIXER:Current/StInCh/Fader/On 5 0 0",
        ])
        let master = ParameterKey.channel(ChannelID(.stereo, 0), .level)
        #expect(master.wireTargets.map(\.x) == [0, 1])
        #expect(ParameterKey.channel(ChannelID(.mono, 0), .level).wireTargets.map(\.x) == [2])
    }

    @Test func sendKeys() {
        let send = ParameterKey.send(ChannelID(.input, 7), mix: 3, .level)
        #expect(RCPCommand.get(send).line == "get MIXER:Current/InCh/ToMix/Level 7 3")
    }
}

@Suite("Address decoding")
struct DecodingTests {
    @Test func roundTripsAllChannelParameters() {
        for id in ConsoleModel.ql5.allChannels {
            for p in ChannelParameter.allCases {
                let key = ParameterKey.channel(id, p)
                let t = key.primaryTarget
                #expect(ParameterKey.decode(address: key.address, x: t.x, y: t.y) == key, "\(key)")
            }
        }
    }

    @Test func roundTripsSends() {
        let key = ParameterKey.send(ChannelID(.stereoInput, 3), mix: 9, .on)
        let t = key.primaryTarget
        #expect(ParameterKey.decode(address: key.address, x: t.x, y: t.y) == key)
    }

    @Test func ignoresSecondaryStereoHalves() {
        #expect(ParameterKey.decode(address: "MIXER:Current/StInCh/Fader/Level", x: 1, y: 0) == nil)
        #expect(ParameterKey.decode(address: "MIXER:Current/St/Fader/Level", x: 1, y: 0) == nil)
        #expect(ParameterKey.decode(address: "MIXER:Current/St/Fader/Level", x: 2, y: 0)
            == .channel(ChannelID(.mono, 0), .level))
    }

    @Test func unknownAddresses() {
        #expect(ParameterKey.decode(address: "MIXER:Current/InCh/Dyna1/On", x: 0, y: 0) == nil)
        #expect(ParameterKey.decode(address: "Foo", x: 0, y: 0) == nil)
    }
}

@Suite("Levels")
struct LevelTests {
    @Test func displayStrings() {
        #expect(FaderLevel.off.displayString == "-∞")
        #expect(FaderLevel(raw: 0).displayString == "0.0")
        #expect(FaderLevel(raw: 350).displayString == "+3.5")
        #expect(FaderLevel(raw: -1025).displayString == "-10.3")
    }

    @Test func clamping() {
        #expect(FaderLevel(raw: 5000).raw == 1000)
        #expect(FaderLevel(raw: -20000).isNegativeInfinity)
    }

    @Test func positionRoundTrip() {
        for dB in stride(from: -40.0, through: 10.0, by: 0.5) {
            let level = FaderLevel(dB: dB)
            let back = FaderLevel(position: level.position)
            #expect(abs((back.dB ?? -999) - dB) <= 0.05, "\(dB) → \(level.position) → \(back)")
        }
        #expect(FaderLevel(position: 0) == .off)
        #expect(FaderLevel(position: 1).raw == 1000)
        #expect(abs(FaderLevel.unity.position - 0.78) < 0.0001)
    }

    @Test func positionIsMonotonic() {
        var last = -1.0
        for raw in stride(from: -13800, through: 1000, by: 25) {
            let p = FaderLevel(raw: raw).position
            #expect(p >= last)
            last = p
        }
    }

    @Test func nudging() {
        #expect(FaderLevel.unity.adding(dB: 1).raw == 100)
        #expect(FaderLevel.off.adding(dB: 1).raw == -6000)
        #expect(FaderLevel(raw: 950).adding(dB: 1).raw == 1000)
    }
}

@Suite("Framing & misc")
struct FramingTests {
    @Test func framesAcrossChunks() {
        var framer = LineFramer()
        #expect(framer.append(Array("OK get A 0 0 1\nNOTI".utf8)) == ["OK get A 0 0 1"])
        #expect(framer.append(Array("FY set A 0 0 2\r\n\n".utf8)) == ["NOTIFY set A 0 0 2"])
        #expect(framer.append(Array("x".utf8)) == [])
    }

    @Test func modelDetection() {
        #expect(ConsoleModel.from(productName: "QL1").count(.input) == 32)
        #expect(ConsoleModel.from(productName: "CL5").count(.mix) == 24)
        #expect(ConsoleModel.from(productName: "???") == .ql5)
    }

    @Test func colors() {
        #expect(LabelColor(wireValue: "SkyBlue") == .cyan)
        #expect(LabelColor(wireValue: "red") == .red)
        #expect(LabelColor(wireValue: "nonsense") == .off)
    }

    @Test func meterScale() {
        #expect(MeterScale.dB(raw: 126) == 0)
        #expect(MeterScale.normalized(raw: 126) == 1)
        #expect(MeterScale.normalized(raw: 0) == 0)
        #expect(MeterSource(address: "MIXER:Current/Meter/Mtrx/PostOn") == .matrixPostOn)
    }
}
