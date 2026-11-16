#include "BlfIngestReader.h"

#include <libdeflate.h>
#include <spdlog/spdlog.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <format>
#include <memory>
#include <optional>
#include <string_view>
#include <vector>

#include "BlfTypes.h"
#include "Cursor.h"
#include "MappedFile.h"
#include "NetTypes.h"

namespace fastrace {
namespace {

constexpr size_t kDecompPreallocRatio = 6;
constexpr uint32_t kLobjSignature = 0x4a424f4c; // "LOBJ"

uint64_t tsToMicroseconds(uint64_t ts, uint32_t flags) noexcept
{
    if (flags & 0x2u) {
        return ts / 1000u;
    }
    if (flags & 0x1u) {
        return ts * 10u;
    }
    return ts / 10u;
}

std::string fmtIPv6(const uint8_t addr[16])
{
    return std::format("{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:"
                       "{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}:{:02x}{:02x}",
        addr[0], addr[1], addr[2], addr[3], addr[4], addr[5], addr[6], addr[7], addr[8], addr[9], addr[10],
        addr[11], addr[12], addr[13], addr[14], addr[15]);
}

bool extractUdpInfo(const char* frame, size_t frameLen, std::string& dstIpOut, uint16_t& dstPortOut,
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

bool findNextLobj(Cursor& cursor, uint32_t& sigOut)
{
    while (cursor.remaining() >= 4) {
#if defined(__x86_64__) || defined(_M_X64) || defined(_M_IX86)
        sigOut = *reinterpret_cast<const uint32_t*>(cursor.pos);
#else
        std::memcpy(&sigOut, cursor.pos, 4);
#endif
        if (kLobjSignature == sigOut) {
            cursor.pos += 4;
            return true;
        }
        cursor.pos += 1;
    }
    return false;
}

std::optional<BlfFileHeader> readFileHeader(Cursor& cursor)
{
    if (static_cast<size_t>(cursor.end - cursor.base) < sizeof(BlfFileHeader)) {
        return std::nullopt;
    }
    BlfFileHeader hdr;
    if (!cursor.read(&hdr, sizeof(BlfFileHeader))) {
        return std::nullopt;
    }
    if (std::string_view(hdr.signature, sizeof(hdr.signature)) != "LOGG") {
        return std::nullopt;
    }
    const size_t padSize = hdr.headerSize > sizeof(BlfFileHeader) ? hdr.headerSize - sizeof(BlfFileHeader) : 0;
    if (padSize > 0 && !cursor.skip(padSize)) {
        return std::nullopt;
    }
    return hdr;
}

void fillEthernetPdus(TraceMessage& tm, const char* udpPayload, size_t udpPayloadLen)
{
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
}

void decodeBuffer(const char* data, size_t dataLen, std::vector<TraceMessage>& outMessages, uint64_t& splitCount,
    std::vector<char>* headFragOut, std::vector<char>* tailFragOut)
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
            } else if (tailFragOut && loopStart < data + dataLen) {
                tailFragOut->assign(loopStart, data + dataLen);
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
                tailFragOut->assign(cur.pos - 4, data + dataLen);
            }
            break;
        }

        const size_t objectStart = cur.tell() - sizeof(BlfObjectHeaderBase);
        const size_t objectEnd = objectStart + base.objectSize;
        if (objectEnd > dataLen) {
            ++splitCount;
            if (tailFragOut) {
                tailFragOut->assign(data + objectStart, data + dataLen);
            }
            break;
        }

        uint64_t timestamp = 0;
        uint32_t objFlags = 0;
        const size_t extraHdrBytes
            = base.headerSize > sizeof(BlfObjectHeaderBase) ? base.headerSize - sizeof(BlfObjectHeaderBase) : 0;
        if (extraHdrBytes >= sizeof(BlfObjectHeader)) {
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
            if (!cur.skip(extraHdrBytes)) {
                break;
            }
        }

        const size_t payloadBytes = base.objectSize > base.headerSize ? base.objectSize - base.headerSize : 0;

