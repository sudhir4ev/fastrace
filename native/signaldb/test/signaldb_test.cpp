// ctest entry point for fastrace_signaldb, independent of any BLF file or the
// rest of the monorepo (native/signaldb/README.md documents how to run this
// alone). Covers bit extraction (Intel/Motorola), ARXML COMPU-METHOD
// factor/offset parsing (including the no-COMPU-METHOD fallback), and
// decodeAllSignals' new parent-identity tagging.

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>

#include "ArxmlParser.h"
#include "SignalDecoder.h"

#ifndef FASTRACE_FIXTURE_ARXML
#error "FASTRACE_FIXTURE_ARXML must be defined by CMake"
#endif

namespace {

int gFailures = 0;

void expect(bool cond, const char* what)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++gFailures;
    }
}

bool nearlyEqual(double a, double b) { return std::abs(a - b) < 1e-9; }

// Signal with no COMPU-METHOD-REF at all -> factor/offset must stay at defaults (1.0/0.0).
const char* kNoCompuMethodArxml = R"ARXML(<?xml version="1.0" encoding="UTF-8"?>
<AUTOSAR xmlns="http://autosar.org/schema/r4.0">
  <AR-PACKAGES>
    <AR-PACKAGE>
      <SHORT-NAME>Fixture</SHORT-NAME>
      <ELEMENTS>
        <CAN-CLUSTER>
          <SHORT-NAME>C</SHORT-NAME>
          <CAN-CLUSTER-VARIANTS>
            <CAN-CLUSTER-CONDITIONAL>
              <PHYSICAL-CHANNELS>
                <CAN-PHYSICAL-CHANNEL>
                  <SHORT-NAME>Ch</SHORT-NAME>
                  <FRAME-TRIGGERINGS>
                    <CAN-FRAME-TRIGGERING>
                      <SHORT-NAME>RawMsg</SHORT-NAME>
                      <IDENTIFIER>512</IDENTIFIER>
                      <CAN-ADDRESSING-MODE>STANDARD</CAN-ADDRESSING-MODE>
                      <FRAME-REF DEST="CAN-FRAME">/Fixture/RawFrame</FRAME-REF>
                    </CAN-FRAME-TRIGGERING>
                  </FRAME-TRIGGERINGS>
                </CAN-PHYSICAL-CHANNEL>
              </PHYSICAL-CHANNELS>
            </CAN-CLUSTER-CONDITIONAL>
          </CAN-CLUSTER-VARIANTS>
        </CAN-CLUSTER>
        <CAN-FRAME>
          <SHORT-NAME>RawFrame</SHORT-NAME>
          <FRAME-LENGTH>8</FRAME-LENGTH>
          <PDU-TO-FRAME-MAPPINGS>
            <PDU-TO-FRAME-MAPPING>
              <SHORT-NAME>RawPduMapping</SHORT-NAME>
              <PDU-REF DEST="I-SIGNAL-I-PDU">/Fixture/RawPdu</PDU-REF>
            </PDU-TO-FRAME-MAPPING>
          </PDU-TO-FRAME-MAPPINGS>
        </CAN-FRAME>
        <I-SIGNAL-I-PDU>
          <SHORT-NAME>RawPdu</SHORT-NAME>
          <LENGTH>8</LENGTH>
          <I-SIGNAL-TO-PDU-MAPPINGS>
            <I-SIGNAL-TO-I-PDU-MAPPING>
              <SHORT-NAME>RawCounterMapping</SHORT-NAME>
              <I-SIGNAL-REF DEST="I-SIGNAL">/Fixture/RawCounter</I-SIGNAL-REF>
              <START-POSITION>0</START-POSITION>
            </I-SIGNAL-TO-I-PDU-MAPPING>
          </I-SIGNAL-TO-PDU-MAPPINGS>
        </I-SIGNAL-I-PDU>
        <I-SIGNAL>
          <SHORT-NAME>RawCounter</SHORT-NAME>
          <LENGTH>8</LENGTH>
        </I-SIGNAL>
      </ELEMENTS>
    </AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>
)ARXML";

