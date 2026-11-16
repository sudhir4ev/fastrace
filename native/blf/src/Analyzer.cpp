#include "Analyzer.h"
#include "ArxmlParser.h"
#include "SignalDecoder.h"

#include <chrono>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif
#include <libdeflate.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <format>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <string>
#include <thread>
#include <type_traits>
#include <unordered_map>
#include <vector>

#include "BlfTypes.h"
#include "Cursor.h"
#include "MappedFile.h"
#include "NetTypes.h"
#include "WorkQueue.h"

namespace fastrace {

static ProtocolGroup protocolGroupOf(uint32_t objectType)
{
    switch (objectType) {
    case CAN_MESSAGE:
    case CAN_MESSAGE2:
    case CAN_FD_MESSAGE:
    case CAN_FD_MESSAGE_64:
        return ProtocolGroup::CAN;
    case ETHERNET_FRAME:
    case ETHERNET_FRAME_EX:
    case ETHERNET_FRAME_FORWARDED:
        return ProtocolGroup::Ethernet;
    default:
        return ProtocolGroup::COUNT;
    }
}

// ratio used to allocate buffer for decompressed data. if insufficient, a
// reallocation would be triggered based on real traces, compressed objects seem
// to have a compression ratio of 4.5.
constexpr size_t DECOMP_BUFFER_PREALLOC_RATIO = 6;
constexpr uint32_t BLF_LOGG_SIGNATURE = 0x47474f4c; // "LOGG"
constexpr uint32_t BLF_LOBJ_SIGNATURE = 0x4a424f4c; // "LOBJ"

// ---------------------------------------------------------------------------
// parseTransport – decode and log TCP/UDP headers from a raw Ethernet frame.
// frame must point to the first byte of the Ethernet wire data (dst MAC).
// ---------------------------------------------------------------------------
static constexpr std::string_view kPTPMsgTypes[16] = {
    "Sync",
    "Delay_Req",
    "Pdelay_Req",
    "Pdelay_Resp",
    "?4",
    "?5",
    "?6",
    "?7",
    "Follow_Up",
    "Delay_Resp",
    "Pdelay_Resp_Follow_Up",
    "Announce",
    "Signaling",
    "Management",
    "?14",
    "?15",
};

static void parsePTP(const char* data, size_t len)
{
    if (len < sizeof(PTPHeader)) {
        return;
    }
    const auto* p = reinterpret_cast<const PTPHeader*>(data);
    const uint8_t msgType = p->msgTypeTransSpec & 0x0Fu;
    const auto& ci = p->clockIdentity;
    spdlog::debug("    PTP {} dom={} seq={} "
                  "src={:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}:{}",
        kPTPMsgTypes[msgType], p->domainNumber, beToHost16(p->sequenceId), ci[0], ci[1], ci[2], ci[3], ci[4], ci[5],
        ci[6], ci[7], beToHost16(p->sourcePortNumber));
}

// Format an IPv6 address as eight colon-separated 16-bit groups.
static std::string fmtIPv6(const uint8_t addr[16])
{
    return std::format("{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:"
                       "{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}",
        addr[0], addr[1], addr[2], addr[3], addr[4], addr[5], addr[6], addr[7], addr[8], addr[9], addr[10], addr[11],
        addr[12], addr[13], addr[14], addr[15]);
}

static bool extractUdpInfo(const char* frame, size_t frameLen, std::string& dstIpOut, uint16_t& dstPortOut,
    const char*& payloadOut, size_t& payloadLenOut)
{
    if (frameLen < sizeof(EthernetWireHeader)) {
        return false;
    }
    const auto* eth = reinterpret_cast<const EthernetWireHeader*>(frame);
    size_t offset = sizeof(EthernetWireHeader);
    uint16_t etherType = beToHost16(eth->etherType);
    if ((etherType == 0x8100u || etherType == 0x88A8u) && frameLen >= offset + 4) {
        uint16_t inner;
        std::memcpy(&inner, frame + offset + 2, 2);
        etherType = beToHost16(inner);
        offset += 4;
    }
    if (etherType == 0x0800u) {
        if (frameLen < offset + sizeof(IPv4Header)) {
            return false;
        }
        const auto* ip = reinterpret_cast<const IPv4Header*>(frame + offset);
        const size_t ihlBytes = static_cast<size_t>(ip->versionIHL & 0x0Fu) * 4u;
        if (ihlBytes < 20u || frameLen < offset + ihlBytes) {
            return false;
        }
        offset += ihlBytes;
        if (ip->protocol == 17u && frameLen >= offset + sizeof(UDPHeader)) {
            const auto* udp = reinterpret_cast<const UDPHeader*>(frame + offset);
            dstIpOut = std::format("{}.{}.{}.{}", ip->dstIP[0], ip->dstIP[1], ip->dstIP[2], ip->dstIP[3]);
            dstPortOut = beToHost16(udp->dstPort);
            payloadOut = frame + offset + sizeof(UDPHeader);
            uint16_t udpLen = beToHost16(udp->length);
            payloadLenOut = udpLen > 8u ? udpLen - 8u : 0u;
            if (payloadLenOut > frameLen - offset - sizeof(UDPHeader)) {
                payloadLenOut = frameLen - offset - sizeof(UDPHeader);
            }
            return true;
        }
    } else if (etherType == 0x86DDu) {
        if (frameLen < offset + sizeof(IPv6Header)) {
            return false;
        }
        const auto* ip6 = reinterpret_cast<const IPv6Header*>(frame + offset);
        dstIpOut = fmtIPv6(ip6->dstAddr);
        offset += sizeof(IPv6Header);
        uint8_t nextHdr = ip6->nextHeader;
        while (nextHdr == 0u || nextHdr == 43u || nextHdr == 60u) {
            if (frameLen < offset + 2) {
                return false;
            }
            const uint8_t extLen = static_cast<uint8_t>(frame[offset + 1]);
            nextHdr = static_cast<uint8_t>(frame[offset]);
            offset += static_cast<size_t>(extLen + 1) * 8u;
            if (frameLen < offset) {
                return false;
            }
        }
        if (nextHdr == 44u) {
            if (frameLen < offset + 8) {
                return false;
            }
            nextHdr = static_cast<uint8_t>(frame[offset]);
            offset += 8u;
        }
        if (nextHdr == 17u && frameLen >= offset + sizeof(UDPHeader)) {
            const auto* udp = reinterpret_cast<const UDPHeader*>(frame + offset);
            dstPortOut = beToHost16(udp->dstPort);
            payloadOut = frame + offset + sizeof(UDPHeader);
            uint16_t udpLen = beToHost16(udp->length);
            payloadLenOut = udpLen > 8u ? udpLen - 8u : 0u;
            if (payloadLenOut > frameLen - offset - sizeof(UDPHeader)) {
                payloadLenOut = frameLen - offset - sizeof(UDPHeader);
            }
            return true;
        }
    }
    return false;
}

// Decode and log TCP/UDP from a raw Ethernet wire frame (dst MAC first).
static void parseTransport(const char* frame, size_t frameLen)
{
    if (frameLen < sizeof(EthernetWireHeader)) {
        return;
    }

    const auto* eth = reinterpret_cast<const EthernetWireHeader*>(frame);
    size_t offset = sizeof(EthernetWireHeader);

    uint16_t etherType = beToHost16(eth->etherType);

    // Strip one VLAN tag (802.1Q or 802.1AD).
    if ((etherType == 0x8100u || etherType == 0x88A8u) && frameLen >= offset + 4) {
        uint16_t inner;
        std::memcpy(&inner, frame + offset + 2, 2);
        etherType = beToHost16(inner);
        offset += 4;
    }

    if (etherType == 0x0800u) {
        // IPv4
        if (frameLen < offset + sizeof(IPv4Header)) {
            return;
        }
        const auto* ip = reinterpret_cast<const IPv4Header*>(frame + offset);
        const size_t ihlBytes = static_cast<size_t>(ip->versionIHL & 0x0Fu) * 4u;
        if (ihlBytes < 20u || frameLen < offset + ihlBytes) {
            return;
        }
        offset += ihlBytes;

        if (ip->protocol == 6u && frameLen >= offset + sizeof(TCPHeader)) {
            const auto* tcp = reinterpret_cast<const TCPHeader*>(frame + offset);
            spdlog::debug("  TCP {}.{}.{}.{}:{} -> {}.{}.{}.{}:{} flags=0x{:02x}", ip->srcIP[0], ip->srcIP[1],
                ip->srcIP[2], ip->srcIP[3], beToHost16(tcp->srcPort), ip->dstIP[0], ip->dstIP[1], ip->dstIP[2],
                ip->dstIP[3], beToHost16(tcp->dstPort), tcp->flags);
        } else if (ip->protocol == 17u && frameLen >= offset + sizeof(UDPHeader)) {
            const auto* udp = reinterpret_cast<const UDPHeader*>(frame + offset);
            const uint16_t sport = beToHost16(udp->srcPort);
            const uint16_t dport = beToHost16(udp->dstPort);
            const uint16_t udpLen = beToHost16(udp->length);
            spdlog::debug("  UDP {}.{}.{}.{}:{} -> {}.{}.{}.{}:{} len={}", ip->srcIP[0], ip->srcIP[1], ip->srcIP[2],
                ip->srcIP[3], sport, ip->dstIP[0], ip->dstIP[1], ip->dstIP[2], ip->dstIP[3], dport,
                udpLen > 8u ? udpLen - 8u : 0u);
            if (sport == 319u || sport == 320u || dport == 319u || dport == 320u) {
                parsePTP(frame + offset + sizeof(UDPHeader), frameLen - offset - sizeof(UDPHeader));
            }
        }
    } else if (etherType == 0x86DDu) {
        // IPv6 (fixed 40-byte header; skip extension headers until TCP/UDP)
        if (frameLen < offset + sizeof(IPv6Header)) {
            return;
        }
        const auto* ip6 = reinterpret_cast<const IPv6Header*>(frame + offset);
        offset += sizeof(IPv6Header);

        uint8_t nextHdr = ip6->nextHeader;
        // Walk past common extension headers (routing=43, hop-by-hop=0, dest=60).
        while (nextHdr == 0u || nextHdr == 43u || nextHdr == 60u) {
            if (frameLen < offset + 2) {
                return;
            }
            const uint8_t extLen = static_cast<uint8_t>(frame[offset + 1]);
            nextHdr = static_cast<uint8_t>(frame[offset]);
            offset += static_cast<size_t>(extLen + 1) * 8u;
            if (frameLen < offset) {
                return;
            }
        }
        // Fragment header (44) is fixed 8 bytes.
        if (nextHdr == 44u) {
            if (frameLen < offset + 8) {
                return;
            }
            nextHdr = static_cast<uint8_t>(frame[offset]);
            offset += 8u;
        }

        if (nextHdr == 6u && frameLen >= offset + sizeof(TCPHeader)) {
            const auto* tcp = reinterpret_cast<const TCPHeader*>(frame + offset);
            spdlog::debug("  TCP [{}]:{} -> [{}]:{} flags=0x{:02x}", fmtIPv6(ip6->srcAddr), beToHost16(tcp->srcPort),
                fmtIPv6(ip6->dstAddr), beToHost16(tcp->dstPort), tcp->flags);
        } else if (nextHdr == 17u && frameLen >= offset + sizeof(UDPHeader)) {
            const auto* udp = reinterpret_cast<const UDPHeader*>(frame + offset);
            const uint16_t sport = beToHost16(udp->srcPort);
            const uint16_t dport = beToHost16(udp->dstPort);
            const uint16_t udpLen = beToHost16(udp->length);
            spdlog::debug("  UDP [{}]:{} -> [{}]:{} len={}", fmtIPv6(ip6->srcAddr), sport, fmtIPv6(ip6->dstAddr), dport,
                udpLen > 8u ? udpLen - 8u : 0u);
            if (sport == 319u || sport == 320u || dport == 319u || dport == 320u) {
                parsePTP(frame + offset + sizeof(UDPHeader), frameLen - offset - sizeof(UDPHeader));
            }
        }
    } else if (etherType == 0x88F7u) {
        // PTP directly over Ethernet (no IP/UDP wrapper)
        parsePTP(frame + offset, frameLen - offset);
    }
}

// ---------------------------------------------------------------------------
// processInnerObjects – walk decompressed container payload, decode CAN and
// Ethernet log objects, and accumulate per-call counters.
// headFragOut and tailFragOut will be null when being called by the Stitcher.
//
// Design notes:
//   * Operates entirely on the caller-supplied scratch buffer which is already
//     hot in L3 cache after libdeflate writes it.  Zero extra copies.
//   * Returns counts via out-params so the caller can merge them into a single
//     atomic update – minimising atomic traffic between threads.
// ---------------------------------------------------------------------------
// Forward declarations – both are defined later in this file.
static bool findNextLobj(Cursor& cursor, uint32_t& sigOut);
std::string_view objectTypeName(uint32_t t);

// Convert a BLF object timestamp to microseconds.
// BlfObjectHeader::flags bits: 0x1 = TEN_MICS (10 µs/tick), 0x2 = ONE_NANS (1
// ns/tick). Default (no flag): 100 ns/tick.
static uint64_t tsToMicroseconds(uint64_t ts, uint32_t flags) noexcept
{
    if (flags & 0x2u) {
        return ts / 1000u; // 1 ns ticks
    }
    if (flags & 0x1u) {
        return ts * 10u; // 10 µs ticks
    }
    return ts / 10u; // 100 ns ticks (default)
}

static void processInnerObjects(Analyzer* self, const char* data, size_t dataLen,
    std::unordered_map<uint32_t, uint64_t>& counts, uint64_t& splitCount, std::vector<char>* headFragOut = nullptr,
    std::vector<char>* tailFragOut = nullptr)
{
    Cursor cur { data, data + dataLen, data };

    BlfObjectHeaderBase base;
    bool firstObject = true;
    while (!cur.eof()) {
        const char* loopStart = cur.pos;

        if (!findNextLobj(cur, base.signature)) {
            if (firstObject) {
                if (headFragOut) {
                    headFragOut->assign(data, data + dataLen);
                }
            } else {
                if (tailFragOut && loopStart < data + dataLen) {
                    tailFragOut->assign(loopStart, data + dataLen);
                }
            }
            break;
        }

        if (firstObject) {
            firstObject = false;
            const size_t firstLobjAt = cur.tell() - 4;
            if (headFragOut) {
                headFragOut->assign(data, data + firstLobjAt);
            }
        }

        if (!cur.read(reinterpret_cast<char*>(&base) + 4, sizeof(BlfObjectHeaderBase) - 4)) {
            if (tailFragOut) {
                const char* objStart = cur.pos - 4;
                tailFragOut->assign(objStart, data + dataLen);
            }
            break;
        }

        // -----------------------------------------------------------------------
        // Cross-container split detection.
        //
        // base.objectSize is the total byte length of this LOBJ (header + payload)
        // measured from the start of the "LOBJ" signature.  The object started
        // sizeof(BlfObjectHeaderBase) bytes before the current cursor position.
        //
        //   objectEnd = objectStart + base.objectSize
        //             = (cur.tell() - sizeof(BlfObjectHeaderBase)) +
        //             base.objectSize
        //
        // If objectEnd > dataLen the encoder placed the tail of this object into
        // the next compressed container – exactly the split case we want to detect.
        // -----------------------------------------------------------------------
        const size_t objectStart = cur.tell() - sizeof(BlfObjectHeaderBase);
        const size_t objectEnd = objectStart + base.objectSize;
        if (objectEnd > dataLen) {
            const size_t bytesAvail = dataLen - objectStart;
            const size_t bytesOverflow = objectEnd - dataLen;
            spdlog::debug("SPLIT: type={} ({}) objectSize={} B  |  {} B in this "
                          "container, {} B in next",
                base.objectType, objectTypeName(base.objectType), base.objectSize, bytesAvail, bytesOverflow);
            ++splitCount;
            if (tailFragOut) {
                tailFragOut->assign(data + objectStart, data + dataLen);
            }
            break; // remainder of this object lives in the next container; stop here
        }

        // The object's payload starts right after the base header.
        // headerSize includes the 4-byte signature but NOT the BlfObjectHeader
        // extension; it equals sizeof(BlfObjectHeaderBase) +
        // sizeof(BlfObjectHeader) for type-1 headers, or may differ for type-2/3.
        // We read exactly (headerSize - sizeof(BlfObjectHeaderBase)) bytes of extra
        // header, then the remaining payload is (objectSize - headerSize) bytes.
        uint64_t timestamp = 0;
        uint32_t objFlags = 0;
        const size_t extraHdrBytes
            = base.headerSize > sizeof(BlfObjectHeaderBase) ? base.headerSize - sizeof(BlfObjectHeaderBase) : 0;
        if (self->collectMessages && extraHdrBytes >= sizeof(BlfObjectHeader)) {
            BlfObjectHeader extHdr;
            if (!cur.read(&extHdr, sizeof(BlfObjectHeader))) {
                break;
            }
            timestamp = extHdr.timestamp;
            objFlags = extHdr.flags;
            const size_t remaining = extraHdrBytes - sizeof(BlfObjectHeader);
            if (remaining > 0 && !cur.skip(remaining)) {
                break;
            }
        } else if (extraHdrBytes > 0) {
            // Benchmark / non-collection path: skip without copying.
            if (!cur.skip(extraHdrBytes)) {
                break;
            }
        }

        const size_t payloadBytes = base.objectSize > base.headerSize ? base.objectSize - base.headerSize : 0;

        switch (static_cast<BLFObjectType>(base.objectType)) {
        case CAN_MESSAGE:
        case CAN_MESSAGE2: {
            if (payloadBytes < sizeof(CANMessage)) {
                spdlog::debug("inner: CAN object too short ({} B)", payloadBytes);
                cur.skip(payloadBytes);
                break;
            }
            CANMessage msg;
            cur.read(&msg, sizeof(CANMessage));
            const size_t surplus = payloadBytes - sizeof(CANMessage);
            if (surplus > 0) {
                cur.skip(surplus);
            }

            ++counts[base.objectType];
            if (self->dumpObjContents) {
                const uint32_t rawId = msg.id;
                const bool ext = (rawId >> 31) & 1;
                const uint32_t arbId = ext ? (rawId & 0x1FFFFFFFu) : (rawId & 0x7FFu);
                const uint8_t dlen = (std::min)(msg.dlc, static_cast<uint8_t>(8));
                std::string hex;
                hex.reserve(dlen * 3);
                for (uint8_t i = 0; i < dlen; ++i) {
                    hex += std::format("{:02x} ", msg.data[i]);
                }
                spdlog::debug(
                    "CAN ch={} id=0x{:x}{} dlc={} data: {}", msg.channel, arbId, ext ? "x" : "", msg.dlc, hex);
            }
            if (self->collectMessages) {
                const uint32_t rawId = msg.id;
                const bool ext = (rawId >> 31) & 1u;
                TraceMessage tm;
                tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
                tm.objectType = base.objectType;
                tm.channel = msg.channel;
                tm.arbId = ext ? (rawId & 0x1FFFFFFFu) : (rawId & 0x7FFu);
                tm.extendedId = ext;
                tm.dlc = msg.dlc;
                size_t dlen = (std::min)(msg.dlc, static_cast<uint8_t>(8));
                tm.data.assign(msg.data, msg.data + dlen);
                std::lock_guard<std::mutex> lk(self->messagesMu);
                if (self->messages.size() < self->maxMessages) {
                    self->messages.push_back(std::move(tm));
                    self->messagesCollected.fetch_add(1, std::memory_order_relaxed);
                }
            }
            break;
        }

        case ETHERNET_FRAME_EX: {
            if (payloadBytes < sizeof(EthernetFrameHeader)) {
                spdlog::debug("inner: ETH object too short ({} B)", payloadBytes);
                cur.skip(payloadBytes);
                break;
            }
            EthernetFrameHeader eth;
            cur.read(&eth, sizeof(EthernetFrameHeader));
            const char* frameData = cur.pos; // raw Ethernet wire bytes (dst MAC, src MAC, ...)
            const size_t frameLen = payloadBytes - sizeof(EthernetFrameHeader);
            if (frameLen > 0) {
                cur.skip(frameLen);
            }

            ++counts[base.objectType];
            if (self->dumpObjContents) {
                const size_t dumpLen = (std::min)(frameLen, static_cast<size_t>(20));
                std::string hex;
                hex.reserve(dumpLen * 3);
                for (size_t i = 0; i < dumpLen; ++i) {
                    hex += std::format("{:02x} ", static_cast<uint8_t>(frameData[i]));
                }
                spdlog::debug(
                    "ETH ch={} dir={} paylen={} frame: {}", eth.channel, eth.direction, eth.payloadLength, hex);
                parseTransport(frameData, frameLen);
            }
            if (self->collectMessages) {
                TraceMessage tm;
                tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
                tm.objectType = base.objectType;
                tm.channel = eth.channel;
                tm.dlc = 0;
                std::string dstIp;
                uint16_t dstPort = 0;
                const char* udpPayload = nullptr;
                size_t udpPayloadLen = 0;
                if (extractUdpInfo(frameData, frameLen, dstIp, dstPort, udpPayload, udpPayloadLen)) {
                    tm.dstIp = std::move(dstIp);
                    tm.dstPort = dstPort;
                    tm.data.assign(udpPayload, udpPayload + udpPayloadLen);
                    size_t pOffset = 0;
                    while (pOffset + 8 <= udpPayloadLen) {
                        uint32_t pduId = (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset])) << 24)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 1])) << 16)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 2])) << 8)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 3])));
                        uint32_t pduLen = (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 4])) << 24)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 5])) << 16)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 6])) << 8)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 7])));
                        pOffset += 8;
                        if (pOffset + pduLen > udpPayloadLen) {
                            break;
                        }
                        tm.pdus[pduId] = PduIndex { static_cast<uint16_t>(pOffset), static_cast<uint16_t>(pduLen) };
                        pOffset += pduLen;
                    }
                } else {
                    tm.data.assign(frameData, frameData + (std::min)(frameLen, size_t { 64 }));
                }
                std::lock_guard<std::mutex> lk(self->messagesMu);
                if (self->messages.size() < self->maxMessages) {
                    self->messages.push_back(std::move(tm));
                    self->messagesCollected.fetch_add(1, std::memory_order_relaxed);
                }
            }
            break;
        }

        case CAN_FD_MESSAGE: {
            if (payloadBytes < sizeof(CANFDMessage)) {
                spdlog::debug("inner: CAN_FD object too short ({} B)", payloadBytes);
                cur.skip(payloadBytes);
                break;
            }
            CANFDMessage msg;
            cur.read(&msg, sizeof(CANFDMessage));
            const char* dataPtr = cur.pos; // data[64] follows the fixed header
            const size_t dataAvail = payloadBytes - sizeof(CANFDMessage);
            if (dataAvail > 0) {
                cur.skip(dataAvail);
            }

            ++counts[base.objectType];
            if (self->dumpObjContents) {
                const uint32_t rawId = msg.arbId;
                const bool ext = (rawId >> 31) & 1;
                const uint32_t arbId = ext ? (rawId & 0x1FFFFFFFu) : (rawId & 0x7FFu);
                const size_t dlen = (std::min)(static_cast<size_t>(msg.validDataBytes), dataAvail);
                std::string hex;
                hex.reserve(dlen * 3);
                for (size_t i = 0; i < dlen; ++i) {
                    hex += std::format("{:02x} ", static_cast<uint8_t>(dataPtr[i]));
                }
                spdlog::info("CAN_FD ch={} id=0x{:x}{} dlc={} len={} data: {}", msg.channel, arbId, ext ? "x" : "",
                    msg.dlc, msg.validDataBytes, hex);
            }
            if (self->collectMessages) {
                const uint32_t rawId = msg.arbId;
                const bool ext = (rawId >> 31) & 1u;
                const size_t dlen
                    = (std::min)((std::min)(static_cast<size_t>(msg.validDataBytes), dataAvail), size_t { 64 });
                TraceMessage tm;
                tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
                tm.objectType = base.objectType;
                tm.channel = msg.channel;
                tm.arbId = ext ? (rawId & 0x1FFFFFFFu) : (rawId & 0x7FFu);
                tm.extendedId = ext;
                tm.dlc = msg.dlc;
                tm.data.assign(dataPtr, dataPtr + dlen);
                std::lock_guard<std::mutex> lk(self->messagesMu);
                if (self->messages.size() < self->maxMessages) {
                    self->messages.push_back(std::move(tm));
                    self->messagesCollected.fetch_add(1, std::memory_order_relaxed);
                }
            }
            break;
        }

        case CAN_FD_MESSAGE_64: {
            if (payloadBytes < sizeof(CANFDMessage64)) {
                spdlog::warn("inner: CAN_FD_64 object too short ({} B)", payloadBytes);
                cur.skip(payloadBytes);
                break;
            }
            CANFDMessage64 msg;
            cur.read(&msg, sizeof(CANFDMessage64));
            const char* dataPtr = cur.pos; // data follows (extDataOffset reserved
                                           // bytes then payload)
            const size_t dataAvail = payloadBytes - sizeof(CANFDMessage64);
            if (dataAvail > 0) {
                cur.skip(dataAvail);
            }

            ++counts[base.objectType];
            if (self->dumpObjContents) {
                const uint32_t rawId = msg.arbId;
                const bool ext = (rawId >> 31) & 1;
                const uint32_t arbId = ext ? (rawId & 0x1FFFFFFFu) : (rawId & 0x7FFu);
                const bool brs = (msg.flags & 0x1000u) != 0;
                const bool edl = (msg.flags & 0x2000u) != 0;
                const size_t skip = msg.extDataOffset; // reserved bytes before actual data
                const size_t dlen = (std::min)(static_cast<size_t>(msg.validDataBytes), dataAvail);
                std::string hex;
                hex.reserve(dlen * 3);
                for (size_t i = 0; i < dlen; ++i) {
                    hex += std::format("{:02x} ", static_cast<uint8_t>(dataPtr[i]));
                }
                spdlog::info("CAN_FD64 ch={} id=0x{:x}{} dlc={} len={} brs={} edl={} data: {}", +msg.channel, arbId,
                    ext ? "x" : "", msg.dlc, msg.validDataBytes, brs, edl, hex);

                // __asm("nop");  // removed: not portable to MSVC x64
            }
            if (self->collectMessages) {
                const uint32_t rawId = msg.arbId;
                const bool ext = (rawId >> 31) & 1u;
                const size_t skip = msg.extDataOffset;
                const size_t dlen = (std::min)(static_cast<size_t>(msg.validDataBytes), dataAvail);
                TraceMessage tm;
                tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
                tm.objectType = base.objectType;
                tm.channel = msg.channel;
                tm.arbId = ext ? (rawId & 0x1FFFFFFFu) : (rawId & 0x7FFu);
                tm.extendedId = ext;
                tm.dlc = msg.dlc;
                if (dlen > 0) {
                    tm.data.assign(dataPtr, dataPtr + dlen);
                }
                std::lock_guard<std::mutex> lk(self->messagesMu);
                if (self->messages.size() < self->maxMessages) {
                    self->messages.push_back(std::move(tm));
                    self->messagesCollected.fetch_add(1, std::memory_order_relaxed);
                }
            }
            break;
        }

        case ETHERNET_FRAME_FORWARDED: {
            if (payloadBytes < sizeof(EthernetFrameExHeader)) {
                spdlog::debug("inner: ETH_EX object too short ({} B)", payloadBytes);
                cur.skip(payloadBytes);
                break;
            }
            EthernetFrameExHeader eth;
            cur.read(&eth, sizeof(EthernetFrameExHeader));
            const char* frameData = cur.pos; // raw Ethernet wire bytes
            const size_t frameLen = payloadBytes - sizeof(EthernetFrameExHeader);
            if (frameLen > 0) {
                cur.skip(frameLen);
            }

            ++counts[base.objectType];
            if (self->dumpObjContents) {
                const size_t dumpLen = (std::min)(frameLen, size_t { 20 });
                std::string hex;
                hex.reserve(dumpLen * 3);
                for (size_t i = 0; i < dumpLen; ++i) {
                    hex += std::format("{:02x} ", static_cast<uint8_t>(frameData[i]));
                }
                spdlog::debug("ETH_EX ch={} dir={} paylen={} frame: {}", eth.channel, eth.dir, eth.payloadLen, hex);
                parseTransport(frameData, frameLen);
            }
            if (self->collectMessages) {
                TraceMessage tm;
                tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
                tm.objectType = base.objectType;
                tm.channel = eth.channel;
                tm.dlc = 0;
                std::string dstIp;
                uint16_t dstPort = 0;
                const char* udpPayload = nullptr;
                size_t udpPayloadLen = 0;
                if (extractUdpInfo(frameData, frameLen, dstIp, dstPort, udpPayload, udpPayloadLen)) {
                    tm.dstIp = std::move(dstIp);
                    tm.dstPort = dstPort;
                    tm.data.assign(udpPayload, udpPayload + udpPayloadLen);
                    size_t pOffset = 0;
                    while (pOffset + 8 <= udpPayloadLen) {
                        uint32_t pduId = (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset])) << 24)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 1])) << 16)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 2])) << 8)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 3])));
                        uint32_t pduLen = (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 4])) << 24)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 5])) << 16)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 6])) << 8)
                            | (static_cast<uint32_t>(static_cast<uint8_t>(udpPayload[pOffset + 7])));
                        pOffset += 8;
                        if (pOffset + pduLen > udpPayloadLen) {
                            break;
                        }
                        tm.pdus[pduId] = PduIndex { static_cast<uint16_t>(pOffset), static_cast<uint16_t>(pduLen) };
                        pOffset += pduLen;
                    }
                } else {
                    tm.data.assign(frameData, frameData + (std::min)(frameLen, size_t { 64 }));
                }
                std::lock_guard<std::mutex> lk(self->messagesMu);
                if (self->messages.size() < self->maxMessages) {
                    self->messages.push_back(std::move(tm));
                    self->messagesCollected.fetch_add(1, std::memory_order_relaxed);
                }
            }
            break;
        }

        case LOG_CONTAINER:
            cur.skip(payloadBytes);
            break;

        default: {
            if (payloadBytes > 0) {
                cur.skip(payloadBytes);
            }
            ++counts[base.objectType];
            if (self->collectMessages) {
                TraceMessage tm;
                tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
                tm.objectType = base.objectType;
                tm.channel = 0;
                tm.dlc = 0;
                std::lock_guard<std::mutex> lk(self->messagesMu);
                if (self->messages.size() < self->maxMessages) {
                    self->messages.push_back(std::move(tm));
                    self->messagesCollected.fetch_add(1, std::memory_order_relaxed);
                }
            }
            break;
        }
        }
    }
}

