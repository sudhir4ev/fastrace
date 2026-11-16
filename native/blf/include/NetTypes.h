#pragma once
#include <bit>
#include <cstdint>

// Portable big-endian → host conversion for 16-bit network fields.
inline constexpr uint16_t beToHost16(uint16_t v) noexcept
{
    if constexpr (std::endian::native == std::endian::big) {
        return v;
    }
    return static_cast<uint16_t>((v >> 8u) | (v << 8u));
}

#pragma pack(push, 1)

// Ethernet II wire header (14 bytes).
struct EthernetWireHeader {
    uint8_t dstAddr[6];
    uint8_t srcAddr[6];
    uint16_t etherType; // big-endian; 0x0800=IPv4, 0x86DD=IPv6, 0x8100=VLAN
};
static_assert(sizeof(EthernetWireHeader) == 14);

// IPv4 header (20 bytes minimum; options may extend to IHL*4 bytes).
struct IPv4Header {
    uint8_t versionIHL; // version (upper 4 bits) + IHL in 32-bit words (lower 4
                        // bits)
    uint8_t dscp;
    uint16_t totalLength; // big-endian
    uint16_t id;
    uint16_t flagsFrag;
    uint8_t ttl;
    uint8_t protocol; // 6=TCP, 17=UDP
    uint16_t checksum;
    uint8_t srcIP[4]; // stored in network byte order
    uint8_t dstIP[4];
};
static_assert(sizeof(IPv4Header) == 20);

// TCP header (20 bytes minimum; options may extend to dataOffset*4 bytes).
struct TCPHeader {
    uint16_t srcPort; // big-endian
    uint16_t dstPort; // big-endian
    uint32_t seqNum;
    uint32_t ackNum;
    uint8_t dataOffset; // upper 4 bits = header length in 32-bit words
    uint8_t flags; // NS|CWR|ECE|URG|ACK|PSH|RST|SYN|FIN (lower 9 bits)
    uint16_t window;
    uint16_t checksum;
    uint16_t urgentPtr;
};
static_assert(sizeof(TCPHeader) == 20);

// UDP header (8 bytes).
struct UDPHeader {
    uint16_t srcPort; // big-endian
    uint16_t dstPort; // big-endian
    uint16_t length; // big-endian; total segment length (header + data)
    uint16_t checksum;
};
static_assert(sizeof(UDPHeader) == 8);

// PTP (IEEE 1588-2008) common message header (34 bytes).
// Applies to all PTP message types; message-specific body follows.
struct PTPHeader {
    uint8_t msgTypeTransSpec; // lower 4: messageType, upper 4: transportSpecific
    uint8_t versionPTP; // lower 4: PTP version (2), upper 4: reserved
    uint16_t messageLength; // big-endian; total length including header
    uint8_t domainNumber;
    uint8_t reserved1;
    uint16_t flags; // big-endian; e.g. 0x0200=twoStep, 0x0004=unicast
    int64_t correctionField; // big-endian; nanoseconds * 2^16
    uint32_t reserved2;
    uint8_t clockIdentity[8]; // source clock identity (EUI-64)
    uint16_t sourcePortNumber; // big-endian; port within the clock
    uint16_t sequenceId; // big-endian
    uint8_t controlField; // deprecated in v2; 0=Sync, 1=Delay_Req, 2=Follow_Up, ...
    int8_t logMessageInterval;
};
static_assert(sizeof(PTPHeader) == 34);

// IPv6 header (fixed 40 bytes; extension headers may follow before TCP/UDP).
struct IPv6Header {
    uint8_t versionTC; // version (upper 4 bits) + traffic class high (lower 4 bits)
    uint8_t tcFlow; // traffic class low (upper 4 bits) + flow label high (lower
                    // 4 bits)
    uint16_t flowLow; // flow label low 16 bits
    uint16_t payloadLen; // big-endian; payload length after this header
    uint8_t nextHeader; // 6=TCP, 17=UDP, 58=ICMPv6, 43=routing, 44=fragment,
                        // 60=dest opts
    uint8_t hopLimit;
    uint8_t srcAddr[16]; // network byte order
    uint8_t dstAddr[16]; // network byte order
};
static_assert(sizeof(IPv6Header) == 40);

// SOME/IP header (16 bytes).
struct SomeIpWireHeader {
    uint16_t serviceId; // big-endian
    uint16_t methodId; // big-endian
    uint32_t length; // big-endian
    uint16_t clientId; // big-endian
    uint16_t sessionId; // big-endian
    uint8_t protocolVersion;
    uint8_t interfaceVersion;
    uint8_t messageType;
    uint8_t returnCode;
};
static_assert(sizeof(SomeIpWireHeader) == 16);

// DoIP header (8 bytes).
struct DoipWireHeader {
    uint8_t protocolVersion;
    uint8_t inverseVersion;
    uint16_t payloadType; // big-endian
    uint32_t payloadLength; // big-endian
};
static_assert(sizeof(DoipWireHeader) == 8);

// DoIP diagnostic sub-header (4 bytes).
struct DoipDiagSubHeader {
    uint16_t sourceAddress; // big-endian
    uint16_t targetAddress; // big-endian
};
static_assert(sizeof(DoipDiagSubHeader) == 4);

#pragma pack(pop)
