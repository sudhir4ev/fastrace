#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>

#include "BlfIngestReader.h"
#include "ProtocolParser.h"
#include "SchemaEmbed.h"
#include "SignalDecoder.h"
#include "Store.h"

namespace {

using Clock = std::chrono::steady_clock;

void removeOutputs(const std::filesystem::path& outPath)
{
    std::error_code ec;
    std::filesystem::remove(outPath, ec);
    std::filesystem::remove(outPath.string() + ".wal", ec);
}

// Hand-rolled: 3-4 fixed numeric fields don't need a JSON library.
void printProgress(uint64_t containers, uint64_t messages, int64_t elapsedMs)
{
    std::printf("{\"containers\":%llu,\"messages\":%llu,\"elapsed_ms\":%lld}\n",
        static_cast<unsigned long long>(containers), static_cast<unsigned long long>(messages),
        static_cast<long long>(elapsedMs));
    std::fflush(stdout);
}

void printDone(uint64_t containers, uint64_t messages, uint64_t protocolRows, int64_t elapsedMs)
{
    std::printf(
        "{\"done\":true,\"containers\":%llu,\"messages\":%llu,\"protocol_rows\":%llu,\"elapsed_ms\":%lld}\n",
        static_cast<unsigned long long>(containers), static_cast<unsigned long long>(messages),
        static_cast<unsigned long long>(protocolRows), static_cast<long long>(elapsedMs));
    std::fflush(stdout);
}

void printError(const std::string& message)
{
    std::fprintf(stderr, "{\"error\":\"%s\"}\n", message.c_str());
    std::fflush(stderr);
}

bool appendProtocolRows(const std::vector<ProtocolMessage>& protos, fastrace::Appender& pdu,
    fastrace::Appender& someip, fastrace::Appender& sd, fastrace::Appender& doip)
{
    for (const auto& pm : protos) {
        if (!fastrace::appendProto(pm, pdu, someip, sd, doip)) {
            return false;
        }
    }
    return true;
}

int runPrepare(int argc, char** argv)
{
    if (argc < 3) {
        printError("usage: fastrace_parse prepare <trace.blf> [<trace.arxml>]");
        return 1;
    }
    const std::string blfPath = argv[2];
    const std::string arxmlPath = argc >= 4 ? argv[3] : std::string();
    const std::filesystem::path outPath = std::filesystem::path(blfPath).replace_extension(".duckdb");

    if (!std::filesystem::exists(blfPath)) {
        printError("BLF not found: " + blfPath);
        return 1;
    }

    const auto wall0 = Clock::now();
    removeOutputs(outPath);

    fastrace::Db db;
    bool failed = !db.open(outPath.string()) || !db.exec(fastrace::kSchemaSql)
        || !db.meta("source_blf", blfPath) || !db.meta("schema_version", fastrace::kSchemaVersion)
        || !db.meta("stage_format", "libduckdb_appender");

    if (!failed && !arxmlPath.empty()) {
        failed = !fastrace::loadArxml(db, arxmlPath);
    }

    uint64_t peeled = 0;
    uint64_t finalContainers = 0;
    uint64_t finalMessages = 0;
    if (!failed) {
        fastrace::Appender msgApp(db.con(), "messages");
        fastrace::Appender pduApp(db.con(), "protocol_pdu");
        fastrace::Appender someipApp(db.con(), "protocol_someip");
        fastrace::Appender sdApp(db.con(), "protocol_someip_sd");
        fastrace::Appender doipApp(db.con(), "protocol_doip");
        failed = !msgApp.valid() || !pduApp.valid() || !someipApp.valid() || !sdApp.valid() || !doipApp.valid();

        uint64_t nextMsgId = 0;
        auto lastProgress = Clock::now();
        constexpr uint64_t kProgressEveryMessages = 10000;
        constexpr auto kProgressEveryMs = std::chrono::milliseconds(250);

        ProtocolParser parser;
        fastrace::BlfIngestReader reader;
        const bool ok = reader.visit(blfPath, [&](const fastrace::TraceMessage& msgIn) {
            if (failed) {
                return;
            }
            fastrace::TraceMessage msg = msgIn;
            const uint64_t msgId = nextMsgId++;

            std::vector<ProtocolMessage> protos;
            if (fastrace::isEthernet(msg.objectType) && !msg.data.empty()) {
                fastrace::indexEthernetPdus(msg);
            }
            protos = parser.parse(msg, static_cast<size_t>(msgId));
            peeled += protos.size();

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
            if (!msgApp.endRow() || !appendProtocolRows(protos, pduApp, someipApp, sdApp, doipApp)) {
                failed = true;
                return;
            }

            const auto now = Clock::now();
            if (nextMsgId % kProgressEveryMessages == 0 || now - lastProgress >= kProgressEveryMs) {
                printProgress(reader.stats().containers, nextMsgId,
                    std::chrono::duration_cast<std::chrono::milliseconds>(now - wall0).count());
                lastProgress = now;
            }
        });

        failed = failed || !ok;
        failed = !msgApp.close() || !pduApp.close() || !someipApp.close() || !sdApp.close() || !doipApp.close()
            || failed;

        if (!failed) {
            finalContainers = reader.stats().containers;
            finalMessages = reader.stats().messages;
            db.meta("stage_a_containers", std::to_string(finalContainers));
            db.meta("stage_a_messages", std::to_string(finalMessages));
            db.meta("protocol_rows", std::to_string(peeled));
        }
    }

    const int64_t elapsedMs
        = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - wall0).count();

    if (failed) {
        removeOutputs(outPath);
        printError("prepare failed: " + blfPath);
        return 1;
    }

    db.meta("wall_ms", std::to_string(elapsedMs));
    printDone(finalContainers, finalMessages, peeled, elapsedMs);
    return 0;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <prepare|decode-signals> [args...]\n", argv[0]);
        return 1;
    }
    if (std::strcmp(argv[1], "prepare") == 0) {
        return runPrepare(argc, argv);
    }
    if (std::strcmp(argv[1], "decode-signals") == 0) {
        std::fprintf(stderr, "fastrace_parse decode-signals: not implemented yet (see docs/adr/0005)\n");
        return 1;
    }
    std::fprintf(stderr, "unknown subcommand: %s\n", argv[1]);
    return 1;
}