// ---------------------------------------------------------------------------
// Per-run timing accumulators
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fragment types and queue for the Stitcher thread (Design F).
// ---------------------------------------------------------------------------
struct Fragment {
    enum class Tag { Head, Tail };
    Tag tag;
    uint64_t containerIndex;
    std::vector<char> bytes;
};

struct FragmentQueue {
    void push(Fragment f)
    {
        {
            std::lock_guard<std::mutex> lk(mu_);
            q_.push(std::move(f));
        }
        cv_.notify_one();
    }

    std::optional<Fragment> pop()
    {
        std::unique_lock<std::mutex> lk(mu_);
        cv_.wait(lk, [&] { return !q_.empty() || closed_; });
        if (q_.empty()) {
            return std::nullopt;
        }
        Fragment f = std::move(q_.front());
        q_.pop();
        return f;
    }

    void close()
    {
        {
            std::lock_guard<std::mutex> lk(mu_);
            closed_ = true;
        }
        cv_.notify_all();
    }

private:
    std::queue<Fragment> q_;
    std::mutex mu_;
    std::condition_variable cv_;
    bool closed_ = false;
};

std::string to_hex(const char* buf, size_t len)
{
    std::string result;
    result.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        result += std::format("{:02x}", static_cast<unsigned char>(buf[i]));
    }
    return result;
}

