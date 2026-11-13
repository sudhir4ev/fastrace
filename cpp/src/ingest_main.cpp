#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

#include <spdlog/spdlog.h>

#include "ArxmlParser.h"
#include "BlfIngestReader.h"
#include "BlfTypes.h"
#include "DuckDbCli.h"
#include "ProtocolParser.h"
#include "SignalDecoder.h" // indexEthernetPdus (PDU indexing for peel)

namespace {

struct Options {
    std::string blf;
    std::string out;
    std::string arxml;
    std::string duckdb;
    size_t batchRows = 10000;
    bool messagesOnly = false;
    bool yes = false;
    bool keepStage = false;
};

void usage(const char* argv0)
{
    spdlog::error("Usage: {} --blf <path> --out <path.duckdb> [--arxml path] [--batch-rows N] "
                  "[--messages-only] [--duckdb path] [--keep-stage] [--yes]",
        argv0);
}

bool parseArgs(int argc, char** argv, Options& opt)
{
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto need = [&](const char* name) -> const char* {
            if (i + 1 >= argc) {
                spdlog::error("missing value for {}", name);
                return nullptr;
            }
            return argv[++i];
        };
        if (a == "--blf") {
            const char* v = need("--blf");
            if (!v) {
                return false;
            }
            opt.blf = v;
        } else if (a == "--out") {
            const char* v = need("--out");
            if (!v) {
                return false;
            }
            opt.out = v;
        } else if (a == "--arxml") {
            const char* v = need("--arxml");
            if (!v) {
                return false;
            }
            opt.arxml = v;
        } else if (a == "--duckdb") {
            const char* v = need("--duckdb");
            if (!v) {
                return false;
            }
            opt.duckdb = v;
        } else if (a == "--batch-rows") {
            const char* v = need("--batch-rows");
            if (!v) {
                return false;
            }
            opt.batchRows = static_cast<size_t>(std::strtoull(v, nullptr, 10));
            if (opt.batchRows == 0) {
                spdlog::error("--batch-rows must be > 0");
                return false;
            }
        } else if (a == "--messages-only") {
            opt.messagesOnly = true;
        } else if (a == "--keep-stage") {
            opt.keepStage = true;
        } else if (a == "--yes" || a == "-y") {
            opt.yes = true;
        } else if (a == "-h" || a == "--help") {
            usage(argv[0]);
            return false;
        } else {
            spdlog::error("unknown arg: {}", a);
            return false;
        }
    }
    if (opt.blf.empty() || opt.out.empty()) {
        usage(argv[0]);
        return false;
    }
    return true;
}

void printPlanSummary(const Options& opt, const fastrace::DuckDbCli& cli)
{
    std::error_code sizeEc;
    const auto blfBytes = std::filesystem::file_size(opt.blf, sizeEc);
    std::error_code existsEc;
    const bool outExists = std::filesystem::exists(opt.out, existsEc);
    (void)existsEc;

    std::cout << "\n=== Ingest plan ===\n";
    std::cout << "  BLF input           : " << opt.blf;
    if (!sizeEc && blfBytes > 0) {
        std::cout << "  (" << (blfBytes / (1024.0 * 1024.0)) << " MiB)";
    }
    std::cout << '\n';
    std::cout << "  DuckDB output       : " << opt.out;
    if (outExists) {
        std::cout << "  (will overwrite)";
    }
    std::cout << '\n';
    std::cout << "  duckdb CLI          : " << cli.binary() << '\n';
    std::cout << "  ARXML               : " << (opt.arxml.empty() ? "(none)" : opt.arxml) << '\n';
    std::cout << "  Protocol peel       : " << (opt.messagesOnly ? "skip (--messages-only)" : "yes") << '\n';
    std::cout << "  Batch flush         : every " << opt.batchRows << " rows (CSV → COPY)\n";
    std::cout << "===================\n\n";
}

bool confirmProceed()
{
    std::cout << "Proceed with ingest? [y/N] " << std::flush;
    std::string line;
    if (!std::getline(std::cin, line)) {
        return false;
    }
    return !line.empty() && (line[0] == 'y' || line[0] == 'Y');
}

double usToMs(int64_t us) { return us * 1e-3; }
double usToSec(int64_t us) { return us * 1e-6; }

