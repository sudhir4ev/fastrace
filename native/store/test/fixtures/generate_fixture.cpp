// Produces the committed synthetic fixture.blf + fixture.arxml (docs/adr/0007).
// Run once by hand to (re)generate the committed fixtures; not run as part of
// the normal test suite (fastrace_fixture_gen_smoke just checks it still
// exits 0 and writes non-empty files).
//
// Byte layout is written by hand against native/blf/include/BlfTypes.h and
// native/blf/include/NetTypes.h rather than reusing fastrace_blf's reader
// structs for writing, so the fixture format is pinned independently of
// reader implementation details.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

#include <libdeflate.h>

namespace {

using Bytes = std::vector<uint8_t>;

void u8(Bytes& b, uint8_t v) { b.push_back(v); }

void le16(Bytes& b, uint16_t v)
{
    b.push_back(static_cast<uint8_t>(v & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
}

void le32(Bytes& b, uint32_t v)
{
    for (int i = 0; i < 4; ++i) {
        b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xFF));
    }
}

void le64(Bytes& b, uint64_t v)
{
    for (int i = 0; i < 8; ++i) {
        b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xFF));
    }
}

void be16(Bytes& b, uint16_t v)
{
    b.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
    b.push_back(static_cast<uint8_t>(v & 0xFF));
}

void be32(Bytes& b, uint32_t v)
{
    for (int i = 3; i >= 0; --i) {
        b.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xFF));
    }
}

void bytes(Bytes& b, std::initializer_list<uint8_t> vs)
{
    for (uint8_t v : vs) {
        b.push_back(v);
    }
}

void pad(Bytes& b, size_t n)
{
    b.insert(b.end(), n, 0);
}

// -- Inner LOBJ objects (live inside a decompressed LOG_CONTAINER) ----------

constexpr uint32_t kCanMessage = 1;
constexpr uint32_t kEthernetFrameEx = 120;
constexpr uint32_t kLogContainer = 10;

// BlfObjectHeaderBase(16) + BlfObjectHeader(16) = 32-byte inner header.
void innerHeader(Bytes& b, uint32_t objectType, uint32_t payloadSize, uint64_t timestamp)
{
    bytes(b, { 'L', 'O', 'B', 'J' });
    le16(b, 32); // headerSize = base(16) + BlfObjectHeader(16)
    le16(b, 1); // headerVersion
    le32(b, 32 + payloadSize); // objectSize
    le32(b, objectType);
    le32(b, 2); // BlfObjectHeader.flags = 0x2 -> tsToMicroseconds divides by 1000
    le16(b, 0); // staticSize (unused)
    le16(b, 0); // version (unused)
    le64(b, timestamp); // timestamp (ns-ish; /1000 with flags=0x2 above)
}

void appendCanMessage(Bytes& b, uint64_t timestampNs, uint16_t channel, uint32_t arbId, uint8_t dlc,
    const Bytes& data)
{
    Bytes payload;
    le16(payload, channel);
    u8(payload, dlc);
    u8(payload, 0); // flags
    le32(payload, arbId); // bit31 clear -> standard (11-bit) id
    Bytes padded = data;
    padded.resize(8, 0);
    payload.insert(payload.end(), padded.begin(), padded.end());

    innerHeader(b, kCanMessage, static_cast<uint32_t>(payload.size()), timestampNs);
    b.insert(b.end(), payload.begin(), payload.end());
}

// Builds one Ethernet II + IPv4 + UDP frame carrying `udpPayload`, wrapped in
// an ETHERNET_FRAME_EX (type 120) object. BlfIngestReader only reads
// eth.channel from EthernetFrameHeader -- every other header field is inert.
void appendEthernetFrame(
    Bytes& b, uint64_t timestampNs, uint16_t channel, uint16_t dstPort, const Bytes& udpPayload)
{
    Bytes frame; // Ethernet II + IPv4 + UDP + payload
    bytes(frame, { 0x02, 0x00, 0x00, 0x00, 0x00, 0x01 }); // dst MAC
    bytes(frame, { 0x02, 0x00, 0x00, 0x00, 0x00, 0x02 }); // src MAC
    be16(frame, 0x0800); // etherType = IPv4

    const size_t ipStart = frame.size();
    u8(frame, 0x45); // version 4, IHL 5 (20 bytes)
    u8(frame, 0); // DSCP/ECN
    be16(frame, static_cast<uint16_t>(20 + 8 + udpPayload.size())); // total length
    be16(frame, 0); // identification
    be16(frame, 0); // flags/fragment
    u8(frame, 64); // TTL
    u8(frame, 17); // protocol = UDP
    be16(frame, 0); // header checksum (unchecked by reader)
    bytes(frame, { 192, 168, 1, 20 }); // src IP
    bytes(frame, { 192, 168, 1, 10 }); // dst IP
    (void)ipStart;

    be16(frame, 40000); // UDP src port
    be16(frame, dstPort); // UDP dst port
    be16(frame, static_cast<uint16_t>(8 + udpPayload.size())); // UDP length
    be16(frame, 0); // UDP checksum (unchecked by reader)
    frame.insert(frame.end(), udpPayload.begin(), udpPayload.end());

    Bytes payload;
    le16(payload, 32); // EthernetFrameHeader.structLength (unused by reader)
    le16(payload, 0); // flags
    le16(payload, channel); // channel -- the only field BlfIngestReader reads
    le16(payload, 0); // direction
    le64(payload, 0); // reserved
    le16(payload, 0); // ethType (unused; real value is inside the frame bytes)
    le16(payload, 0); // tpid
    le16(payload, 0); // tci
    le16(payload, 0); // payloadLength (unused; reader derives length from objectSize)
    le64(payload, 0); // res2
    payload.insert(payload.end(), frame.begin(), frame.end());

    innerHeader(b, kEthernetFrameEx, static_cast<uint32_t>(payload.size()), timestampNs);
    b.insert(b.end(), payload.begin(), payload.end());
}