std::string to_hex(uint32_t num) { return to_hex(reinterpret_cast<const char*>(&num), 4); }

// ---------------------------------------------------------------------------
// objectTypeName – human-readable label for a BLF object type ID.
// Returns "UNKNOWN_<n>" for any type not in the table.
// Based on https://bitbucket.org/tobylorenz/vector_blf
// ---------------------------------------------------------------------------
std::string_view objectTypeName(uint32_t t)
{
    static const auto names = [] {
        std::array<std::string_view, 256> arr {};
        arr[UNKNOWN] = "UNKNOWN";
        arr[CAN_MESSAGE] = "CAN_MESSAGE";
        arr[CAN_ERROR] = "CAN_ERROR";
        arr[CAN_OVERLOAD] = "CAN_OVERLOAD";
        arr[CAN_STATISTIC] = "CAN_STATISTIC";
        arr[APP_TRIGGER] = "APP_TRIGGER";
        arr[ENV_INTEGER] = "ENV_INTEGER";
        arr[ENV_DOUBLE] = "ENV_DOUBLE";
        arr[ENV_STRING] = "ENV_STRING";
        arr[ENV_DATA] = "ENV_DATA";
        arr[LOG_CONTAINER] = "LOG_CONTAINER";
        arr[LIN_MESSAGE] = "LIN_MESSAGE";
        arr[LIN_CRC_ERROR] = "LIN_CRC_ERROR";
        arr[LIN_DLC_INFO] = "LIN_DLC_INFO";
        arr[LIN_RCV_ERROR] = "LIN_RCV_ERROR";
        arr[LIN_SND_ERROR] = "LIN_SND_ERROR";
        arr[LIN_SLV_TIMEOUT] = "LIN_SLV_TIMEOUT";
        arr[LIN_SCHED_MODCH] = "LIN_SCHED_MODCH";
        arr[LIN_SYN_ERROR] = "LIN_SYN_ERROR";
        arr[LIN_BAUDRATE] = "LIN_BAUDRATE";
        arr[LIN_SLEEP] = "LIN_SLEEP";
        arr[LIN_WAKEUP] = "LIN_WAKEUP";
        arr[MOST_SPY] = "MOST_SPY";
        arr[MOST_CTRL] = "MOST_CTRL";
        arr[MOST_LIGHTLOCK] = "MOST_LIGHTLOCK";
        arr[MOST_STATISTIC] = "MOST_STATISTIC";
        arr[Reserved26] = "Reserved26";
        arr[Reserved27] = "Reserved27";
        arr[Reserved28] = "Reserved28";
        arr[FLEXRAY_DATA] = "FLEXRAY_DATA";
        arr[FLEXRAY_SYNC] = "FLEXRAY_SYNC";
        arr[CAN_DRIVER_ERROR] = "CAN_DRIVER_ERROR";
        arr[MOST_PKT] = "MOST_PKT";
        arr[MOST_PKT2] = "MOST_PKT2";
        arr[MOST_HWMODE] = "MOST_HWMODE";
        arr[MOST_REG] = "MOST_REG";
        arr[MOST_GENREG] = "MOST_GENREG";
        arr[MOST_NETSTATE] = "MOST_NETSTATE";
        arr[MOST_DATALOST] = "MOST_DATALOST";
        arr[MOST_TRIGGER] = "MOST_TRIGGER";
        arr[FLEXRAY_CYCLE] = "FLEXRAY_CYCLE";
        arr[FLEXRAY_MESSAGE] = "FLEXRAY_MESSAGE";
        arr[LIN_CHECKSUM_INFO] = "LIN_CHECKSUM_INFO";
        arr[LIN_SPIKE_EVENT] = "LIN_SPIKE_EVENT";
        arr[CAN_DRIVER_SYNC] = "CAN_DRIVER_SYNC";
        arr[FLEXRAY_STATUS] = "FLEXRAY_STATUS";
        arr[GPS_EVENT] = "GPS_EVENT";
        arr[FR_ERROR] = "FR_ERROR";
        arr[FR_STATUS] = "FR_STATUS";
        arr[FR_STARTCYCLE] = "FR_STARTCYCLE";
        arr[FR_RCVMESSAGE] = "FR_RCVMESSAGE";
        arr[REALTIMECLOCK] = "REALTIMECLOCK";
        arr[Reserved52] = "Reserved52";
        arr[Reserved53] = "Reserved53";
        arr[LIN_STATISTIC] = "LIN_STATISTIC";
        arr[J1708_MESSAGE] = "J1708_MESSAGE";
        arr[J1708_VIRTUAL_MSG] = "J1708_VIRTUAL_MSG";
        arr[LIN_MESSAGE2] = "LIN_MESSAGE2";
        arr[LIN_SND_ERROR2] = "LIN_SND_ERROR2";
        arr[LIN_SYN_ERROR2] = "LIN_SYN_ERROR2";
        arr[LIN_CRC_ERROR2] = "LIN_CRC_ERROR2";
        arr[LIN_RCV_ERROR2] = "LIN_RCV_ERROR2";
        arr[LIN_WAKEUP2] = "LIN_WAKEUP2";
        arr[LIN_SPIKE_EVENT2] = "LIN_SPIKE_EVENT2";
        arr[LIN_LONG_DOM_SIG] = "LIN_LONG_DOM_SIG";
        arr[APP_TEXT] = "APP_TEXT";
        arr[FR_RCVMESSAGE_EX] = "FR_RCVMESSAGE_EX";
        arr[MOST_STATISTICEX] = "MOST_STATISTICEX";
        arr[MOST_TXLIGHT] = "MOST_TXLIGHT";
        arr[MOST_ALLOCTAB] = "MOST_ALLOCTAB";
        arr[MOST_STRESS] = "MOST_STRESS";
        arr[ETHERNET_FRAME] = "ETHERNET_FRAME";
        arr[SYS_VARIABLE] = "SYS_VARIABLE";
        arr[CAN_ERROR_EXT] = "CAN_ERROR_EXT";
        arr[CAN_DRIVER_ERROR_EXT] = "CAN_DRIVER_ERROR_EXT";
        arr[LIN_LONG_DOM_SIG2] = "LIN_LONG_DOM_SIG2";
        arr[MOST_150_MESSAGE] = "MOST_150_MESSAGE";
        arr[MOST_150_PKT] = "MOST_150_PKT";
        arr[MOST_ETHERNET_PKT] = "MOST_ETHERNET_PKT";
        arr[MOST_150_MESSAGE_FRAGMENT] = "MOST_150_MESSAGE_FRAGMENT";
        arr[MOST_150_PKT_FRAGMENT] = "MOST_150_PKT_FRAGMENT";
        arr[MOST_ETHERNET_PKT_FRAGMENT] = "MOST_ETHERNET_PKT_FRAGMENT";
        arr[MOST_SYSTEM_EVENT] = "MOST_SYSTEM_EVENT";
        arr[MOST_150_ALLOCTAB] = "MOST_150_ALLOCTAB";
        arr[MOST_50_MESSAGE] = "MOST_50_MESSAGE";
        arr[MOST_50_PKT] = "MOST_50_PKT";
        arr[CAN_MESSAGE2] = "CAN_MESSAGE2";
        arr[LIN_UNEXPECTED_WAKEUP] = "LIN_UNEXPECTED_WAKEUP";
        arr[LIN_SHORT_OR_SLOW_RESPONSE] = "LIN_SHORT_OR_SLOW_RESPONSE";
        arr[LIN_DISTURBANCE_EVENT] = "LIN_DISTURBANCE_EVENT";
        arr[SERIAL_EVENT] = "SERIAL_EVENT";
        arr[OVERRUN_ERROR] = "OVERRUN_ERROR";
        arr[EVENT_COMMENT] = "EVENT_COMMENT";
        arr[WLAN_FRAME] = "WLAN_FRAME";
        arr[WLAN_STATISTIC] = "WLAN_STATISTIC";
        arr[MOST_ECL] = "MOST_ECL";
        arr[GLOBAL_MARKER] = "GLOBAL_MARKER";
        arr[AFDX_FRAME] = "AFDX_FRAME";
        arr[AFDX_STATISTIC] = "AFDX_STATISTIC";
        arr[KLINE_STATUSEVENT] = "KLINE_STATUSEVENT";
        arr[CAN_FD_MESSAGE] = "CAN_FD_MESSAGE";
        arr[CAN_FD_MESSAGE_64] = "CAN_FD_MESSAGE_64";
        arr[ETHERNET_RX_ERROR] = "ETHERNET_RX_ERROR";
        arr[ETHERNET_STATUS] = "ETHERNET_STATUS";
        arr[CAN_FD_ERROR_64] = "CAN_FD_ERROR_64";
        arr[LIN_SHORT_OR_SLOW_RESPONSE2] = "LIN_SHORT_OR_SLOW_RESPONSE2";
        arr[AFDX_STATUS] = "AFDX_STATUS";
        arr[AFDX_BUS_STATISTIC] = "AFDX_BUS_STATISTIC";
        arr[Reserved108] = "Reserved108";
        arr[AFDX_ERROR_EVENT] = "AFDX_ERROR_EVENT";
        arr[A429_ERROR] = "A429_ERROR";
        arr[A429_STATUS] = "A429_STATUS";
        arr[A429_BUS_STATISTIC] = "A429_BUS_STATISTIC";
        arr[A429_MESSAGE] = "A429_MESSAGE";
        arr[ETHERNET_STATISTIC] = "ETHERNET_STATISTIC";
        arr[Unknown115] = "Unknown115";
        arr[Reserved116] = "Reserved116";
        arr[Reserved117] = "Reserved117";
        arr[TEST_STRUCTURE] = "TEST_STRUCTURE";
        arr[DIAG_REQUEST_INTERPRETATION] = "DIAG_REQUEST_INTERPRETATION";
        arr[ETHERNET_FRAME_EX] = "ETHERNET_FRAME_EX";
        arr[ETHERNET_FRAME_FORWARDED] = "ETHERNET_FRAME_FORWARDED";
        arr[ETHERNET_ERROR_EX] = "ETHERNET_ERROR_EX";
        arr[ETHERNET_ERROR_FORWARDED] = "ETHERNET_ERROR_FORWARDED";
        arr[FUNCTION_BUS] = "FUNCTION_BUS";
        arr[DATA_LOST_BEGIN] = "DATA_LOST_BEGIN";
        arr[DATA_LOST_END] = "DATA_LOST_END";
        arr[WATER_MARK_EVENT] = "WATER_MARK_EVENT";
        arr[TRIGGER_CONDITION] = "TRIGGER_CONDITION";
        arr[CAN_SETTING_CHANGED] = "CAN_SETTING_CHANGED";
        arr[DISTRIBUTED_OBJECT_MEMBER] = "DISTRIBUTED_OBJECT_MEMBER";
        arr[ATTRIBUTE_EVENT] = "ATTRIBUTE_EVENT";
        return arr;
    }();
    if (t < names.size()) {
        return names[t];
    }
    return {};
}

