// Experimental: in-process DuckDB (prebuilt libduckdb) + Appender ingest.
// Perf comparison against the CSV/CLI path in ingest_main.cpp; not the project baseline.

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

#include <duckdb.h>
#include <spdlog/spdlog.h>

#include "ArxmlParser.h"
#include "BlfIngestReader.h"
#include "BlfTypes.h"
#include "DuckDbCli.h"
#include "ProtocolParser.h"
#include "SignalDecoder.h"

namespace {

using Clock = std::chrono::steady_clock;

struct Options {
    std::string blf;
    std::string out;
    std::string arxml;
    bool messagesOnly = false;
};

bool parseArgs(int argc, char** argv, Options& opt)
{
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> const char* { return (i + 1 < argc) ? argv[++i] : nullptr; };
        const char* v = nullptr;
        if (a == "--blf" && (v = next())) {
            opt.blf = v;
        } else if (a == "--out" && (v = next())) {
            opt.out = v;
        } else if (a == "--arxml" && (v = next())) {
            opt.arxml = v;
        } else if (a == "--messages-only") {
            opt.messagesOnly = true;
        } else {
            spdlog::error("Usage: {} --blf <path> --out <path.duckdb> [--arxml path] [--messages-only]", argv[0]);
            return false;
        }
    }
    if (opt.blf.empty() || opt.out.empty()) {
        spdlog::error("Usage: {} --blf <path> --out <path.duckdb> [--arxml path] [--messages-only]", argv[0]);
        return false;
    }
    return true;
}

int64_t usSince(Clock::time_point t0)
{
    return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - t0).count();
}

void printTimingLine(const char* name, int64_t us, int64_t wallUs)
{
    const double pct = wallUs > 0 ? (100.0 * static_cast<double>(us) / static_cast<double>(wallUs)) : 0.0;
    std::cout << "  " << std::left << std::setw(28) << name << std::right << std::setw(12) << std::fixed
              << std::setprecision(3) << us * 1e-3 << " ms  (" << std::setw(5) << std::setprecision(1) << pct
              << "%)\n";
}

bool isEthernet(uint32_t objectType)
{
    return objectType == ETHERNET_FRAME || objectType == ETHERNET_FRAME_EX || objectType == ETHERNET_FRAME_FORWARDED;
}

class Db {
public:
    ~Db()
    {
        if (m_con) {
            duckdb_disconnect(&m_con);
        }
        if (m_db) {
            duckdb_close(&m_db);
        }
    }

    bool open(const std::string& path)
    {
        if (duckdb_open(path.c_str(), &m_db) == DuckDBError) {
            spdlog::error("duckdb_open failed: {}", path);
            return false;
        }
        if (duckdb_connect(m_db, &m_con) == DuckDBError) {
            spdlog::error("duckdb_connect failed");
            return false;
        }
        return true;
    }

    bool exec(const std::string& sql)
    {
        duckdb_result res;
        const bool ok = duckdb_query(m_con, sql.c_str(), &res) == DuckDBSuccess;
        if (!ok) {
            spdlog::error("duckdb_query: {}", duckdb_result_error(&res));
        }
        duckdb_destroy_result(&res);
        return ok;
    }

    bool meta(const std::string& key, const std::string& value)
    {
        std::string v;
        for (char c : value) {
            v += (c == '\'') ? std::string("''") : std::string(1, c);
        }
        return exec("INSERT INTO meta VALUES ('" + key + "', '" + v
            + "') ON CONFLICT (key) DO UPDATE SET value = excluded.value;");
    }

    duckdb_connection con() const { return m_con; }

private:
    duckdb_database m_db = nullptr;
    duckdb_connection m_con = nullptr;
};

class Appender {
public:
    Appender(duckdb_connection con, const char* table)
        : m_table(table)
    {
        if (duckdb_appender_create(con, nullptr, table, &m_app) == DuckDBError) {
            spdlog::error("appender_create {} failed", table);
            m_app = nullptr;
        }
    }
    ~Appender() { close(); }