Bytes buildInnerStream()
{
    Bytes inner;

    appendCanMessage(inner, 1000, 1, 0x100, 8, { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 });
    appendCanMessage(inner, 2000, 1, 0x200, 4, { 0x0A, 0x0B, 0x0C, 0x0D });

    // E1: a packed-PDU-only UDP payload (pduId=1, len=4) -> one protocol_pdu row.
    {
        Bytes udp;
        be32(udp, 1); // pdu id
        be32(udp, 4); // pdu length
        bytes(udp, { 0xAA, 0xBB, 0xCC, 0xDD });
        appendEthernetFrame(inner, 3000, 2, 5000, udp);
    }

    // E2: a SOME/IP message (serviceId=0x1234, methodId=0x5678). The
    // length field doubles as the packed-PDU-walk's pduLen when the same
    // bytes are re-read by indexEthernetPdus; it's set > buffer size so
    // that walk overflows and does not also emit a protocol_pdu row.
    {
        Bytes udp;
        be16(udp, 0x1234); // serviceId
        be16(udp, 0x5678); // methodId
        be32(udp, 0x10); // length (16; overflows the 16-byte buffer as a pduLen)
        be16(udp, 0x0001); // clientId
        be16(udp, 0x0001); // sessionId
        u8(udp, 1); // protocolVersion
        u8(udp, 1); // interfaceVersion
        u8(udp, 0x00); // messageType = REQUEST
        u8(udp, 0x00); // returnCode = OK
        appendEthernetFrame(inner, 4000, 2, 30509, udp);
    }

    // E3: a SOME/IP-SD message (serviceId=0xFFFF, methodId=0x8100, 1 flags byte).
    {
        Bytes udp;
        be16(udp, 0xFFFF);
        be16(udp, 0x8100);
        be32(udp, 0x10); // overflows the 17-byte buffer as a pduLen, same reasoning as E2
        pad(udp, 8); // bytes [8..16) unused by the SD peel
        u8(udp, 0x01); // flags byte at offset 16 (ProtocolParser reads tm.data[16] exactly)
        appendEthernetFrame(inner, 5000, 2, 30490, udp);
    }

    // E4: a DoIP diagnostic message (dstPort 13400). Its payloadLength field
    // (4) is also read by indexEthernetPdus as a pduLen, which happens to
    // fit (8+4<=12) -- so this frame intentionally also produces one
    // protocol_pdu row alongside its protocol_doip row. See native/store/README.md.
    {
        Bytes udp;
        u8(udp, 0x02); // protocolVersion
        u8(udp, 0xFD); // inverseVersion
        be16(udp, 0x8001); // payloadType = diagnostic message
        be32(udp, 4); // payloadLength
        be16(udp, 0x0E00); // sourceAddress
        be16(udp, 0x0001); // targetAddress
        appendEthernetFrame(inner, 6000, 2, 13400, udp);
    }

    return inner;
}

Bytes zlibCompress(const Bytes& in)
{
    auto* comp = libdeflate_alloc_compressor(6);
    Bytes out(in.size() + 1024);
    size_t n = libdeflate_zlib_compress(comp, in.data(), in.size(), out.data(), out.size());
    out.resize(n);
    libdeflate_free_compressor(comp);
    return out;
}

