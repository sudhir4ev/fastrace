#pragma once
#include <cstdint>
#include <vector>

enum class ProtocolType { SomeIp, SomeIpSd, DoIp, Pdu };

struct SomeIpHeader {
    uint16_t serviceId;
    uint16_t methodId;
    uint32_t length;
    uint16_t clientId;
    uint16_t sessionId;
    uint8_t protocolVersion;
    uint8_t interfaceVersion;
    uint8_t messageType;
    uint8_t returnCode;
};

struct SomeIpSdMessage {
    uint8_t flags;
};

struct DoipHeader {
    uint8_t protocolVersion;
    uint8_t inverseVersion;
    uint16_t payloadType;
    uint32_t payloadLength;
    uint16_t sourceAddress;
    uint16_t targetAddress;
};

struct PduInfo {
    uint32_t id;
    size_t length;
};

struct ProtocolMessage {
    uint64_t timestampUs;
    std::vector<size_t> sourceIndices;
    ProtocolType type;

    union Data {
        SomeIpHeader someIp;
        SomeIpSdMessage someIpSd;
        DoipHeader doip;
        PduInfo pdu;
    } data;
};