        switch (static_cast<BLFObjectType>(base.objectType)) {
        case CAN_MESSAGE:
        case CAN_MESSAGE2: {
            if (payloadBytes < sizeof(CANMessage)) {
                cur.skip(payloadBytes);
                break;
            }
            CANMessage msg;
            cur.read(&msg, sizeof(CANMessage));
            const size_t surplus = payloadBytes - sizeof(CANMessage);
            if (surplus > 0) {
                cur.skip(surplus);
            }
            const uint32_t rawId = msg.id;
            const bool ext = (rawId >> 31) & 1u;
            TraceMessage tm;
            tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
            tm.objectType = base.objectType;
            tm.channel = msg.channel;
            tm.arbId = ext ? (rawId & 0x1FFFFFFFu) : (rawId & 0x7FFu);
            tm.extendedId = ext;
            tm.dlc = msg.dlc;
            const size_t dlen = (std::min)(msg.dlc, static_cast<uint8_t>(8));
            tm.data.assign(msg.data, msg.data + dlen);
            outMessages.push_back(std::move(tm));
            break;
        }
        case ETHERNET_FRAME_EX: {
            if (payloadBytes < sizeof(EthernetFrameHeader)) {
                cur.skip(payloadBytes);
                break;
            }
            EthernetFrameHeader eth;
            cur.read(&eth, sizeof(EthernetFrameHeader));
            const char* frameData = cur.pos;
            const size_t frameLen = payloadBytes - sizeof(EthernetFrameHeader);
            if (frameLen > 0) {
                cur.skip(frameLen);
            }
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
                fillEthernetPdus(tm, udpPayload, udpPayloadLen);
            } else {
                tm.data.assign(frameData, frameData + frameLen);
            }
            outMessages.push_back(std::move(tm));
            break;
        }
        case CAN_FD_MESSAGE: {
            if (payloadBytes < sizeof(CANFDMessage)) {
                cur.skip(payloadBytes);
                break;
            }
            CANFDMessage msg;
            cur.read(&msg, sizeof(CANFDMessage));
            const char* dataPtr = cur.pos;
            const size_t dataAvail = payloadBytes - sizeof(CANFDMessage);
            if (dataAvail > 0) {
                cur.skip(dataAvail);
            }
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
            outMessages.push_back(std::move(tm));
            break;
        }
        case CAN_FD_MESSAGE_64: {
            if (payloadBytes < sizeof(CANFDMessage64)) {
                cur.skip(payloadBytes);
                break;
            }
            CANFDMessage64 msg;
            cur.read(&msg, sizeof(CANFDMessage64));
            const char* dataPtr = cur.pos;
            const size_t dataAvail = payloadBytes - sizeof(CANFDMessage64);
            if (dataAvail > 0) {
                cur.skip(dataAvail);
            }
            const uint32_t rawId = msg.arbId;
            const bool ext = (rawId >> 31) & 1u;
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
            outMessages.push_back(std::move(tm));
            break;
        }
        case ETHERNET_FRAME_FORWARDED: {
            if (payloadBytes < sizeof(EthernetFrameExHeader)) {
                cur.skip(payloadBytes);
                break;
            }
            EthernetFrameExHeader eth;
            cur.read(&eth, sizeof(EthernetFrameExHeader));
            const char* frameData = cur.pos;
            const size_t frameLen = payloadBytes - sizeof(EthernetFrameExHeader);
            if (frameLen > 0) {
                cur.skip(frameLen);
            }
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
                fillEthernetPdus(tm, udpPayload, udpPayloadLen);
            } else {
                tm.data.assign(frameData, frameData + frameLen);
            }
            outMessages.push_back(std::move(tm));
            break;
        }
        case LOG_CONTAINER:
            cur.skip(payloadBytes);
            break;
        default: {
            if (payloadBytes > 0) {
                cur.skip(payloadBytes);
            }
            TraceMessage tm;
            tm.timestampUs = tsToMicroseconds(timestamp, objFlags);
            tm.objectType = base.objectType;
            outMessages.push_back(std::move(tm));
            break;
        }
        }
    }
}

bool inflateContainer(libdeflate_decompressor* decomp, const char* compData, size_t compSize, std::vector<char>& outBuf,
    size_t& outLen)
{
    size_t needed = compSize * kDecompPreallocRatio;
    if (outBuf.size() < needed) {
        outBuf.resize(needed);
    }
    libdeflate_result res;
    do {
        res = libdeflate_zlib_decompress(decomp, compData, compSize, outBuf.data(), outBuf.size(), &outLen);
        if (res == LIBDEFLATE_INSUFFICIENT_SPACE) {
            outBuf.resize(outBuf.size() * 2);
        }
    } while (res == LIBDEFLATE_INSUFFICIENT_SPACE);
    return res == LIBDEFLATE_SUCCESS;
}

} // namespace

