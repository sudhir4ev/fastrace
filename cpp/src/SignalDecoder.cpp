#include "SignalDecoder.h"
#include "BlfTypes.h"

namespace fastrace {

uint64_t extractSignalRaw(const uint8_t* data, size_t dataLen, uint32_t startBit, uint32_t bitLength, bool isBigEndian)
{
    if (bitLength == 0 || bitLength > 64) {
        return 0;
    }

    uint64_t rawValue = 0;

    if (!isBigEndian) {
        // Intel: startBit = LSB. Bits 0..bitLength-1 placed LSB-first.
        for (uint32_t i = 0; i < bitLength; ++i) {
            uint32_t bitPos = startBit + i;
            uint32_t byteIdx = bitPos / 8;
            uint32_t bitInByte = bitPos % 8;
            if (byteIdx < dataLen) {
                rawValue |= uint64_t((data[byteIdx] >> bitInByte) & 1u) << i;
            }
        }
    } else {
        // Motorola: startBit = MSB. i=0 is MSB → placed at bit (bitLength-1-i).
        uint32_t byteIdx = startBit / 8;
        uint32_t bitInByte = startBit % 8;
        for (uint32_t i = 0; i < bitLength; ++i) {
            if (byteIdx < dataLen) {
                rawValue |= uint64_t((data[byteIdx] >> bitInByte) & 1u) << (bitLength - 1u - i);
            }
            if (bitInByte == 0) {
                byteIdx += 1;
                bitInByte = 7;
            } else {
                bitInByte -= 1;
            }
        }
    }

    return rawValue;
}

void indexEthernetPdus(TraceMessage& tm)
{
    tm.pdus.clear();
    const auto* udpPayload = reinterpret_cast<const char*>(tm.data.data());
    const size_t udpPayloadLen = tm.data.size();
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

std::vector<DecodedSignal> decodeAllSignals(const ArDatabase& db, const TraceMessage& msg)
{
    std::vector<DecodedSignal> result;
    if (msg.objectType == ETHERNET_FRAME || msg.objectType == ETHERNET_FRAME_EX
        || msg.objectType == ETHERNET_FRAME_FORWARDED) {
        for (const auto& arMsg : db.messages) {
            if (arMsg.busType == ArBusType::ETHERNET && arMsg.dstIp == msg.dstIp
                && (arMsg.dstPort == 0 || arMsg.dstPort == msg.dstPort)) {
                auto it = msg.pdus.find(arMsg.pduId);
                if (it != msg.pdus.end()) {
                    size_t pduOffset = it->second.offset;
                    for (const auto& sig : arMsg.signalDefs) {
                        DecodedSignal ds;
                        ds.name = sig.name;
                        ds.bitLength = sig.bitLength;
                        ds.startBit = sig.startBit;
                        ds.isBigEndian = sig.isBigEndian;
                        ds.rawValue = extractSignalRaw(msg.data.data() + pduOffset, msg.data.size() - pduOffset,
                            sig.startBit, sig.bitLength, sig.isBigEndian);
                        result.push_back(std::move(ds));
                    }
                }
            }
        }
    } else {
        auto it = db.messageByCanId.find(msg.arbId);
        if (it != db.messageByCanId.end()) {
            const auto& arMsg = db.messages[it->second];
            result.reserve(arMsg.signalDefs.size());
            for (const auto& sig : arMsg.signalDefs) {
                DecodedSignal ds;
                ds.name = sig.name;
                ds.bitLength = sig.bitLength;
                ds.startBit = sig.startBit;
                ds.isBigEndian = sig.isBigEndian;
                ds.rawValue
                    = extractSignalRaw(msg.data.data(), msg.data.size(), sig.startBit, sig.bitLength, sig.isBigEndian);
                result.push_back(std::move(ds));
            }
        }
    }
    return result;
}

} // namespace fastrace