// ---------------------------------------------------------------------------
// findNextLobj – scan cursor forward until the "LOBJ" signature is found,
// handling up to 3 bytes of misalignment (e.g. inter-object padding).
// On success: sigOut == BLF_LOBJ_SIGNATURE, cursor is past the 4-byte sig.
// ---------------------------------------------------------------------------
static bool findNextLobj(Cursor& cursor, uint32_t& sigOut)
{
    while (cursor.remaining() >= 4) {
        // casting pointer to uint32 breaks c++ strict aliasing rules and is
        // technically UB. this is still ok on x86-64. on ARM, fallback to memcpy
#if defined(__x86_64__) || defined(_M_X64) || defined(_M_IX86)
        sigOut = *reinterpret_cast<const uint32_t*>(cursor.pos);
#else
        std::memcpy(&sigOut, cursor.pos, 4);
#endif
        if (BLF_LOBJ_SIGNATURE == sigOut) {
            cursor.pos += 4;
            return true;
        }
        cursor.pos += 1;
    }
    return false;
}

// ---------------------------------------------------------------------------
// readFileHeader – validate the LOGG header and advance the cursor past it.
// ---------------------------------------------------------------------------
std::optional<BlfFileHeader> readFileHeader(Cursor& cursor)
{
    const size_t fileSize = static_cast<size_t>(cursor.end - cursor.base);
    if (fileSize < sizeof(BlfFileHeader)) {
        spdlog::error("File is too short ({} bytes). stop", fileSize);
        return std::nullopt;
    }

    BlfFileHeader hdr;
    if (!cursor.read(&hdr, sizeof(BlfFileHeader))) {
        spdlog::error("Failed to read file header");
        return std::nullopt;
    }
    if (std::string_view(hdr.signature, sizeof(hdr.signature)) != "LOGG") {
        spdlog::error("File does not contain valid LOGG header");
        return std::nullopt;
    }

    spdlog::info("Found valid \"LOGG\" header");
    spdlog::debug("Header size:       {} (0x{:x})", hdr.headerSize, hdr.headerSize);
    spdlog::debug("apiVersion:        {} (0x{:x})", hdr.apiVersion, hdr.apiVersion);
    spdlog::debug("compressionLevel:  {}", hdr.compressionLevel);
    spdlog::debug("version:           {}.{}", hdr.majorVersion, hdr.minorVersion);
    spdlog::debug("compressedSize:    {:.2f} MiB", hdr.compressedSize / 1048576.0);
    spdlog::debug("uncompressedSize:  {:.2f} MiB", hdr.uncompressedSize / 1048576.0);
    spdlog::debug("numObj:            {}", hdr.numObj);

    const size_t padSize = hdr.headerSize - sizeof(BlfFileHeader);
    if (padSize > 0) {
        const char* pad = cursor.peek(padSize);
        if (pad) {
            spdlog::debug("File header pad: {}", to_hex(pad, padSize));
        }
    }
    return hdr;
}

