// Exercises ProtocolParser's TCP emission. Constructs TraceMessage values
// directly - no BLF fixture needed (ADR 0007: unit layer per boundary).
#include "ProtocolParser.h"
#include <cstdio>

namespace {
int gFailures = 0;
void expect(bool cond, const char* msg)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        ++gFailures;
    }
}
}

int main()
{
    ProtocolParser parser;

    // A pure-SYN control segment: zero payload bytes. Must still emit a Tcp
    // ProtocolMessage - this is the handshake-open event Connection Health
    // exists to see, and the pre-existing empty-payload early return must not
    // swallow it.
    {
        fastrace::TraceMessage tm;
        tm.isTcp = true;
        tm.tcpFlags = 0x02; // SYN
        tm.data.clear();
        auto out = parser.parse(tm, 0);
        expect(out.size() == 1, "pure SYN emits exactly one ProtocolMessage");
        if (out.size() == 1) {
            expect(out[0].type == ProtocolType::Tcp, "pure SYN message type is Tcp");
            expect(out[0].data.tcp.flags == 0x02, "pure SYN flags round-trip");
            expect(out[0].data.tcp.length == 0, "pure SYN segment_len is 0");
        }
    }

    // A PSH+ACK data segment: non-empty payload.
    {
        fastrace::TraceMessage tm;
        tm.isTcp = true;
        tm.tcpFlags = 0x18; // PSH|ACK
        tm.data = { 0xAA, 0xBB, 0xCC };
        auto out = parser.parse(tm, 1);
        expect(out.size() == 1, "PSH+ACK emits exactly one ProtocolMessage");
        if (out.size() == 1) {
            expect(out[0].data.tcp.flags == 0x18, "PSH+ACK flags round-trip");
            expect(out[0].data.tcp.length == 3, "PSH+ACK segment_len matches payload size");
        }
    }

    // Non-TCP messages (isTcp=false) must be unaffected - existing SOME/IP
    // detection still runs.
    {
        fastrace::TraceMessage tm;
        tm.isTcp = false;
        tm.data.assign(16, 0);
        tm.data[0] = 0x12;
        tm.data[1] = 0x34; // serviceId
        auto out = parser.parse(tm, 2);
        expect(out.size() == 1, "non-TCP message still produces its existing peel");
        if (out.size() == 1) {
            expect(out[0].type == ProtocolType::SomeIp, "non-TCP path untouched by Tcp branch");
        }
    }

    if (gFailures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", gFailures);
        return 1;
    }
    std::printf("protocol_parser_test: OK\n");
    return 0;
}
