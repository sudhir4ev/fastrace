#include "SignalStatsTracker.h"

#include "BlfTypes.h"
#include "SignalDecoder.h"

namespace fastrace {
namespace {

    constexpr uint64_t kFnvOffset = 14695981039346656037ull;
    constexpr uint64_t kFnvPrime = 1099511628211ull;

    // Byte span covering the bits extractSignalRaw would read. Intel: contiguous
    // from startBit; Motorola: sequential bytes starting at startBit/8.
    void signalByteSpan(uint32_t startBit, uint32_t bitLength, bool isBigEndian, size_t dataLen, size_t& byteStart,
        size_t& byteEndExclusive)
    {
        byteStart = startBit / 8u;
        if (bitLength == 0 || byteStart >= dataLen) {
            byteEndExclusive = byteStart;
            return;
        }
        size_t nBytes = 0;
        if (!isBigEndian) {
            nBytes = (static_cast<size_t>(startBit % 8u) + bitLength + 7u) / 8u;
        } else {
            const uint32_t bitInByte = startBit % 8u;
            if (bitLength <= bitInByte + 1u) {
                nBytes = 1;
            } else {
                nBytes = 1u + (bitLength - bitInByte - 1u + 7u) / 8u;
            }
        }
        byteEndExclusive = byteStart + nBytes;
        if (byteEndExclusive > dataLen) {
            byteEndExclusive = dataLen;
        }
    }

    uint64_t hashByteSpan(const uint8_t* data, size_t byteStart, size_t byteEndExclusive)
    {
        uint64_t h = kFnvOffset;
        for (size_t i = byteStart; i < byteEndExclusive; ++i) {
            h ^= data[i];
            h *= kFnvPrime;
        }
        return h;
    }

    bool anyNonzeroByte(const uint8_t* data, size_t byteStart, size_t byteEndExclusive)
    {
        for (size_t i = byteStart; i < byteEndExclusive; ++i) {
            if (data[i] != 0) {
                return true;
            }
        }
        return false;
    }

    bool isEthernetObject(uint32_t objectType)
    {
        return objectType == ETHERNET_FRAME || objectType == ETHERNET_FRAME_EX
            || objectType == ETHERNET_FRAME_FORWARDED;
    }

} // namespace

SignalStatsTracker::SignalStatsTracker(const ArDatabase& db)
{
    int64_t nextSignalId = 0;
    for (const auto& m : db.messages) {
        const bool isCan = m.busType == ArBusType::CAN;
        std::vector<size_t> indices;
        indices.reserve(m.signalDefs.size());
        for (const auto& s : m.signalDefs) {
            SignalStatSlot slot;
            slot.signalId = nextSignalId++;
            slot.startBit = s.startBit;
            slot.bitLength = s.bitLength;
            slot.isBigEndian = s.isBigEndian;
            slot.opaque = s.bitLength > 64;
            indices.push_back(m_slots.size());
            m_slots.push_back(slot);
        }
        if (indices.empty()) {
            continue;
        }
        if (isCan) {
            m_byCanId[m.canId].insert(m_byCanId[m.canId].end(), indices.begin(), indices.end());
        } else {
            PduEntry entry;
            entry.dstIp = m.dstIp;
            entry.dstPort = m.dstPort;
            entry.slotIndices = std::move(indices);
            m_byPduId[m.pduId].push_back(std::move(entry));
        }
    }
}

void SignalStatsTracker::observeSlots(
    const std::vector<size_t>& indices, const uint8_t* data, size_t dataLen, int64_t timestampUs)
{
    for (size_t idx : indices) {
        SignalStatSlot& slot = m_slots[idx];
        uint64_t value = 0;
        bool isNonzero = false;

        if (slot.opaque) {
            size_t byteStart = 0;
            size_t byteEnd = 0;
            signalByteSpan(slot.startBit, slot.bitLength, slot.isBigEndian, dataLen, byteStart, byteEnd);
            value = hashByteSpan(data, byteStart, byteEnd);
            isNonzero = anyNonzeroByte(data, byteStart, byteEnd);
        } else {
            value = extractSignalRaw(data, dataLen, slot.startBit, slot.bitLength, slot.isBigEndian);
            isNonzero = value != 0;
        }

        if (slot.samples == 0) {
            slot.firstTsUs = timestampUs;
            if (!slot.opaque) {
                slot.minRaw = value;
                slot.maxRaw = value;
            }
        } else if (!slot.opaque) {
            if (value < slot.minRaw) {
                slot.minRaw = value;
            }
            if (value > slot.maxRaw) {
                slot.maxRaw = value;
            }
        }

        if (slot.hasPrev && value != slot.prevRaw) {
            ++slot.changes;
        }
        slot.prevRaw = value;
        slot.hasPrev = true;
        slot.lastTsUs = timestampUs;
        ++slot.samples;
        if (isNonzero) {
            ++slot.nonzero;
        }
    }
}

void SignalStatsTracker::observe(const TraceMessage& msg)
{
    const int64_t ts = static_cast<int64_t>(msg.timestampUs);
    if (isEthernetObject(msg.objectType)) {
        for (const auto& [pduId, pduIdx] : msg.pdus) {
            auto it = m_byPduId.find(pduId);
            if (it == m_byPduId.end()) {
                continue;
            }
            const size_t pduOffset = pduIdx.offset;
            if (pduOffset >= msg.data.size()) {
                continue;
            }
            const uint8_t* data = msg.data.data() + pduOffset;
            const size_t dataLen = msg.data.size() - pduOffset;
            for (const PduEntry& entry : it->second) {
                if (entry.dstIp != msg.dstIp) {
                    continue;
                }
                if (entry.dstPort != 0 && entry.dstPort != msg.dstPort) {
                    continue;
                }
                observeSlots(entry.slotIndices, data, dataLen, ts);
            }
        }
    } else {
        auto it = m_byCanId.find(msg.arbId);
        if (it == m_byCanId.end()) {
            return;
        }
        observeSlots(it->second, msg.data.data(), msg.data.size(), ts);
    }
}

} // namespace fastrace
