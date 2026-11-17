#include "Store.h"

#include <spdlog/spdlog.h>

#include "ArxmlParser.h"

namespace fastrace {

bool loadArxml(Db& db, const std::string& path)
{
    const ArDatabase arDb = ArxmlParser::parseFile(path);
    if (arDb.empty()) {
        spdlog::warn("ARXML parse produced empty database: {}", path);
        return true;
    }
    Appender pdu(db.con(), "arxml_pdu");
    Appender can(db.con(), "arxml_can");
    Appender ecu(db.con(), "arxml_ecu");
    if (!pdu.valid() || !can.valid() || !ecu.valid()) {
        return false;
    }
    for (const auto& m : arDb.messages) {
        if (m.busType == ArBusType::ETHERNET || m.pduId != 0) {
            pdu.i64(m.pduId);
            pdu.str(m.name);
            pdu.str(m.dstIp);
            pdu.i32(m.dstPort);
            if (!pdu.endRow()) {
                return false;
            }
        }
        if (m.busType == ArBusType::CAN || m.canId != 0) {
            can.i64(m.canId);
            can.str(m.name);
            can.b(m.isExtended);
            can.i32(static_cast<int32_t>(m.dlc));
            if (!can.endRow()) {
                return false;
            }
        }
    }
    for (const auto& e : arDb.ecus) {
        ecu.str(e.name);
        if (!ecu.endRow()) {
            return false;
        }
    }
    return pdu.close() && can.close() && ecu.close() && db.meta("source_arxml", path);
}

} // namespace fastrace
