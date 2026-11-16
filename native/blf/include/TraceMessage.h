#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace fastrace {

struct PduIndex {
    uint16_t offset = 0;
    uint16_t length = 0;
};

struct TraceMessage {
    uint64_t timestampUs = 0; // microseconds from trace start
    uint32_t objectType = 0; // BLFObjectType value
    uint16_t channel = 0; // 1-based channel index
    uint32_t arbId = 0; // decoded CAN arbitration ID; 0 for Ethernet
    bool extendedId = false;
    uint8_t dlc = 0; // CAN DLC code (0-15); 0 for Ethernet

    std::vector<uint8_t> data; // raw payload (CAN or Ethernet UDP payload)
    std::unordered_map<uint32_t, PduIndex> pdus; // Ethernet PDU indices
    std::string dstIp; // destination IP address string
    uint16_t dstPort = 0; // destination port
};

} // namespace fastrace