bool BlfIngestReader::visit(const std::string& blfPath, MessageHandler onMessage)
{
    m_stats = Stats {};
    if (!onMessage) {
        spdlog::error("BlfIngestReader::visit: null handler");
        return false;
    }

    MappedFile mf;
    if (!mf.open(blfPath)) {
        spdlog::error("BlfIngestReader: failed to open {}", blfPath);
        return false;
    }

    Cursor cursor = mf.cursor();
    auto hdr = readFileHeader(cursor);
    if (!hdr) {
        spdlog::error("BlfIngestReader: invalid LOGG header");
        return false;
    }

    auto decomp = std::unique_ptr<libdeflate_decompressor, decltype(&libdeflate_free_decompressor)>(
        libdeflate_alloc_decompressor(), libdeflate_free_decompressor);
    if (!decomp) {
        spdlog::error("BlfIngestReader: libdeflate_alloc_decompressor failed");
        return false;
    }

    std::vector<char> decompBuf;
    std::vector<char> pendingTail;
    using Clock = std::chrono::steady_clock;
    int64_t inflateDecodeUs = 0;

    BlfObjectHeaderBase base;
    while (!cursor.eof()) {
        if (!findNextLobj(cursor, base.signature)) {
            break;
        }
        if (!cursor.read(reinterpret_cast<char*>(&base) + 4, sizeof(BlfObjectHeaderBase) - 4)) {
            break;
        }

        if (LOG_CONTAINER != base.objectType) {
            const size_t remaining = base.objectSize > sizeof(BlfObjectHeaderBase)
                ? base.objectSize - sizeof(BlfObjectHeaderBase)
                : 0;
            if (remaining > 0 && !cursor.skip(remaining)) {
                break;
            }
            continue;
        }

        BlfObjectHeader extHdr {};
        // Match Analyzer producer: read sizeof(BlfObjectHeaderBase) into ext header slot.
        if (!cursor.read(reinterpret_cast<char*>(&extHdr), sizeof(BlfObjectHeaderBase))) {
            break;
        }
        const size_t zlibSize = base.objectSize - base.headerSize - sizeof(BlfObjectHeader);
        const char* compData = cursor.peek(zlibSize);
        if (!compData) {
            break;
        }

        const auto tInflate0 = Clock::now();
        size_t outLen = 0;
        if (!inflateContainer(decomp.get(), compData, zlibSize, decompBuf, outLen)) {
            spdlog::error("BlfIngestReader: inflate failed at container {}", m_stats.containers);
            continue;
        }

        ++m_stats.containers;

        std::vector<TraceMessage> containerMsgs;
        std::vector<char> headFrag;
        std::vector<char> tailFrag;
        decodeBuffer(decompBuf.data(), outLen, containerMsgs, m_stats.splitObjects, &headFrag, &tailFrag);

        std::vector<TraceMessage> stitchedMsgs;
        if (!pendingTail.empty() && !headFrag.empty()) {
            std::vector<char> stitched;
            stitched.reserve(pendingTail.size() + headFrag.size());
            stitched.insert(stitched.end(), pendingTail.begin(), pendingTail.end());
            stitched.insert(stitched.end(), headFrag.begin(), headFrag.end());
            std::vector<char> unusedHead;
            std::vector<char> unusedTail;
            decodeBuffer(stitched.data(), stitched.size(), stitchedMsgs, m_stats.splitObjects, &unusedHead, &unusedTail);
        }
        inflateDecodeUs += std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - tInflate0).count();

        // Emit after timing so DuckDB flush in the handler is not counted here.
        for (const auto& m : stitchedMsgs) {
            onMessage(m);
            ++m_stats.messages;
        }
        for (const auto& m : containerMsgs) {
            onMessage(m);
            ++m_stats.messages;
        }
        pendingTail = std::move(tailFrag);
    }

    m_stats.inflateDecodeUs = inflateDecodeUs;
    spdlog::info("BlfIngestReader: containers={} messages={} splits={} inflate+decode={:.2f} ms", m_stats.containers,
        m_stats.messages, m_stats.splitObjects, m_stats.inflateDecodeUs * 1e-3);
    return true;
}

} // namespace fastrace