// ---------------------------------------------------------------------------
// runStitcher – dedicated thread that reassembles LOBJs split across two
// adjacent compressed containers.
//
// Consumers push HeadFragment{i} (bytes before first LOBJ in container i) and
// TailFragment{i} (bytes of the incomplete LOBJ at the tail of container i) to
// the FragmentQueue.  The stitcher pairs TailFragment{i} with HeadFragment{i+1}
// to form a complete buffer, then decodes it with processInnerObjects.
// ---------------------------------------------------------------------------
static void runStitcher(Analyzer* self, FragmentQueue& fragQ, std::mutex& countsMu,
    std::unordered_map<uint32_t, uint64_t>& sharedCounts, uint64_t& sharedSplits)
{
    std::unordered_map<uint64_t, std::vector<char>> pendingTails;
    std::unordered_map<uint64_t, std::vector<char>> pendingHeads;
    std::unordered_map<uint32_t, uint64_t> localCounts;
    uint64_t localSplits = 0;
    uint64_t stitched = 0;

    std::vector<char> localBuf;
    auto assemble = [&](std::vector<char>& tail, std::vector<char>& head) {
        localBuf.clear();
        const auto sizeNeeded = tail.size() + head.size();
        if (localBuf.capacity() < sizeNeeded) {
            localBuf.reserve(sizeNeeded);
        }
        localBuf.insert(localBuf.end(), tail.begin(), tail.end());
        localBuf.insert(localBuf.end(), head.begin(), head.end());
        processInnerObjects(self, localBuf.data(), localBuf.size(), localCounts, localSplits);
        ++stitched;
    };

    while (auto frag = fragQ.pop()) {
        const uint64_t idx = frag->containerIndex;
        if (frag->tag == Fragment::Tag::Tail) {
            auto it = pendingHeads.find(idx + 1);
            if (it != pendingHeads.end()) {
                assemble(frag->bytes, it->second);
                pendingHeads.erase(it);
            } else {
                pendingTails[idx] = std::move(frag->bytes);
            }
        } else {
            auto it = pendingTails.find(idx - 1);
            if (it != pendingTails.end()) {
                assemble(it->second, frag->bytes);
                pendingTails.erase(it);
            } else {
                pendingHeads[idx] = std::move(frag->bytes);
            }
        }
    }

    if (!pendingTails.empty()) {
        spdlog::warn("Stitcher: {} unmatched tail(s) – split objects lost", pendingTails.size());
    }
    if (!pendingHeads.empty()) {
        spdlog::debug("Stitcher: {} unmatched head(s) discarded (inter-object padding)", pendingHeads.size());
    }
    spdlog::debug("Stitcher: reassembled {} split object(s)", stitched);

    if (!localCounts.empty() || localSplits > 0) {
        std::lock_guard<std::mutex> lk(countsMu);
        for (const auto& [type, cnt] : localCounts) {
            sharedCounts[type] += cnt;
        }
        sharedSplits += localSplits;
    }
}

// ---------------------------------------------------------------------------
// runConsumer – consumer thread entry point.
// Decompresses BLF container payloads popped from the work queue.
// ---------------------------------------------------------------------------
static void runConsumer(Analyzer* self, WorkQueue& queue, FragmentQueue& fragQ, std::atomic<uint64_t>& atomicContainers,
    std::atomic<uint64_t>& atomicCompressed, std::atomic<uint64_t>& atomicDecompressed, std::mutex& countsMu,
    std::unordered_map<uint32_t, uint64_t>& sharedCounts, uint64_t& sharedSplits)
{
    auto decomp = std::unique_ptr<libdeflate_decompressor, decltype(&libdeflate_free_decompressor)>(
        libdeflate_alloc_decompressor(), libdeflate_free_decompressor);
    if (!decomp) {
        spdlog::error("Failed to allocate libdeflate decompressor");
        return;
    }
    std::vector<char> localBuf; // per-thread scratch; never freed until exit
    std::unordered_map<uint32_t, uint64_t> localCounts; // accumulate without contention
    uint64_t localSplitCount = 0;

    // queue::pop will only return with an item (log object) or if the queue was
    // closed. We do not risk prematurely terminating consumers due to starvation
    while (auto item = queue.pop()) {
        atomicContainers.fetch_add(1, std::memory_order_relaxed);
        atomicCompressed.fetch_add(item->compSize, std::memory_order_relaxed);

        if (self->skipDecompress) {
            continue;
        }

        // Grow the local buffer as needed; the buffer stays at the high-water mark
        // for the rest of this thread's lifetime.
        const size_t needed = item->compSize * DECOMP_BUFFER_PREALLOC_RATIO;
        if (localBuf.size() < needed) {
            localBuf.resize(needed);
        }

        // decompress the log object. expand decompression buffer if it is
        // insufficient.
        size_t actualOut = 0;
        libdeflate_result res;
        do {
            res = libdeflate_zlib_decompress(
                decomp.get(), item->compData, item->compSize, localBuf.data(), localBuf.size(), &actualOut);
            if (LIBDEFLATE_INSUFFICIENT_SPACE == res) {
                localBuf.resize(localBuf.size() * 2);
                spdlog::debug("localBuf grown to {} B", localBuf.size());
            }
        } while (LIBDEFLATE_INSUFFICIENT_SPACE == res);

        if (LIBDEFLATE_SUCCESS == res) {
            atomicDecompressed.fetch_add(actualOut, std::memory_order_relaxed);

            // Parse inner LOBJs while the decompressed data is hot in L3 cache.
            std::vector<char> headFrag, tailFrag;
            uint64_t localSplits = 0;
            processInnerObjects(self, localBuf.data(), actualOut, localCounts, localSplits, &headFrag, &tailFrag);
            if (localSplits) {
                localSplitCount += localSplits;
            }
            if (headFrag.size()) {
                fragQ.push({ Fragment::Tag::Head, item->containerIndex, std::move(headFrag) });
            }
            if (tailFrag.size()) {
                fragQ.push({ Fragment::Tag::Tail, item->containerIndex, std::move(tailFrag) });
            }
        } else {
            spdlog::error("libdeflate failed ({})", static_cast<int>(res));
        }
    }

    // Thread is done: merge local counts into the shared map under a mutex.
    // This happens exactly once per thread, so contention is negligible.
    if (!localCounts.empty() || localSplitCount > 0) {
        std::lock_guard<std::mutex> lk(countsMu);
        for (const auto& [type, cnt] : localCounts) {
            sharedCounts[type] += cnt;
        }
        sharedSplits += localSplitCount;
    }
}