    bool valid() const { return m_app != nullptr; }
    void i64(int64_t v) { duckdb_append_int64(m_app, v); }
    void i32(int32_t v) { duckdb_append_int32(m_app, v); }
    void b(bool v) { duckdb_append_bool(m_app, v); }
    void str(const std::string& s) { duckdb_append_varchar_length(m_app, s.data(), s.size()); }

    bool endRow()
    {
        if (duckdb_appender_end_row(m_app) == DuckDBError) {
            spdlog::error("appender {}: {}", m_table, duckdb_appender_error(m_app));
            return false;
        }
        return true;
    }

    bool close()
    {
        if (!m_app) {
            return true;
        }
        const bool ok = duckdb_appender_close(m_app) == DuckDBSuccess;
        if (!ok) {
            spdlog::error("appender {} close: {}", m_table, duckdb_appender_error(m_app));
        }
        duckdb_appender_destroy(&m_app);
        m_app = nullptr;
        return ok;
    }

private:
    const char* m_table;
    duckdb_appender m_app = nullptr;
};

bool loadArxml(Db& db, const std::string& path)
{
    const fastrace::ArDatabase arDb = fastrace::ArxmlParser::parseFile(path);
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
        if (m.busType == fastrace::ArBusType::ETHERNET || m.pduId != 0) {
            pdu.i64(m.pduId);
            pdu.str(m.name);
            pdu.str(m.dstIp);
            pdu.i32(m.dstPort);
            if (!pdu.endRow()) {
                return false;
            }
        }
        if (m.busType == fastrace::ArBusType::CAN || m.canId != 0) {
            can.i64(m.canId);
            can.str(m.name);
            can.b(m.isExtended);
            can.i32(m.dlc);
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

bool appendProto(const ProtocolMessage& pm, Appender& pdu, Appender& someip, Appender& sd, Appender& doip)
{
    const int64_t msgId = pm.sourceIndices.empty() ? -1 : static_cast<int64_t>(pm.sourceIndices.front());
    switch (pm.type) {
    case ProtocolType::Pdu:
        pdu.i64(msgId);
        pdu.i64(pm.data.pdu.id);
        pdu.i64(pm.data.pdu.length);
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

} // namespace

int main(int argc, char** argv)
{
    spdlog::set_level(spdlog::level::info);
    Options opt;
    if (!parseArgs(argc, argv, opt)) {
        return 1;
    }
    if (!std::filesystem::exists(opt.blf)) {
        spdlog::error("BLF not found: {}", opt.blf);
        return 1;
    }

    const auto wall0 = Clock::now();

    std::error_code ec;
    std::filesystem::remove(opt.out, ec);
    std::filesystem::remove(opt.out + ".wal", ec);

    const auto t0 = Clock::now();
    Db db;
    if (!db.open(opt.out)) {
        return 1;
    }
    const auto schemaPath = fastrace::DuckDbCli::findSqlFile("schema.sql", argv[0]);
    if (schemaPath.empty()) {
        spdlog::error("schema.sql not found (set FASTRACE_ROOT or run from repo root)");
        return 1;
    }
    std::stringstream schemaSql;
    schemaSql << std::ifstream(schemaPath).rdbuf();
    if (!db.exec(schemaSql.str()) || !db.meta("source_blf", opt.blf) || !db.meta("schema_version", "3")
        || !db.meta("stage_format", "libduckdb_appender")) {
        return 1;
    }
    const int64_t openUs = usSince(t0);

    int64_t arxmlUs = 0;
    if (!opt.arxml.empty()) {
        const auto a0 = Clock::now();
        if (!loadArxml(db, opt.arxml)) {
            return 1;
        }
        arxmlUs = usSince(a0);
    }

    Appender msgApp(db.con(), "messages");
    Appender pduApp(db.con(), "protocol_pdu");
    Appender someipApp(db.con(), "protocol_someip");
    Appender sdApp(db.con(), "protocol_someip_sd");
    Appender doipApp(db.con(), "protocol_doip");
    if (!msgApp.valid() || !pduApp.valid() || !someipApp.valid() || !sdApp.valid() || !doipApp.valid()) {
        return 1;
    }

    int64_t peelUs = 0;
    int64_t appendUs = 0;
    uint64_t nextMsgId = 0;
    uint64_t peeled = 0;
    bool failed = false;
    ProtocolParser parser;

    const auto stage0 = Clock::now();
    fastrace::BlfIngestReader reader;
    const bool ok = reader.visit(opt.blf, [&](const fastrace::TraceMessage& msgIn) {
        if (failed) {
            return;
        }
        fastrace::TraceMessage msg = msgIn;
        const uint64_t msgId = nextMsgId++;

        const auto d0 = Clock::now();
        std::vector<ProtocolMessage> protos;
        if (!opt.messagesOnly) {
            if (isEthernet(msg.objectType) && !msg.data.empty()) {
                fastrace::indexEthernetPdus(msg);
            }
            protos = parser.parse(msg, static_cast<size_t>(msgId));
            peeled += protos.size();
        }
        peelUs += usSince(d0);

        const auto k0 = Clock::now();
        msgApp.i64(static_cast<int64_t>(msgId));
        msgApp.i64(static_cast<int64_t>(msg.timestampUs));
        msgApp.i32(static_cast<int32_t>(msg.objectType));
        msgApp.i32(static_cast<int32_t>(msg.channel));
        msgApp.i32(static_cast<int32_t>(msg.arbId));
        msgApp.b(msg.extendedId);
        msgApp.i32(static_cast<int32_t>(msg.dlc));
        msgApp.str(msg.dstIp);
        msgApp.i32(msg.dstPort);
        msgApp.i32(static_cast<int32_t>(msg.data.size()));
        if (!msgApp.endRow()) {
            failed = true;
            return;
        }
        for (const auto& pm : protos) {
            if (!appendProto(pm, pduApp, someipApp, sdApp, doipApp)) {
                failed = true;
                return;
            }
        }
        appendUs += usSince(k0);
    });
    if (!ok || failed) {
        return 1;
    }

    const auto f0 = Clock::now();
    if (!msgApp.close() || !pduApp.close() || !someipApp.close() || !sdApp.close() || !doipApp.close()) {
        return 1;
    }
    const int64_t finalFlushUs = usSince(f0);
    const int64_t stageWallUs = usSince(stage0);

    const auto& st = reader.stats();
    db.meta("stage_a_containers", std::to_string(st.containers));
    db.meta("stage_a_messages", std::to_string(st.messages));
    db.meta("protocol_rows", std::to_string(peeled));
    const int64_t wallUs = usSince(wall0);
    db.meta("wall_ms", std::to_string(wallUs * 1e-3));

    std::cout << "\n=== Timing summary (libduckdb appender) ===\n";
    printTimingLine("open DuckDB + DDL", openUs, wallUs);
    if (arxmlUs > 0) {
        printTimingLine("ARXML materialize", arxmlUs, wallUs);
    }
    printTimingLine("BLF inflate+decode", st.inflateDecodeUs, wallUs);
    printTimingLine("protocol peel", peelUs, wallUs);
    printTimingLine("appender append", appendUs, wallUs);
    printTimingLine("appender final flush", finalFlushUs, wallUs);
    printTimingLine("ingest wall (total)", stageWallUs, wallUs);
    printTimingLine("WALL (end-to-end)", wallUs, wallUs);
    std::cout << "  messages                    : " << st.messages << '\n';
    std::cout << "  protocol rows               : " << peeled << '\n';
    std::cout << "  rate                        : " << static_cast<double>(st.messages) / (stageWallUs * 1e-6)
              << " rows/s\n";
    return 0;
}