void printTimingLine(const char* name, int64_t us, int64_t wallUs)
{
    const double pct = wallUs > 0 ? (100.0 * static_cast<double>(us) / static_cast<double>(wallUs)) : 0.0;
    std::cout << "  " << std::left << std::setw(28) << name << std::right << std::setw(12) << std::fixed
              << std::setprecision(3) << usToMs(us) << " ms  (" << std::setw(5) << std::setprecision(1) << pct
              << "%)\n";
}

bool isEthernet(uint32_t objectType)
{
    return objectType == ETHERNET_FRAME || objectType == ETHERNET_FRAME_EX || objectType == ETHERNET_FRAME_FORWARDED;
}

std::string csvField(const std::string& s)
{
    bool quote = false;
    for (char c : s) {
        if (c == ',' || c == '"' || c == '\n' || c == '\r') {
            quote = true;
            break;
        }
    }
    if (!quote) {
        return s;
    }
    std::string out;
    out.push_back('"');
    for (char c : s) {
        if (c == '"') {
            out += "\"\"";
        } else {
            out.push_back(c);
        }
    }
    out.push_back('"');
    return out;
}

std::string csvField(bool v) { return v ? "true" : "false"; }

std::string copyCsvSql(const char* table, const std::filesystem::path& csv)
{
    return std::string("COPY ") + table + " FROM '" + csv.string()
        + "' (FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"');";
}

bool writeMeta(const fastrace::DuckDbCli& cli, const std::string& db, const std::string& key, const std::string& value,
    std::string& err)
{
    auto esc = [](const std::string& s) {
        std::string o;
        for (char c : s) {
            if (c == '\'') {
                o += "''";
            } else {
                o.push_back(c);
            }
        }
        return o;
    };
    const std::string sql = "INSERT INTO meta VALUES ('" + esc(key) + "', '" + esc(value)
        + "') ON CONFLICT (key) DO UPDATE SET value = excluded.value;";
    return cli.run(db, sql, &err);
}

