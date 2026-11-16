#pragma once

#include <cstdint>
#include <string>

#include <duckdb.h>

#include "ProtocolMessage.h"

namespace fastrace {

/// Thin wrapper around a DuckDB connection: open, exec DDL, upsert meta rows.
class Db {
public:
    ~Db();

    bool open(const std::string& path);
    bool exec(const std::string& sql);
    bool meta(const std::string& key, const std::string& value);

    duckdb_connection con() const { return m_con; }

private:
    duckdb_database m_db = nullptr;
    duckdb_connection m_con = nullptr;
};

/// Thin wrapper around a DuckDB Appender for one table.
class Appender {
public:
    Appender(duckdb_connection con, const char* table);
    ~Appender();

    bool valid() const { return m_app != nullptr; }
    void i64(int64_t v);
    void i32(int32_t v);
    void b(bool v);
    void str(const std::string& s);

    bool endRow();
    bool close();

private:
    const char* m_table;
    duckdb_appender m_app = nullptr;
};

/// Loads an ARXML-derived ArDatabase into arxml_pdu/arxml_can/arxml_ecu.
bool loadArxml(Db& db, const std::string& path);

/// Appends one peeled ProtocolMessage into the matching protocol_* table.
/// Known gap: uses pm.sourceIndices.front() for msg_id. Today ProtocolParser
/// always emits exactly one source index per message; if multi-frame TCP
/// reassembly is added later, this needs to become a loop writing one row
/// per source index.
bool appendProto(const ProtocolMessage& pm, Appender& pdu, Appender& someip, Appender& sd, Appender& doip);

/// True for all three BLF Ethernet object types (CAN_MESSAGE etc. excluded).
bool isEthernet(uint32_t objectType);

} // namespace fastrace
