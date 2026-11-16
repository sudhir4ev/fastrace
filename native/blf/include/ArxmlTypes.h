#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace fastrace {

struct ArSignal {
    std::string name;
    uint32_t startBit = 0;
    uint32_t bitLength = 0;
    bool isBigEndian = false;
};

enum class ArBusType { CAN, ETHERNET };

struct ArMessage {
    std::string name;
    uint32_t canId = 0;
    bool isExtended = false;
    uint32_t dlc = 0;
    std::string cluster;
    ArBusType busType = ArBusType::CAN;
    std::vector<ArSignal> signalDefs;

    // Ethernet specific fields
    uint32_t pduId = 0;
    std::string dstIp;
    uint16_t dstPort = 0;
};

struct ArSomeIpService {
    std::string name;
    uint16_t serviceId = 0;
};

struct ArEcu {
    std::string name;
};

struct ArDatabase {
    std::vector<ArMessage> messages;
    std::vector<ArEcu> ecus;
    std::vector<ArSomeIpService> someipServices;

    std::unordered_map<uint32_t, size_t> messageByCanId;

    void buildIndex()
    {
        messageByCanId.clear();
        for (size_t i = 0; i < messages.size(); ++i) {
            messageByCanId[messages[i].canId] = i;
        }
    }

    bool empty() const { return messages.empty() && ecus.empty() && someipServices.empty(); }
};

} // namespace fastrace