void writeArxmlCsvs(const fastrace::ArDatabase& db, const std::filesystem::path& stageDir)
{
    {
        std::ofstream out(stageDir / "arxml_pdu.csv", std::ios::binary | std::ios::trunc);
        out << "pdu_id,name,dst_ip,dst_port\n";
        for (const auto& m : db.messages) {
            if (m.busType == fastrace::ArBusType::ETHERNET || m.pduId != 0) {
                out << m.pduId << ',' << csvField(m.name) << ',' << csvField(m.dstIp) << ',' << m.dstPort << '\n';
            }
        }
    }
    {
        std::ofstream out(stageDir / "arxml_can.csv", std::ios::binary | std::ios::trunc);
        out << "can_id,name,extended,dlc\n";
        for (const auto& m : db.messages) {
            if (m.busType == fastrace::ArBusType::CAN || m.canId != 0) {
                out << m.canId << ',' << csvField(m.name) << ',' << csvField(m.isExtended) << ',' << m.dlc << '\n';
            }
        }
    }
    {
        std::ofstream out(stageDir / "arxml_ecu.csv", std::ios::binary | std::ios::trunc);
        out << "name\n";
        for (const auto& e : db.ecus) {
            out << csvField(e.name) << '\n';
        }
    }
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

    fastrace::DuckDbCli cli(opt.duckdb);
    std::string err;
    if (!cli.available(&err)) {
        spdlog::error("{}", err);
        return 1;
    }

    printPlanSummary(opt, cli);
    if (!opt.yes && !confirmProceed()) {
        spdlog::info("Aborted.");
        return 0;
    }

    using Clock = std::chrono::steady_clock;
    const auto wall0 = Clock::now();

    int64_t openUs = 0;
    int64_t arxmlUs = 0;
    int64_t decodeUs = 0;
    int64_t csvUs = 0;
    int64_t copyUs = 0;
    int64_t stageWallUs = 0;
    uint64_t peeled = 0;
    size_t flushes = 0;
    bool flushFailed = false;

    const auto stageDir = std::filesystem::path(".tmp/fastrace_stage");
    {
        std::error_code ec;
        std::filesystem::remove_all(stageDir, ec);
        std::filesystem::create_directories(stageDir, ec);
        if (ec) {
            spdlog::error("cannot create stage dir {}: {}", stageDir.string(), ec.message());
            return 1;
        }
    }

    std::cout << "\n[1/2] Preparing DuckDB (overwrite) + schema...\n" << std::flush;
    {
        const auto t0 = Clock::now();
        std::error_code ec;
        const auto parent = std::filesystem::path(opt.out).parent_path();
        if (!parent.empty()) {
            std::filesystem::create_directories(parent, ec);
        }
        std::filesystem::remove(opt.out, ec);

        const auto schemaPath = fastrace::DuckDbCli::findSqlFile("schema.sql", argv[0]);
        if (schemaPath.empty()) {
            spdlog::error("schema.sql not found (set FASTRACE_ROOT or run from repo root)");
            return 1;
        }
        if (!cli.runFile(opt.out, schemaPath, &err)) {
            spdlog::error("schema: {}", err);
            return 1;
        }
        openUs = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - t0).count();
    }
    if (!writeMeta(cli, opt.out, "source_blf", opt.blf, err) || !writeMeta(cli, opt.out, "schema_version", "3", err)) {
        spdlog::error("{}", err);
        return 1;
    }
    std::cout << "      open+DDL: " << usToMs(openUs) << " ms\n";

    if (!opt.arxml.empty()) {
        std::cout << "\n[+] Parsing ARXML + staging arxml_*...\n" << std::flush;
        const auto t0 = Clock::now();
        fastrace::ArDatabase arDb = fastrace::ArxmlParser::parseFile(opt.arxml);
        if (arDb.empty()) {
            spdlog::warn("ARXML parse produced empty database: {}", opt.arxml);
        } else {
            writeArxmlCsvs(arDb, stageDir);
            if (!cli.run(opt.out, copyCsvSql("arxml_pdu", stageDir / "arxml_pdu.csv"), &err)
                || !cli.run(opt.out, copyCsvSql("arxml_can", stageDir / "arxml_can.csv"), &err)
                || !cli.run(opt.out, copyCsvSql("arxml_ecu", stageDir / "arxml_ecu.csv"), &err)) {
                spdlog::error("arxml COPY: {}", err);
                return 1;
            }
            if (!writeMeta(cli, opt.out, "source_arxml", opt.arxml, err)) {
                spdlog::error("{}", err);
                return 1;
            }
        }
        arxmlUs = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - t0).count();
        std::cout << "      arxml: " << usToMs(arxmlUs) << " ms  messages=" << arDb.messages.size() << '\n';
    }

    struct Batch {
        std::vector<fastrace::TraceMessage> msgs;
        std::vector<ProtocolMessage> proto;
        uint64_t startMsgId = 0;
    };

    Batch batch;
    batch.msgs.reserve(opt.batchRows);
    uint64_t nextMsgId = 0;
    ProtocolParser parser;

    auto flushBatch = [&]() -> bool {
        if (batch.msgs.empty()) {
            return true;
        }
        ++flushes;
        const uint64_t batchStart = batch.startMsgId;
        const size_t n = batch.msgs.size();
        std::cout << "      batch #" << flushes << " start  msg_id=[" << batchStart << "," << (batchStart + n)
                  << ")  rows=" << n << '\n'
                  << std::flush;

        const auto c0 = Clock::now();
        const auto msgCsv = stageDir / ("messages_" + std::to_string(flushes) + ".csv");
        const auto pduCsv = stageDir / ("protocol_pdu_" + std::to_string(flushes) + ".csv");
        const auto someipCsv = stageDir / ("protocol_someip_" + std::to_string(flushes) + ".csv");
        const auto sdCsv = stageDir / ("protocol_someip_sd_" + std::to_string(flushes) + ".csv");
        const auto doipCsv = stageDir / ("protocol_doip_" + std::to_string(flushes) + ".csv");

        {
            std::ofstream out(msgCsv, std::ios::binary | std::ios::trunc);
            out << "msg_id,timestamp_us,object_type,channel,arb_id,extended_id,dlc,dst_ip,dst_port,payload_len\n";
            uint64_t id = batchStart;
            for (const auto& m : batch.msgs) {
                out << id << ',' << m.timestampUs << ',' << m.objectType << ',' << m.channel << ',' << m.arbId << ','
                    << csvField(m.extendedId) << ',' << static_cast<int>(m.dlc) << ',' << csvField(m.dstIp) << ','
                    << m.dstPort << ',' << m.data.size() << '\n';
                ++id;
            }
        }

        bool wrotePdu = false;
        bool wroteSomeip = false;
        bool wroteSd = false;
        bool wroteDoip = false;
        if (!opt.messagesOnly && !batch.proto.empty()) {
            std::ofstream pdu(pduCsv, std::ios::binary | std::ios::trunc);
            std::ofstream someip(someipCsv, std::ios::binary | std::ios::trunc);
            std::ofstream sd(sdCsv, std::ios::binary | std::ios::trunc);
            std::ofstream doip(doipCsv, std::ios::binary | std::ios::trunc);
            pdu << "msg_id,pdu_id,length\n";
            someip << "msg_id,service_id,method_id,length,client_id,session_id,protocol_version,interface_version,"
                      "message_type,return_code\n";
            sd << "msg_id,flags\n";
            doip << "msg_id,protocol_version,inverse_version,payload_type,payload_length,source_address,"
                    "target_address\n";
            for (const auto& pm : batch.proto) {
                const int64_t msgId = pm.sourceIndices.empty() ? -1 : static_cast<int64_t>(pm.sourceIndices.front());
                switch (pm.type) {
                case ProtocolType::Pdu:
                    pdu << msgId << ',' << pm.data.pdu.id << ',' << pm.data.pdu.length << '\n';
                    wrotePdu = true;
                    break;
                case ProtocolType::SomeIp:
                    someip << msgId << ',' << pm.data.someIp.serviceId << ',' << pm.data.someIp.methodId << ','
                           << pm.data.someIp.length << ',' << pm.data.someIp.clientId << ',' << pm.data.someIp.sessionId
                           << ',' << static_cast<int>(pm.data.someIp.protocolVersion) << ','
                           << static_cast<int>(pm.data.someIp.interfaceVersion) << ','
                           << static_cast<int>(pm.data.someIp.messageType) << ','
                           << static_cast<int>(pm.data.someIp.returnCode) << '\n';
                    wroteSomeip = true;
                    break;
                case ProtocolType::SomeIpSd:
                    sd << msgId << ',' << static_cast<int>(pm.data.someIpSd.flags) << '\n';
                    wroteSd = true;
                    break;
                case ProtocolType::DoIp:
                    doip << msgId << ',' << static_cast<int>(pm.data.doip.protocolVersion) << ','
                         << static_cast<int>(pm.data.doip.inverseVersion) << ',' << pm.data.doip.payloadType << ','
                         << pm.data.doip.payloadLength << ',' << pm.data.doip.sourceAddress << ','
                         << pm.data.doip.targetAddress << '\n';
                    wroteDoip = true;
                    break;
                }
            }
        }
        csvUs += std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - c0).count();

        const auto k0 = Clock::now();
        if (!cli.run(opt.out, copyCsvSql("messages", msgCsv), &err)) {
            spdlog::error("COPY messages: {}", err);
            return false;
        }
        if (wrotePdu && !cli.run(opt.out, copyCsvSql("protocol_pdu", pduCsv), &err)) {
            spdlog::error("COPY protocol_pdu: {}", err);
            return false;
        }
        if (wroteSomeip && !cli.run(opt.out, copyCsvSql("protocol_someip", someipCsv), &err)) {
            spdlog::error("COPY protocol_someip: {}", err);
            return false;
        }
        if (wroteSd && !cli.run(opt.out, copyCsvSql("protocol_someip_sd", sdCsv), &err)) {
            spdlog::error("COPY protocol_someip_sd: {}", err);
            return false;
        }
        if (wroteDoip && !cli.run(opt.out, copyCsvSql("protocol_doip", doipCsv), &err)) {
            spdlog::error("COPY protocol_doip: {}", err);
            return false;
        }
        copyUs += std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - k0).count();

        if (!opt.keepStage) {
            std::error_code ec;
            std::filesystem::remove(msgCsv, ec);
            if (wrotePdu) {
                std::filesystem::remove(pduCsv, ec);
            }
            if (wroteSomeip) {
                std::filesystem::remove(someipCsv, ec);
            }
            if (wroteSd) {
                std::filesystem::remove(sdCsv, ec);
            }
            if (wroteDoip) {
                std::filesystem::remove(doipCsv, ec);
            }
        }

        std::cout << "      batch #" << flushes << " done   total_rows=" << (batchStart + n)
                  << "  protocol_rows=" << peeled << '\n'
                  << std::flush;

        batch.msgs.clear();
        batch.proto.clear();
        return true;
    };

    std::cout << "\n[2/2] One-pass BLF → peel → CSV → duckdb COPY...\n" << std::flush;
    const auto stage0 = Clock::now();
    fastrace::BlfIngestReader reader;
    const bool ok = reader.visit(opt.blf, [&](const fastrace::TraceMessage& msgIn) {
        if (flushFailed) {
            return;
        }
        if (batch.msgs.empty()) {
            batch.startMsgId = nextMsgId;
        }
        fastrace::TraceMessage msg = msgIn;
        const uint64_t msgId = nextMsgId;

        const auto d0 = Clock::now();
        if (!opt.messagesOnly) {
            if (isEthernet(msg.objectType) && !msg.data.empty()) {
                fastrace::indexEthernetPdus(msg);
            }
            auto protos = parser.parse(msg, static_cast<size_t>(msgId));
            peeled += protos.size();
            for (auto& pm : protos) {
                batch.proto.push_back(std::move(pm));
            }
        }
        decodeUs += std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - d0).count();

        batch.msgs.push_back(std::move(msg));
        ++nextMsgId;
        if (batch.msgs.size() >= opt.batchRows) {
            if (!flushBatch()) {
                flushFailed = true;
            }
        }
    });
    if (!ok || flushFailed) {
        return 1;
    }
    if (!flushBatch()) {
        return 1;
    }
    stageWallUs = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - stage0).count();

    const auto& st = reader.stats();
    writeMeta(cli, opt.out, "stage_a_containers", std::to_string(st.containers), err);
    writeMeta(cli, opt.out, "stage_a_messages", std::to_string(st.messages), err);
    writeMeta(cli, opt.out, "protocol_rows", std::to_string(peeled), err);
    writeMeta(cli, opt.out, "flushes", std::to_string(flushes), err);

    if (!opt.keepStage) {
        std::error_code ec;
        std::filesystem::remove_all(stageDir, ec);
    }

    const int64_t wallUs = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - wall0).count();
    writeMeta(cli, opt.out, "wall_ms", std::to_string(usToMs(wallUs)), err);

    std::cout << "\n=== Timing summary ===\n";
    printTimingLine("open DuckDB + DDL", openUs, wallUs);
    if (arxmlUs > 0) {
        printTimingLine("ARXML materialize", arxmlUs, wallUs);
    }
    printTimingLine("BLF inflate+decode", st.inflateDecodeUs, wallUs);
    printTimingLine("protocol peel", decodeUs, wallUs);
    printTimingLine("CSV write", csvUs, wallUs);
    printTimingLine("duckdb COPY", copyUs, wallUs);
    printTimingLine("ingest wall (total)", stageWallUs, wallUs);
    printTimingLine("WALL (end-to-end)", wallUs, wallUs);
    std::cout << "  output                      : " << opt.out << '\n';
    std::cout << "  messages                    : " << st.messages << '\n';
    if (!opt.messagesOnly) {
        std::cout << "  protocol rows               : " << peeled << '\n';
    }
    if (stageWallUs > 0) {
        std::cout << "  rate                        : " << static_cast<double>(st.messages) / usToSec(stageWallUs)
                  << " rows/s\n";
    }
    std::cout << "=======================\n";
    std::cout << "Anomaly SQL is on-demand (not installed). Example:\n";
    std::cout << "  duckdb " << opt.out << " -c \".read cpp/sql/anomaly_detectors.sql\"\n";
    if (!opt.arxml.empty()) {
        std::cout << "  duckdb " << opt.out << " -c \".read cpp/sql/signal_anomaly_detectors.sql\"\n";
    }
    std::cout << "Try:\n";
    std::cout << "  SELECT count(*) FROM messages;\n";
    std::cout << "  SELECT count(*) FROM protocol_pdu;\n";
    std::cout << "  SELECT detector_name, count(*) FROM detections GROUP BY ALL;\n";
    return 0;
}