// ---------------------------------------------------------------------------
// runProducer – scan mmap'd file sequentially, push payload to work queue.
// Checks self->cancelled on every iteration; also passes it to queue.push()
// so a blocked push unblocks immediately when cancellation is requested.
// Updates self->bytesRead after each container push for UI progress polling.
// ---------------------------------------------------------------------------
static void runProducer(Analyzer* self, Cursor cursor, WorkQueue& queue)
{
    using Clock = std::chrono::steady_clock;
    auto prodStart = Clock::now();
    uint64_t containerIdx = 0;

    BlfObjectHeaderBase base;
    while (!cursor.eof() && !self->cancelled.load(std::memory_order_relaxed)) {
        // seek to start of next object and read it
        if (!findNextLobj(cursor, base.signature)) {
            break;
        }
        if (!cursor.read(reinterpret_cast<char*>(&base) + 4, sizeof(BlfObjectHeaderBase) - 4)) {
            break;
        }

        spdlog::debug("pipeline: type={} objectSize={}", base.objectType, base.objectSize);

        if (LOG_CONTAINER == base.objectType) {
            BlfObjectHeader extHdr;
            if (!cursor.read(reinterpret_cast<char*>(&extHdr), sizeof(BlfObjectHeaderBase))) {
                break;
            }

            const size_t fileOffset = cursor.tell() - 32; // LOBJ (4) + base remainder (12) + extHdr (16)

            const size_t compSize = base.objectSize - base.headerSize - sizeof(BlfObjectHeader);
            const char* compData = cursor.peek(compSize);
            if (!compData) {
                break;
            }

            if (!queue.push({ compData, compSize, containerIdx++, fileOffset }, self->cancelled)) {
                break;
            }

            // update progress for UI polling
            self->bytesRead.store(cursor.tell(), std::memory_order_relaxed);
        } else {
            // Skip non-CONTAINER object payload
            const size_t remaining = base.objectSize - sizeof(BlfObjectHeaderBase);
            if (!cursor.skip(remaining)) {
                break;
            }
        }
    }

    auto prodEnd = Clock::now();
    const double prodMs = std::chrono::duration<double, std::milli>(prodEnd - prodStart).count();
    spdlog::info("Producer done in {:.2f} ms; waiting for consumers...", prodMs);
}

// ---------------------------------------------------------------------------
// runPipeline – single-pass producer-consumer pipeline.
//
// Why this is faster than the previous two-phase approach:
//
//   Old approach (two phases, sequential):
//     Phase 1  – producer reads all 300 MB cold (mmap page faults): 168 ms
//     Phase 1b – pre-allocates 1.4 GB of output buffers: 22 ms
//     Phase 2  – workers read 300 MB (warm) + write 1444 MB (cold): 188 ms
//     Total DRAM traffic: 300 + 300 + 1444 = 2044 MB → ~5.7 GB/s → 580 MB/s
//
//   New approach (pipelined):
//     Producer scans the mmap'd file sequentially, pushing {ptr, size} items
//     to the work queue.  Consumers pop items and decompress into a small
//     per-thread buffer. The decompression buffer is reused for  all containers
//     on that thread.
//     The reused buffer (~130 KB) should stay in L3 cache; decompressed bytes
//     are (mostly) never written to DRAM. Try to process the decompressed
//     containers before they are evicted from cache.
//
//     Total DRAM traffic: ~300 MB (one cold read pass, overlapped with compute)
//
//     Additionally:
//     - MADV_WILLNEED kicks off async page loading before the producer starts,
//       so the producer finds pages warm in the kernel page cache.
//     - Producers and consumers run concurrently; I/O and compute overlap.
// ---------------------------------------------------------------------------
static void runPipeline(Analyzer* self, Cursor cursor, const BlfFileHeader& hdr, size_t nWorkers)
{
    using Clock = std::chrono::steady_clock;

    // Bound the queue to 4× workers: producer stays ahead without excessive
    // getting blocked by memory. Each in-flight item is just a pointer + size (16
    // B).
    WorkQueue queue(nWorkers * 4);

    // Shared perf counters written atomically by workers
    std::atomic<uint64_t> atomicContainers { 0 };
    std::atomic<uint64_t> atomicCompressed { 0 };
    std::atomic<uint64_t> atomicDecompressed { 0 };
    // Per-type object counts and split detections: accumulated locally per
    // thread, merged once at thread exit under a mutex.
    std::mutex countsMu;
    std::unordered_map<uint32_t, uint64_t> sharedCounts;
    uint64_t sharedSplits = 0;

    // ---- Fragment queue to store parts of split log objects and Stitcher thread
    // ----
    FragmentQueue fragQ;
    std::thread stitcher(
        runStitcher, self, std::ref(fragQ), std::ref(countsMu), std::ref(sharedCounts), std::ref(sharedSplits));

    // ---- Start consumers ----
    std::vector<std::thread> consumers;
    consumers.reserve(nWorkers);
    for (size_t i = 0; i < nWorkers; ++i) {
        consumers.emplace_back(runConsumer, self, std::ref(queue), std::ref(fragQ), std::ref(atomicContainers),
            std::ref(atomicCompressed), std::ref(atomicDecompressed), std::ref(countsMu), std::ref(sharedCounts),
            std::ref(sharedSplits));
    }

    // ---- Producer (runs on calling thread, concurrent with consumers) ----
    // MADV_WILLNEED (set in MappedFile::open) has been pre-loading pages since
    // mmap returned, so many of these touches will hit the page cache.
    runProducer(self, cursor, queue);

    queue.close(); // this tells consumers that no more items will be pushed
    for (auto& w : consumers) {
        w.join();
    }

    // All consumers have exited; no more fragments will be pushed.
    fragQ.close();
    stitcher.join();

    self->perf.containers = atomicContainers.load();
    self->perf.compressedBytes = atomicCompressed.load();
    self->perf.decompressedBytes = atomicDecompressed.load();
    self->perf.objectCounts = std::move(sharedCounts);
    self->perf.splitObjects = sharedSplits;
    self->perf.nThreads = nWorkers;
}

// ---------------------------------------------------------------------------
// Lazy-Loading Index & Decode
// ---------------------------------------------------------------------------

struct ContainerCount {
    uint64_t containerIndex;
    size_t fileOffset;
    uint32_t countInContainer;
    std::vector<char> headFrag;
    std::vector<char> tailFrag;
};

static void runIndexConsumer(
    Analyzer* self, WorkQueue& queue, std::mutex& countsMu, std::vector<ContainerCount>& containerCounts)
{
    auto decomp = std::unique_ptr<libdeflate_decompressor, decltype(&libdeflate_free_decompressor)>(
        libdeflate_alloc_decompressor(), libdeflate_free_decompressor);
    if (!decomp) {
        return;
    }
    std::vector<char> localBuf;

    while (auto item = queue.pop()) {
        if (self->skipDecompress) {
            continue;
        }

        const size_t needed = item->compSize * DECOMP_BUFFER_PREALLOC_RATIO;
        if (localBuf.size() < needed) {
            localBuf.resize(needed);
        }

        size_t actualOut = 0;
        libdeflate_result res;
        do {
            res = libdeflate_zlib_decompress(
                decomp.get(), item->compData, item->compSize, localBuf.data(), localBuf.size(), &actualOut);
            if (res == LIBDEFLATE_INSUFFICIENT_SPACE) {
                localBuf.resize(localBuf.size() * 2);
            }
        } while (res == LIBDEFLATE_INSUFFICIENT_SPACE);

        if (res == LIBDEFLATE_SUCCESS) {
            std::unordered_map<uint32_t, uint64_t> localCounts;
            uint64_t localSplits = 0;
            std::vector<char> headFrag, tailFrag;

            processInnerObjects(self, localBuf.data(), actualOut, localCounts, localSplits, &headFrag, &tailFrag);

            uint32_t countInContainer = 0;
            for (const auto& [type, cnt] : localCounts) {
                if (type != LOG_CONTAINER) {
                    countInContainer += cnt;
                }
            }

            // Push even if 0, to track offsets correctly
            std::lock_guard<std::mutex> lk(countsMu);
            containerCounts.push_back(
                { item->containerIndex, item->fileOffset, countInContainer, std::move(headFrag), std::move(tailFrag) });
        }
    }
}

static void stitchFragments(Analyzer* analyzer, std::vector<ContainerCount>& containerCounts)
{
    for (size_t i = 0; i + 1 < containerCounts.size(); ++i) {
        auto& tail = containerCounts[i].tailFrag;
        auto& head = containerCounts[i + 1].headFrag;
        if (!tail.empty() && !head.empty()) {
            std::vector<char> stitched;
            stitched.reserve(tail.size() + head.size());
            stitched.insert(stitched.end(), tail.begin(), tail.end());
            stitched.insert(stitched.end(), head.begin(), head.end());

            std::unordered_map<uint32_t, uint64_t> sCounts;
            uint64_t sSplits = 0;
            processInnerObjects(analyzer, stitched.data(), stitched.size(), sCounts, sSplits, nullptr, nullptr);

            uint32_t sCount = 0;
            for (const auto& [type, cnt] : sCounts) {
                if (type != LOG_CONTAINER) {
                    sCount += cnt;
                }
            }
            // Add the stitched count to the container that originated the object (the tail)
            containerCounts[i].countInContainer += sCount;
        }
        // Free memory early
        tail.clear();
        head.clear();
    }
}