std::string writeTempFile(const char* name, const char* contents)
{
    const std::string path = std::string("/tmp/") + name;
    std::ofstream out(path);
    out << contents;
    return path;
}

} // namespace

int main()
{
    // -- extractSignalRaw: Intel (LSB-first) -----------------------------------
    {
        const uint8_t data[] = { 0x01, 0x02 };
        uint64_t raw = fastrace::extractSignalRaw(data, sizeof(data), 0, 16, false);
        expect(raw == 0x0201, "extractSignalRaw Intel 16-bit little-endian");
    }

    // -- extractSignalRaw: Motorola (MSB-first), byte-aligned ------------------
    {
        const uint8_t data[] = { 0xAB };
        uint64_t raw = fastrace::extractSignalRaw(data, sizeof(data), 7, 8, true);
        expect(raw == 0xAB, "extractSignalRaw Motorola byte-aligned round trip");
    }

    // -- ArxmlParser: real COMPU-RATIONAL-COEFFS chain (fixture.arxml) --------
    {
        fastrace::ArDatabase db = fastrace::ArxmlParser::parseFile(FASTRACE_FIXTURE_ARXML);
        db.buildIndex();
        const fastrace::ArMessage* engineMsg = nullptr;
        for (const auto& m : db.messages) {
            if (m.name == "EngineMsg") {
                engineMsg = &m;
                break;
            }
        }
        expect(engineMsg != nullptr, "fixture.arxml has EngineMsg");
        if (engineMsg) {
            const fastrace::ArSignal* rpm = nullptr;
            for (const auto& s : engineMsg->signalDefs) {
                if (s.name == "EngineRpm") {
                    rpm = &s;
                }
            }
            expect(rpm != nullptr, "EngineMsg has EngineRpm signal");
            if (rpm) {
                expect(rpm->bitLength == 16, "EngineRpm bitLength == 16");
                expect(nearlyEqual(rpm->factor, 0.25), "EngineRpm factor == 0.25 from COMPU-RATIONAL-COEFFS");
                expect(nearlyEqual(rpm->offset, 0.0), "EngineRpm offset == 0.0 from COMPU-RATIONAL-COEFFS");
            }

            // -- decodeAllSignals: parent-identity tagging -------------------------
            fastrace::TraceMessage tm;
            tm.objectType = 1; // CAN_MESSAGE
            tm.arbId = engineMsg->canId;
            tm.data = { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 };
            auto decoded = fastrace::decodeAllSignals(db, tm);
            expect(decoded.size() == 1, "decodeAllSignals returns one signal for EngineMsg");
            if (decoded.size() == 1) {
                expect(decoded[0].name == "EngineRpm", "decoded signal is EngineRpm");
                expect(decoded[0].rawValue == 0x0201, "EngineRpm rawValue decodes to 0x0201");
                expect(decoded[0].parentCanId == engineMsg->canId, "decoded signal tagged with parentCanId");
                expect(decoded[0].parentPduId == 0, "CAN-carried signal has parentPduId == 0");
            }
        }
    }

    // -- ArxmlParser: no COMPU-METHOD-REF -> factor/offset defaults -----------
    {
        const std::string path = writeTempFile("fastrace_signaldb_test_no_compu.arxml", kNoCompuMethodArxml);
        fastrace::ArDatabase db = fastrace::ArxmlParser::parseFile(path);
        expect(!db.empty(), "no-compu-method fixture parses");
        bool found = false;
        for (const auto& m : db.messages) {
            for (const auto& s : m.signalDefs) {
                if (s.name == "RawCounter") {
                    found = true;
                    expect(nearlyEqual(s.factor, 1.0), "signal with no COMPU-METHOD-REF defaults factor to 1.0");
                    expect(nearlyEqual(s.offset, 0.0), "signal with no COMPU-METHOD-REF defaults offset to 0.0");
                }
            }
        }
        expect(found, "RawCounter signal found");
    }

    if (gFailures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", gFailures);
        return 1;
    }
    std::printf("fastrace_signaldb_test: OK\n");
    return 0;
}
