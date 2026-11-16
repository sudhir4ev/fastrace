#include "Store.h"

#include "BlfTypes.h"

namespace fastrace {

bool isEthernet(uint32_t objectType)
{
    return objectType == ETHERNET_FRAME || objectType == ETHERNET_FRAME_EX || objectType == ETHERNET_FRAME_FORWARDED;
}

bool appendProto(const ProtocolMessage& pm, Appender& pdu, Appender& someip, Appender& sd, Appender& doip)
{
    const int64_t msgId = pm.sourceIndices.empty() ? -1 : static_cast<int64_t>(pm.sourceIndices.front());
    switch (pm.type) {
    case ProtocolType::Pdu:
        pdu.i64(msgId);
        pdu.i64(pm.data.pdu.id);
        pdu.i64(static_cast<int64_t>(pm.data.pdu.length));
        return pdu.endRow();
    case ProtocolType::SomeIp:
        someip.i64(msgId);
        someip.i64(pm.data.someIp.serviceId);
        someip.i64(pm.data.someIp.methodId);
        someip.i64(pm.data.someIp.length);
        someip.i64(pm.data.someIp.clientId);
        someip.i64(pm.data.someIp.sessionId);
        someip.i32(pm.data.someIp.protocolVersion);
        someip.i32(pm.data.someIp.interfaceVersion);
        someip.i32(pm.data.someIp.messageType);
        someip.i32(pm.data.someIp.returnCode);
        return someip.endRow();
    case ProtocolType::SomeIpSd:
        sd.i64(msgId);
        sd.i32(pm.data.someIpSd.flags);
        return sd.endRow();
    case ProtocolType::DoIp:
        doip.i64(msgId);
        doip.i32(pm.data.doip.protocolVersion);
        doip.i32(pm.data.doip.inverseVersion);
        doip.i64(pm.data.doip.payloadType);
        doip.i64(pm.data.doip.payloadLength);
        doip.i64(pm.data.doip.sourceAddress);
        doip.i64(pm.data.doip.targetAddress);
        return doip.endRow();
    }
    return true;
}

} // namespace fastrace
