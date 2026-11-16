#include "ProtocolParser.h"
#include "NetTypes.h"
#include <bit>

ProtocolParser::ProtocolParser(const fastrace::ArDatabase* db)
    : m_db(db)
{
}

void ProtocolParser::reset()
{
    m_tcpStreams.clear();
    m_detections.clear();
}

static inline uint16_t readBe16(const uint8_t* p) { return (uint16_t(p[0]) << 8) | p[1]; }

static inline uint32_t readBe32(const uint8_t* p)
{
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3];
}

std::vector<ProtocolMessage> ProtocolParser::parse(const fastrace::TraceMessage& tm, size_t globalMsgIndex)
{
    std::vector<ProtocolMessage> results;
    if (tm.data.empty()) {
        return results;
    }

    if (tm.dstPort == 13400 || (tm.data.size() >= 8 && tm.data[0] == 0x02 && tm.data[1] == 0xFD)) {
        StreamKey key { tm.dstIp, tm.dstPort };
        auto& stream = m_tcpStreams[key];
        stream.buffer.insert(stream.buffer.end(), tm.data.begin(), tm.data.end());

        while (stream.buffer.size() >= 8) {
            uint32_t payloadLen = readBe32(&stream.buffer[4]);
            size_t totalLen = 8 + payloadLen;
            if (stream.buffer.size() >= totalLen) {
                ProtocolMessage msg;
                msg.timestampUs = tm.timestampUs;
                msg.sourceIndices.push_back(globalMsgIndex);
                msg.type = ProtocolType::DoIp;
                msg.data.doip.protocolVersion = stream.buffer[0];
                msg.data.doip.inverseVersion = stream.buffer[1];
                msg.data.doip.payloadType = readBe16(&stream.buffer[2]);
                msg.data.doip.payloadLength = payloadLen;

                if (msg.data.doip.payloadType == 0x8001 && payloadLen >= 4) {
                    msg.data.doip.sourceAddress = readBe16(&stream.buffer[8]);
                    msg.data.doip.targetAddress = readBe16(&stream.buffer[10]);
                } else {
                    msg.data.doip.sourceAddress = 0;
                    msg.data.doip.targetAddress = 0;
                }

                results.push_back(msg);
                stream.buffer.erase(stream.buffer.begin(), stream.buffer.begin() + totalLen);
            } else {
                break;
            }
        }
    } else if (tm.data.size() >= 16) {
        uint16_t serviceId = readBe16(&tm.data[0]);
        uint16_t methodId = readBe16(&tm.data[2]);

        ProtocolMessage msg;
        msg.timestampUs = tm.timestampUs;
        msg.sourceIndices.push_back(globalMsgIndex);

        if (serviceId == 0xFFFF && methodId == 0x8100) {
            msg.type = ProtocolType::SomeIpSd;
            msg.data.someIpSd.flags = tm.data.size() > 16 ? tm.data[16] : 0;
        } else {
            msg.type = ProtocolType::SomeIp;
            msg.data.someIp.serviceId = serviceId;
            msg.data.someIp.methodId = methodId;
            msg.data.someIp.length = readBe32(&tm.data[4]);
            msg.data.someIp.clientId = readBe16(&tm.data[8]);
            msg.data.someIp.sessionId = readBe16(&tm.data[10]);
            msg.data.someIp.protocolVersion = tm.data[12];
            msg.data.someIp.interfaceVersion = tm.data[13];
            msg.data.someIp.messageType = tm.data[14];
            msg.data.someIp.returnCode = tm.data[15];
        }
        results.push_back(msg);
    }

    for (const auto& [pduId, pduIdx] : tm.pdus) {
        ProtocolMessage msg;
        msg.timestampUs = tm.timestampUs;
        msg.sourceIndices.push_back(globalMsgIndex);
        msg.type = ProtocolType::Pdu;
        msg.data.pdu.id = pduId;
        msg.data.pdu.length = pduIdx.length;
        results.push_back(msg);
    }

    return results;
}