static size_t computeChunkIndexes(
    std::vector<ChunkEntry>& chunkIndex, const std::vector<ContainerCount>& containerCounts)
{
    chunkIndex.clear();
    size_t cumulativeMessages = 0;
    size_t nextChunkBoundary = 0;

    for (const auto& cc : containerCounts) {
        if (cumulativeMessages + cc.countInContainer > nextChunkBoundary) {
            uint32_t skipMessages = nextChunkBoundary - cumulativeMessages;
            chunkIndex.push_back({ cc.fileOffset, cc.containerIndex, skipMessages });
            nextChunkBoundary += Analyzer::CHUNK_SIZE;

            // It's possible one container has >10k messages, so loop to add all
            // boundaries in it
            while (cumulativeMessages + cc.countInContainer > nextChunkBoundary) {
                skipMessages = nextChunkBoundary - cumulativeMessages;
                chunkIndex.push_back({ cc.fileOffset, cc.containerIndex, skipMessages });
                nextChunkBoundary += Analyzer::CHUNK_SIZE;
            }
        }
        cumulativeMessages += cc.countInContainer;
    }
    return cumulativeMessages;
}

struct HistogramBounds {
    uint64_t startUs = 0;
    uint64_t endUs = 0;
};

static HistogramBounds computeHistogramBounds(const Analyzer* analyzer)
{
    HistogramBounds bounds;
    const auto& chunkIndex = analyzer->getChunkIndex();

    if (!chunkIndex.empty()) {
        bool foundStart = false;
        for (size_t i = 0; i < chunkIndex.size(); ++i) {
            auto chunk = analyzer->decodeChunk(i);
            for (const auto& msg : chunk) {
                if (protocolGroupOf(msg.objectType) != ProtocolGroup::COUNT) {
                    bounds.startUs = msg.timestampUs;
                    foundStart = true;
                    break;
                }
            }
            if (foundStart) {
                break;
            }
        }

        bool foundEnd = false;
        for (size_t i = chunkIndex.size(); i > 0; --i) {
            auto chunk = analyzer->decodeChunk(i - 1);
            for (auto it = chunk.rbegin(); it != chunk.rend(); ++it) {
                if (protocolGroupOf(it->objectType) != ProtocolGroup::COUNT) {
                    bounds.endUs = it->timestampUs;
                    foundEnd = true;
                    break;
                }
            }
            if (foundEnd) {
                break;
            }
        }
    }
    return bounds;
}

size_t Analyzer::buildIndex(const std::string& filename)
{
    using Clock = std::chrono::steady_clock;

    if (!mf_.open(filename)) {
        return 0;
    }
    spdlog::info("Building index for: {} ({:.2f} MiB)", filename, mf_.size / (1024.0 * 1024.0));

    totalBytes.store(mf_.size, std::memory_order_relaxed);
    bytesRead.store(0, std::memory_order_relaxed);

    Cursor cursor = mf_.cursor();
    auto fileHeader = readFileHeader(cursor);
    if (!fileHeader) {
        return 0;
    }

    const size_t nWorkers = (std::max<size_t>)(1, std::thread::hardware_concurrency());
    WorkQueue queue(nWorkers * 4);

    std::mutex countsMu;
    std::vector<ContainerCount> containerCounts;

    std::vector<std::thread> consumers;
    for (size_t i = 0; i < nWorkers; ++i) {
        consumers.emplace_back(runIndexConsumer, this, std::ref(queue), std::ref(countsMu), std::ref(containerCounts));
    }

    auto t0 = Clock::now();
    runProducer(this, cursor, queue);
    queue.close();
    for (auto& w : consumers) {
        w.join();
    }

    std::sort(containerCounts.begin(), containerCounts.end(),
        [](const ContainerCount& a, const ContainerCount& b) { return a.containerIndex < b.containerIndex; });

    stitchFragments(this, containerCounts);
    totalMessages_ = computeChunkIndexes(chunkIndex_, containerCounts);

    auto bounds = computeHistogramBounds(this);
    histogram_.traceStartUs = bounds.startUs;
    histogram_.traceEndUs = bounds.endUs;

    auto t1 = Clock::now();
    spdlog::info("buildIndex done: scanned {} containers, {} messages, {} index chunks in {:.2f} ms",
        static_cast<uint64_t>(containerCounts.size()), static_cast<uint64_t>(totalMessages_),
        static_cast<uint64_t>(chunkIndex_.size()), std::chrono::duration<double, std::milli>(t1 - t0).count());

    return totalMessages_;
}

void Analyzer::buildHistogram(int numBins)
{
    histogramChunksProcessed.store(0, std::memory_order_relaxed);

    if (numBins <= 0 || chunkIndex_.empty() || histogram_.traceEndUs <= histogram_.traceStartUs) {
        return;
    }

    uint64_t durationUs = histogram_.traceEndUs - histogram_.traceStartUs;
    histogram_.binWidthUs = durationUs / numBins;
    if (histogram_.binWidthUs == 0) {
        histogram_.binWidthUs = 1; // Prevent div by 0
    }

    // The total bins could be slightly more than numBins due to integer division truncation
    size_t actualBins = durationUs / histogram_.binWidthUs + 1;

    for (auto& vec : histogram_.bins) {
        vec.assign(actualBins, 0);
    }

    for (size_t i = 0; i < chunkIndex_.size(); ++i) {
        if (histogramCancelled.load(std::memory_order_relaxed)) {
            break;
        }
        auto msgs = decodeChunk(i);
        for (const auto& msg : msgs) {
            ProtocolGroup group = protocolGroupOf(msg.objectType);
            if (group != ProtocolGroup::COUNT) {
                uint64_t clampedTs = (std::max)(msg.timestampUs, histogram_.traceStartUs);
                size_t binIndex = (clampedTs - histogram_.traceStartUs) / histogram_.binWidthUs;
                if (binIndex < actualBins) {
                    histogram_.bins[static_cast<size_t>(group)][binIndex]++;
                }
            }
        }
        histogramChunksProcessed.fetch_add(1, std::memory_order_relaxed);
    }
}

std::vector<TraceMessage> Analyzer::decodeChunk(size_t chunkIndex) const
{
    std::vector<TraceMessage> out;
    if (chunkIndex >= chunkIndex_.size() || mf_.size == 0) {
        return out;
    }

    const auto& entry = chunkIndex_[chunkIndex];
    size_t messagesToSkip = entry.skipMessages;
    size_t messagesCollected = 0;

    // We expect the LOBJ of the container to be at entry.fileOffset.
    Cursor cursor = mf_.cursor();
    if (!cursor.skip(entry.fileOffset)) {
        return out;
    }

    auto decomp = std::unique_ptr<libdeflate_decompressor, decltype(&libdeflate_free_decompressor)>(
        libdeflate_alloc_decompressor(), libdeflate_free_decompressor);
    std::vector<char> localBuf;

    // A helper Analyzer instance to trick processInnerObjects into not storing in
    // its own vector Wait, processInnerObjects takes Analyzer* and appends to
    // self->messages. That uses a mutex and is not suitable for const decodeChunk
    // which returns its own vector. Let's implement a small standalone loop or
    // just copy processInnerObjects behavior. To avoid duplication, I will create
    // a temporary Analyzer.
    Analyzer tempAnalyzer;
    tempAnalyzer.collectMessages = true;
    tempAnalyzer.maxMessages = CHUNK_SIZE;

    BlfObjectHeaderBase base;
    std::vector<char> headFrag, tailFrag;

    while (messagesCollected < CHUNK_SIZE && !cursor.eof()) {
        if (!findNextLobj(cursor, base.signature)) {
            break;
        }
        if (!cursor.read(reinterpret_cast<char*>(&base) + 4, sizeof(BlfObjectHeaderBase) - 4)) {
            break;
        }

        if (LOG_CONTAINER == base.objectType) {
            BlfObjectHeader extHdr;
            if (!cursor.read(reinterpret_cast<char*>(&extHdr), sizeof(BlfObjectHeaderBase))) {
                break;
            }

            const size_t compSize = base.objectSize - base.headerSize - sizeof(BlfObjectHeader);
            const char* compData = cursor.peek(compSize);
            if (!compData) {
                break;
            }

            const size_t needed = compSize * DECOMP_BUFFER_PREALLOC_RATIO;
            if (localBuf.size() < needed) {
                localBuf.resize(needed);
            }

            size_t actualOut = 0;
            libdeflate_result res;
            do {
                res = libdeflate_zlib_decompress(
                    decomp.get(), compData, compSize, localBuf.data(), localBuf.size(), &actualOut);
                if (res == LIBDEFLATE_INSUFFICIENT_SPACE) {
                    localBuf.resize(localBuf.size() * 2);
                }
            } while (res == LIBDEFLATE_INSUFFICIENT_SPACE);

            if (res == LIBDEFLATE_SUCCESS) {
                std::unordered_map<uint32_t, uint64_t> lCounts;
                uint64_t lSplits = 0;
                std::vector<char> nextTailFrag;

                // Assemble head with previous tail if any
                if (!tailFrag.empty()) {
                    // Extract head from current container
                    std::vector<char> currentHead;
                    Cursor headCur { localBuf.data(), localBuf.data() + actualOut, localBuf.data() };
                    BlfObjectHeaderBase hBase;
                    if (findNextLobj(headCur, hBase.signature)) {
                        const size_t firstLobjAt = headCur.tell() - 4;
                        if (firstLobjAt > 0) {
                            currentHead.assign(localBuf.data(), localBuf.data() + firstLobjAt);
                        }
                    } else {
                        currentHead.assign(localBuf.data(), localBuf.data() + actualOut);
                    }

                    if (!currentHead.empty()) {
                        std::vector<char> stitched;
                        stitched.reserve(tailFrag.size() + currentHead.size());
                        stitched.insert(stitched.end(), tailFrag.begin(), tailFrag.end());
                        stitched.insert(stitched.end(), currentHead.begin(), currentHead.end());

                        processInnerObjects(
                            &tempAnalyzer, stitched.data(), stitched.size(), lCounts, lSplits, nullptr, nullptr);
                    }
                    tailFrag.clear();
                }

                processInnerObjects(
                    &tempAnalyzer, localBuf.data(), actualOut, lCounts, lSplits, &headFrag, &nextTailFrag);
                tailFrag = std::move(nextTailFrag);
            }
        } else {
            const size_t remaining = base.objectSize - sizeof(BlfObjectHeaderBase);
            cursor.skip(remaining);
        }

        // Move messages from tempAnalyzer, apply skip, take up to CHUNK_SIZE
        if (!tempAnalyzer.messages.empty()) {
            size_t i = 0;
            if (messagesToSkip > 0) {
                if (messagesToSkip >= tempAnalyzer.messages.size()) {
                    messagesToSkip -= tempAnalyzer.messages.size();
                    i = tempAnalyzer.messages.size();
                } else {
                    i = messagesToSkip;
                    messagesToSkip = 0;
                }
            }

            for (; i < tempAnalyzer.messages.size() && messagesCollected < CHUNK_SIZE; ++i) {
                out.push_back(std::move(tempAnalyzer.messages[i]));
                messagesCollected++;
            }
            tempAnalyzer.messages.clear();
            tempAnalyzer.messagesCollected.store(0);
        }
    }

    return out;
}

