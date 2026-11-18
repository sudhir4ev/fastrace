#pragma once

#include "ArxmlTypes.h"
#include "TraceMessage.h"

#include <cstdint>
#include <unordered_map>
#include <vector>

namespace fastrace {

/// Running per-signal summary for Prepare. Assigns signal_id in the same order
/// as loadArxml (messages in order, then signalDefs in order). Indexed by canId
/// and pduId so observe() is O(signals on the matching parent), not O(all ARXML).
struct SignalStatSlot {
    int64_t signalId = 0;
    uint32_t startBit = 0;
    uint32_t bitLength = 0;
    bool isBigEndian = false;
    bool opaque = false; // bitLength > 64

    int64_t samples = 0;
    int64_t nonzero = 0;
    int64_t changes = 0;
    uint64_t minRaw = 0;
    uint64_t maxRaw = 0;
    int64_t firstTsUs = 0;
    int64_t lastTsUs = 0;

    bool hasPrev = false;
    uint64_t prevRaw = 0; // scalar raw, or FNV-1a hash for opaque
};

class SignalStatsTracker {
public:
    explicit SignalStatsTracker(const ArDatabase& db);

    void observe(const TraceMessage& msg);

    const std::vector<SignalStatSlot>& slots() const { return m_slots; }

private:
    void observeSlots(const std::vector<size_t>& indices, const uint8_t* data, size_t dataLen, int64_t timestampUs);

    std::vector<SignalStatSlot> m_slots;
    std::unordered_map<uint32_t, std::vector<size_t>> m_byCanId;
    // One entry per ARXML Ethernet message that owns these slots; dstIp/dstPort
    // are checked at observe time the same way decodeAllSignals does.
    struct PduEntry {
        std::string dstIp;
        uint16_t dstPort = 0;
        std::vector<size_t> slotIndices;
    };
    std::unordered_map<uint32_t, std::vector<PduEntry>> m_byPduId;
};

} // namespace fastrace