Bytes buildBlfFile()
{
    Bytes inner = buildInnerStream();
    Bytes compressed = zlibCompress(inner);

    Bytes file;
    // BlfFileHeader ("LOGG" + fields; none of them are validated beyond the signature).
    bytes(file, { 'L', 'O', 'G', 'G' });
    const uint32_t fileHeaderSize = 4 + 4 + 4 + 1 + 1 + 1 + 1 + 8 + 8 + 4 + 4 + 16 + 16 + 8;
    le32(file, fileHeaderSize);
    le32(file, 0); // apiVersion
    u8(file, 0); // appId
    u8(file, 0); // compressionLevel
    u8(file, 1); // majorVersion
    u8(file, 1); // minorVersion
    le64(file, compressed.size()); // compressedSize
    le64(file, inner.size()); // uncompressedSize
    le32(file, 6); // numObj
    le32(file, 0); // appBuildId
    pad(file, 16); // measurementStartTime
    pad(file, 16); // measurementEndTime
    le64(file, 0); // nextRestorepoint

    // One top-level LOBJ(LOG_CONTAINER): BlfObjectHeaderBase(16) + a 16-byte
    // placeholder (read but unused by BlfIngestReader) + zlib-compressed inner stream.
    bytes(file, { 'L', 'O', 'B', 'J' });
    le16(file, 32); // headerSize
    le16(file, 1); // headerVersion
    le32(file, 48 + static_cast<uint32_t>(compressed.size())); // objectSize
    le32(file, kLogContainer);
    pad(file, 16); // placeholder region (compression method etc.; unread by this reader)
    file.insert(file.end(), compressed.begin(), compressed.end());

    return file;
}

const char* kArxml = R"ARXML(<?xml version="1.0" encoding="UTF-8"?>
<AUTOSAR xmlns="http://autosar.org/schema/r4.0">
  <AR-PACKAGES>
    <AR-PACKAGE>
      <SHORT-NAME>Fixture</SHORT-NAME>
      <ELEMENTS>
        <ECU-INSTANCE>
          <SHORT-NAME>Gateway</SHORT-NAME>
        </ECU-INSTANCE>
        <CAN-CLUSTER>
          <SHORT-NAME>PowertrainCan</SHORT-NAME>
          <CAN-CLUSTER-VARIANTS>
            <CAN-CLUSTER-CONDITIONAL>
              <PHYSICAL-CHANNELS>
                <CAN-PHYSICAL-CHANNEL>
                  <SHORT-NAME>PowertrainCanChannel</SHORT-NAME>
                  <FRAME-TRIGGERINGS>
                    <CAN-FRAME-TRIGGERING>
                      <SHORT-NAME>EngineMsg</SHORT-NAME>
                      <IDENTIFIER>256</IDENTIFIER>
                      <CAN-ADDRESSING-MODE>STANDARD</CAN-ADDRESSING-MODE>
                      <FRAME-REF DEST="CAN-FRAME">/Fixture/EngineFrame</FRAME-REF>
                    </CAN-FRAME-TRIGGERING>
                  </FRAME-TRIGGERINGS>
                </CAN-PHYSICAL-CHANNEL>
              </PHYSICAL-CHANNELS>
            </CAN-CLUSTER-CONDITIONAL>
          </CAN-CLUSTER-VARIANTS>
        </CAN-CLUSTER>
        <CAN-FRAME>
          <SHORT-NAME>EngineFrame</SHORT-NAME>
          <FRAME-LENGTH>8</FRAME-LENGTH>
        </CAN-FRAME>
        <ETHERNET-CLUSTER>
          <SHORT-NAME>BackboneEthernet</SHORT-NAME>
          <ETHERNET-CLUSTER-VARIANTS>
            <ETHERNET-CLUSTER-CONDITIONAL>
              <PHYSICAL-CHANNELS>
                <ETHERNET-PHYSICAL-CHANNEL>
                  <SHORT-NAME>BackboneChannel</SHORT-NAME>
                  <PDU-TRIGGERINGS>
                    <PDU-TRIGGERING>
                      <SHORT-NAME>E1Pdu</SHORT-NAME>
                      <I-PDU-REF DEST="I-SIGNAL-I-PDU">/Fixture/E1Pdu</I-PDU-REF>
                    </PDU-TRIGGERING>
                  </PDU-TRIGGERINGS>
                </ETHERNET-PHYSICAL-CHANNEL>
              </PHYSICAL-CHANNELS>
            </ETHERNET-CLUSTER-CONDITIONAL>
          </ETHERNET-CLUSTER-VARIANTS>
        </ETHERNET-CLUSTER>
        <I-SIGNAL-I-PDU>
          <SHORT-NAME>E1Pdu</SHORT-NAME>
          <LENGTH>12</LENGTH>
        </I-SIGNAL-I-PDU>
      </ELEMENTS>
    </AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>
)ARXML";

} // namespace

int main(int argc, char** argv)
{
    if (argc != 3) {
        std::fprintf(stderr, "usage: %s <out.blf> <out.arxml>\n", argv[0]);
        return 1;
    }

    const Bytes blf = buildBlfFile();
    std::ofstream blfOut(argv[1], std::ios::binary);
    blfOut.write(reinterpret_cast<const char*>(blf.data()), static_cast<std::streamsize>(blf.size()));
    if (!blfOut) {
        std::fprintf(stderr, "failed to write %s\n", argv[1]);
        return 1;
    }

    std::ofstream arxmlOut(argv[2]);
    arxmlOut << kArxml;
    if (!arxmlOut) {
        std::fprintf(stderr, "failed to write %s\n", argv[2]);
        return 1;
    }

    return 0;
}