// ---------------------------------------------------------------------------
// loadDatabase / clearDatabase / buildSignalTimeSeries
// ---------------------------------------------------------------------------

void Analyzer::loadDatabase(const std::string& path)
{
    dbLoadProgress.store(0.0f, std::memory_order_relaxed);
    m_arDatabase_ = ArxmlParser::parseFiles({ path });
    m_arDatabase_.buildIndex();
    dbLoadProgress.store(1.0f, std::memory_order_relaxed);
}

void Analyzer::clearDatabase() { m_arDatabase_ = ArDatabase {}; }

void Analyzer::buildSignalTimeSeries(const std::string& iSignalName, int numBins, std::vector<SignalBin>& out)
{
    if (numBins <= 0 || chunkIndex_.empty()) {
        return;
    }

    // Locate signal in arDatabase
    ArMessage sigMsg;
    ArSignal sigDef;
    bool found = false;
    for (const auto& msg : m_arDatabase_.messages) {
        for (const auto& sig : msg.signalDefs) {
            if (sig.name == iSignalName) {
                sigMsg = msg;
                sigDef = sig;
                found = true;
                break;
            }
        }
        if (found) {
            break;
        }
    }

    if (!found) {
        return;
    }

    const uint64_t traceStart = histogram_.traceStartUs;
    const uint64_t traceEnd = histogram_.traceEndUs;
    if (traceEnd <= traceStart) {
        return;
    }

    const uint64_t duration = traceEnd - traceStart;
    const uint64_t binWidth = duration / static_cast<uint64_t>(numBins);
    if (binWidth == 0) {
        return;
    }

    out.resize(numBins);
    for (int i = 0; i < numBins; ++i) {
        out[i] = SignalBin {};
        out[i].timestampUs = traceStart + static_cast<uint64_t>(i) * binWidth + binWidth / 2;
    }

    histogramChunksProcessed.store(0, std::memory_order_relaxed);

    for (size_t ci = 0; ci < chunkIndex_.size(); ++ci) {
        if (histogramCancelled.load(std::memory_order_relaxed)) {
            break;
        }
        auto msgs = decodeChunk(ci);
        for (const auto& msg : msgs) {
            bool match = false;
            size_t pduOffset = 0;
            if (sigMsg.busType == ArBusType::CAN) {
                match = (msg.arbId == sigMsg.canId);
            } else if (sigMsg.busType == ArBusType::ETHERNET) {
                if (msg.dstIp == sigMsg.dstIp && (sigMsg.dstPort == 0 || msg.dstPort == sigMsg.dstPort)) {
                    auto it = msg.pdus.find(sigMsg.pduId);
                    if (it != msg.pdus.end()) {
                        match = true;
                        pduOffset = it->second.offset;
                    }
                }
            }

            if (match) {
                uint64_t raw = extractSignalRaw(msg.data.data() + pduOffset, msg.data.size() - pduOffset,
                    sigDef.startBit, sigDef.bitLength, sigDef.isBigEndian);
                uint64_t clampedTs = (std::max)(msg.timestampUs, traceStart);
                size_t binIdx = (clampedTs - traceStart) / binWidth;
                if (binIdx < static_cast<size_t>(numBins)) {
                    auto& bin = out[binIdx];
                    if (!bin.hasData) {
                        bin.minRaw = raw;
                        bin.maxRaw = raw;
                        bin.hasData = true;
                    } else {
                        bin.minRaw = (std::min)(bin.minRaw, raw);
                        bin.maxRaw = (std::max)(bin.maxRaw, raw);
                    }
                }
            }
        }
        histogramChunksProcessed.fetch_add(1, std::memory_order_relaxed);
    }
}

// ---------------------------------------------------------------------------
// buildSignalTimeSeriesRange – range-bounded signal histogram
// ---------------------------------------------------------------------------
void Analyzer::buildSignalTimeSeriesRange(
    const std::string& iSignalName, int numBins, std::vector<SignalBin>& out, uint64_t startUs, uint64_t endUs)
{
    if (numBins <= 0 || chunkIndex_.empty()) {
        return;
    }

    // Locate signal in arDatabase
    ArMessage sigMsg;
    ArSignal sigDef;
    bool found = false;
    for (const auto& msg : m_arDatabase_.messages) {
        for (const auto& sig : msg.signalDefs) {
            if (sig.name == iSignalName) {
                sigMsg = msg;
                sigDef = sig;
                found = true;
                break;
            }
        }
        if (found) {
            break;
        }
    }

    if (!found) {
        return;
    }

    // Clamp requested range to actual trace bounds
    const uint64_t traceStart = histogram_.traceStartUs;
    const uint64_t traceEnd = histogram_.traceEndUs;
    if (traceEnd <= traceStart) {
        return;
    }

    const uint64_t rangeStart = (startUs < traceStart) ? traceStart : startUs;
    const uint64_t rangeEnd = (endUs == 0 || endUs > traceEnd) ? traceEnd : endUs;
    if (rangeEnd <= rangeStart) {
        return;
    }

    const uint64_t duration = rangeEnd - rangeStart;
    const uint64_t binWidth = duration / static_cast<uint64_t>(numBins);
    if (binWidth == 0) {
        return;
    }

    out.resize(numBins);
    for (int i = 0; i < numBins; ++i) {
        out[i] = SignalBin {};
        out[i].timestampUs = rangeStart + static_cast<uint64_t>(i) * binWidth + binWidth / 2;
    }

    histogramChunksProcessed.store(0, std::memory_order_relaxed);

    for (size_t ci = 0; ci < chunkIndex_.size(); ++ci) {
        if (histogramCancelled.load(std::memory_order_relaxed)) {
            break;
        }
        auto msgs = decodeChunk(ci);
        for (const auto& msg : msgs) {
            if (msg.timestampUs < rangeStart || msg.timestampUs >= rangeEnd) {
                continue;
            }

            bool match = false;
            size_t pduOffset = 0;
            if (sigMsg.busType == ArBusType::CAN) {
                match = (msg.arbId == sigMsg.canId);
            } else if (sigMsg.busType == ArBusType::ETHERNET) {
                if (msg.dstIp == sigMsg.dstIp && (sigMsg.dstPort == 0 || msg.dstPort == sigMsg.dstPort)) {
                    auto it = msg.pdus.find(sigMsg.pduId);
                    if (it != msg.pdus.end()) {
                        match = true;
                        pduOffset = it->second.offset;
                    }
                }
            }

            if (match) {
                uint64_t raw = extractSignalRaw(msg.data.data() + pduOffset, msg.data.size() - pduOffset,
                    sigDef.startBit, sigDef.bitLength, sigDef.isBigEndian);
                size_t binIdx = (msg.timestampUs - rangeStart) / binWidth;
                if (binIdx < static_cast<size_t>(numBins)) {
                    auto& bin = out[binIdx];
                    if (!bin.hasData) {
                        bin.minRaw = raw;
                        bin.maxRaw = raw;
                        bin.hasData = true;
                    } else {
                        bin.minRaw = (std::min)(bin.minRaw, raw);
                        bin.maxRaw = (std::max)(bin.maxRaw, raw);
                    }
                }
            }
        }
        histogramChunksProcessed.fetch_add(1, std::memory_order_relaxed);
    }
}

// ---------------------------------------------------------------------------
// processFile – top-level orchestrator
// ---------------------------------------------------------------------------
void Analyzer::processFile(const std::string& filename)
{
    using Clock = std::chrono::steady_clock;

    MappedFile mf;
    if (!mf.open(filename)) {
        return;
    }
    spdlog::info("Processing file: {} ({:.2f} MiB)", filename, mf.size / (1024.0 * 1024.0));

    // expose file size for UI progress bar before the pipeline starts
    totalBytes.store(mf.size, std::memory_order_relaxed);
    bytesRead.store(0, std::memory_order_relaxed);

    Cursor cursor = mf.cursor();
    auto fileHeader = readFileHeader(cursor);
    if (!fileHeader) {
        return;
    }

    const size_t nWorkers = (std::max<size_t>)(1, std::thread::hardware_concurrency());
    spdlog::info("Starting pipeline: {} worker thread(s)", nWorkers);

    auto t0 = Clock::now();
    runPipeline(this, cursor, *fileHeader, nWorkers);
    this->perf.pipelineUs = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - t0).count();

    if (collectMessages && !messages.empty()) {
        std::sort(messages.begin(), messages.end(),
            [](const TraceMessage& a, const TraceMessage& b) { return a.timestampUs < b.timestampUs; });
    }
}

void Analyzer::reset()
{
    chunkIndex_.clear();
    histogram_ = HistogramData {};
    totalMessages_ = 0;

    {
        std::lock_guard<std::mutex> lk(messagesMu);
        messages.clear();
    }

    perf = PerfCounters {};

    cancelled.store(false, std::memory_order_relaxed);
    histogramCancelled.store(false, std::memory_order_relaxed);
    histogramChunksProcessed.store(0, std::memory_order_relaxed);
    bytesRead.store(0, std::memory_order_relaxed);
    totalBytes.store(0, std::memory_order_relaxed);
    messagesCollected.store(0, std::memory_order_relaxed);
    dbLoadProgress.store(0.0f, std::memory_order_relaxed);
    dbLoadCancelled.store(false, std::memory_order_relaxed);
}

} // namespace fastrace
