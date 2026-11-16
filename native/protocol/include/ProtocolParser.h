#pragma once
#include "ArxmlTypes.h"
#include "Detection.h"
#include "ProtocolMessage.h"
#include "TraceMessage.h"
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

struct StreamKey {
    std::string dstIp;
    uint16_t dstPort;
    bool operator==(const StreamKey& other) const { return dstIp == other.dstIp && dstPort == other.dstPort; }
};

namespace std {
template <> struct hash<StreamKey> {
    size_t operator()(const StreamKey& k) const { return hash<string>()(k.dstIp) ^ hash<uint16_t>()(k.dstPort); }
};
}

class ProtocolParser {
public:
    explicit ProtocolParser(const fastrace::ArDatabase* db = nullptr);

    std::vector<ProtocolMessage> parse(const fastrace::TraceMessage& tm, size_t globalMsgIndex);

    void reset();

    std::vector<Detection> takeDetections() { return std::move(m_detections); }

private:
    const fastrace::ArDatabase* m_db;
    std::vector<Detection> m_detections;

    struct TcpStream {
        std::vector<uint8_t> buffer;
    };

    std::unordered_map<StreamKey, TcpStream> m_tcpStreams;
};
