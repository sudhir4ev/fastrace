#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "ArxmlParser.h"
#include "BlfIngestReader.h"
#include "ProtocolParser.h"
#include "SchemaEmbed.h"
#include "SignalDecoder.h"
#include "SignalStatsTracker.h"
#include "Store.h"

namespace {

using Clock = std::chrono::steady_clock;

void removeOutputs(const std::filesystem::path& outPath)
{
    std::error_code ec;
    std::filesystem::remove(outPath, ec);
    std::filesystem::remove(outPath.string() + ".wal", ec);
}

// Hand-rolled: a handful of fixed numeric fields don't need a JSON library.
void printProgress(uint64_t containers, uint64_t messages, uint64_t bytesRead, uint64_t bytesTotal, int64_t elapsedMs)
{
    std::printf(
        "{\"containers\":%llu,\"messages\":%llu,\"bytes_read\":%llu,\"bytes_total\":%llu,\"elapsed_ms\":%lld}\n",
        static_cast<unsigned long long>(containers), static_cast<unsigned long long>(messages),
        static_cast<unsigned long long>(bytesRead), static_cast<unsigned long long>(bytesTotal),
        static_cast<long long>(elapsedMs));
    std::fflush(stdout);
}

void printDone(uint64_t containers, uint64_t messages, uint64_t protocolRows, uint64_t bytesRead, uint64_t bytesTotal,
    int64_t elapsedMs)
{
    std::printf("{\"done\":true,\"containers\":%llu,\"messages\":%llu,\"protocol_rows\":%llu,"
                "\"bytes_read\":%llu,\"bytes_total\":%llu,\"elapsed_ms\":%lld}\n",
        static_cast<unsigned long long>(containers), static_cast<unsigned long long>(messages),
        static_cast<unsigned long long>(protocolRows), static_cast<unsigned long long>(bytesRead),
        static_cast<unsigned long long>(bytesTotal), static_cast<long long>(elapsedMs));
    std::fflush(stdout);
}

void printError(const std::string& message)
{
    std::fprintf(stderr, "{\"error\":\"%s\"}\n", message.c_str());
    std::fflush(stderr);
}

bool appendProtocolRows(const std::vector<ProtocolMessage>& protos, fastrace::Appender& pdu, fastrace::Appender& someip,
    fastrace::Appender& sd, fastrace::Appender& doip)
{
    for (const auto& pm : protos) {
        if (!fastrace::appendProto(pm, pdu, someip, sd, doip)) {
            return false;
        }
    }
    return true;
}

bool queryMetaString(duckdb_connection con, const std::string& key, std::string& out)
{
    const std::string sql = "SELECT value FROM meta WHERE key = '" + key + "'";
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess || duckdb_row_count(&res) == 0) {
        duckdb_destroy_result(&res);
        return false;
    }
    char* s = duckdb_value_varchar(&res, 0, 0);
    out = s ? s : "";
    duckdb_free(s);
    duckdb_destroy_result(&res);
    return true;
}

// Reads a single integer scalar. Returns false when the row set is empty or the
// value is NULL (e.g. an aggregate over no rows), leaving `out` untouched.
bool queryOptInt64(duckdb_connection con, const std::string& sql, int64_t& out)
{
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        duckdb_destroy_result(&res);
        return false;
    }
    const bool ok = duckdb_row_count(&res) > 0 && !duckdb_value_is_null(&res, 0, 0);
    if (ok) {
        out = duckdb_value_int64(&res, 0, 0);
    }
    duckdb_destroy_result(&res);
    return ok;
}

struct RequestedSignal {
    int64_t signalId = 0;
    std::string parentKind;
    int64_t parentId = 0;
    std::string name;
    double factor = 1.0;
    double offset = 0.0;
};

// Looks up the requested signal_ids in arxml_signal. Returns false only on a query
// error; a requested id simply absent from the result set is the caller's job to notice
// by comparing sizes (a stale/unknown id from the UI, not a store problem).
bool queryRequestedSignals(duckdb_connection con, const std::vector<int64_t>& ids, std::vector<RequestedSignal>& out)
{
    std::string idList;
    for (size_t i = 0; i < ids.size(); ++i) {
        if (i != 0) {
            idList += ",";
        }
        idList += std::to_string(ids[i]);
    }
    const std::string sql
        = "SELECT signal_id, name, parent_kind, parent_id, factor, \"offset\" FROM arxml_signal WHERE signal_id IN ("
        + idList + ")";
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        duckdb_destroy_result(&res);
        return false;
    }
    const idx_t n = duckdb_row_count(&res);
    for (idx_t i = 0; i < n; ++i) {
        RequestedSignal rs;
        rs.signalId = duckdb_value_int64(&res, 0, i);
        char* name = duckdb_value_varchar(&res, 1, i);
        rs.name = name ? name : "";
        duckdb_free(name);
        char* kind = duckdb_value_varchar(&res, 2, i);
        rs.parentKind = kind ? kind : "";
        duckdb_free(kind);
        rs.parentId = duckdb_value_int64(&res, 3, i);
        rs.factor = duckdb_value_double(&res, 4, i);
        rs.offset = duckdb_value_double(&res, 5, i);
        out.push_back(std::move(rs));
    }
    duckdb_destroy_result(&res);
    return true;
}

bool writeSignalStats(fastrace::Db& db, const fastrace::SignalStatsTracker& tracker)
{
    fastrace::Appender app(db.con(), "signal_stats");
    if (!app.valid()) {
        return false;
    }
    for (const auto& slot : tracker.slots()) {
        app.i64(slot.signalId);
        app.i64(slot.samples);
        app.i64(slot.nonzero);
        app.i64(slot.changes);
        if (slot.opaque || slot.samples == 0) {
            app.null();
            app.null();
        } else {
            app.u64(slot.minRaw);
            app.u64(slot.maxRaw);
        }
        if (slot.samples == 0) {
            app.null();
            app.null();
        } else {
            app.i64(slot.firstTsUs);
            app.i64(slot.lastTsUs);
        }
        app.b(slot.opaque);
        if (!app.endRow()) {
            return false;
        }
    }
    return app.close();
}

// Combined trim-Apply pass (docs/ingestion-pipeline.html). In ONE indexed
// visitRange over only the containers [start_us,end_us] overlaps, this:
//   - recomputes window-scoped signal_stats for EVERY arxml_signal (full-table
//     DELETE-then-rewrite - every signal's aggregate changes on any rewindow), and
//   - appends decoded samples for the active signals, but only for the part of
//     the window not already covered (signal_coverage) - shrink appends nothing;
//     a disjoint window drops the signal's stale rows and re-decodes.
int runApplyTrim(int argc, char** argv)
{
    if (argc < 5) {
        printError("usage: fastrace_parse apply-trim <trace.blf> <start_us> <end_us> [<signal_id> ...]");
        return 1;
    }
    const std::string blfPath = argv[2];
    const int64_t startUs = std::strtoll(argv[3], nullptr, 10);
    const int64_t endUs = std::strtoll(argv[4], nullptr, 10);
    std::vector<int64_t> activeIds;
    for (int i = 5; i < argc; ++i) {
        activeIds.push_back(std::strtoll(argv[i], nullptr, 10));
    }

    const std::filesystem::path outPath = std::filesystem::path(blfPath).replace_extension(".duckdb");
    if (!std::filesystem::exists(outPath)) {
        printError("store not found, run prepare first: " + outPath.string());
        return 1;
    }
    if (!std::filesystem::exists(blfPath)) {
        printError("BLF not found: " + blfPath);
        return 1;
    }

    const auto wall0 = Clock::now();

    fastrace::Db db;
    if (!db.open(outPath.string())) {
        printError("could not open store: " + outPath.string());
        return 1;
    }

    std::string arxmlPath;
    if (!queryMetaString(db.con(), "source_arxml", arxmlPath) || arxmlPath.empty()) {
        printError("store has no ARXML loaded; re-run prepare with an ARXML file");
        return 1;
    }
    std::string blfSizeMeta;
    std::string blfMtimeMeta;
    if (!queryMetaString(db.con(), "blf_size", blfSizeMeta) || !queryMetaString(db.con(), "blf_mtime", blfMtimeMeta)) {
        printError("store is missing blf_size/blf_mtime meta; re-run prepare");
        return 1;
    }
    std::error_code statEc;
    const uint64_t curSize = std::filesystem::file_size(blfPath, statEc);
    const int64_t curMtime
        = static_cast<int64_t>(std::filesystem::last_write_time(blfPath, statEc).time_since_epoch().count());
    if (std::to_string(curSize) != blfSizeMeta || std::to_string(curMtime) != blfMtimeMeta) {
        printError("BLF changed since prepare; re-run prepare: " + blfPath);
        return 1;
    }

    const fastrace::ArDatabase arDb = fastrace::ArxmlParser::parseFile(arxmlPath);
    fastrace::SignalStatsTracker tracker(arDb);

    // Resolve the byte range to inflate from container_index. Lower bound: the
    // earliest container whose span reaches start_us (last_ts_us >= start_us) -
    // NOT "max byte_offset where first_ts_us <= start_us", which breaks when a
    // later container also satisfies first_ts_us <= start_us (e.g. trailing
    // timestamp-0 messages at EOF would hijack the seek to the end of the file).
    // Upper bound: the first container starting after end_us.
    uint64_t startOffset = 0;
    uint64_t endOffset = UINT64_MAX;
    int64_t scratch = 0;
    if (queryOptInt64(db.con(),
            "SELECT min(byte_offset) FROM container_index WHERE last_ts_us >= " + std::to_string(startUs), scratch)) {
        startOffset = static_cast<uint64_t>(scratch);
    }
    if (queryOptInt64(db.con(),
            "SELECT min(byte_offset) FROM container_index WHERE first_ts_us > " + std::to_string(endUs), scratch)) {
        endOffset = static_cast<uint64_t>(scratch);
    }
    // Seed the msg_id counter so appended signals rows stay aligned with Prepare.
    uint64_t nextMsgId = 0;
    if (startOffset > 0
        && queryOptInt64(db.con(),
            "SELECT first_msg_id FROM container_index WHERE byte_offset = " + std::to_string(startOffset), scratch)) {
        nextMsgId = static_cast<uint64_t>(scratch);
    }

    // Per-active-signal coverage decisions, made before the pass.
    struct Cov {
        bool has = false;
        int64_t start = 0;
        int64_t end = 0;
    };
    std::unordered_map<std::string, RequestedSignal> lookup;
    std::unordered_map<int64_t, Cov> cov;
    if (!activeIds.empty()) {
        std::vector<RequestedSignal> requested;
        if (!queryRequestedSignals(db.con(), activeIds, requested) || requested.size() != activeIds.size()) {
            printError("one or more requested signal_id not found in arxml_signal");
            return 1;
        }
        for (const auto& r : requested) {
            lookup[r.parentKind + ":" + std::to_string(r.parentId) + ":" + r.name] = r;
        }
        for (int64_t id : activeIds) {
            Cov c;
            int64_t cs = 0;
            int64_t ce = 0;
            const bool hasCov
                = queryOptInt64(
                      db.con(), "SELECT start_us FROM signal_coverage WHERE signal_id = " + std::to_string(id), cs)
                && queryOptInt64(
                    db.con(), "SELECT end_us FROM signal_coverage WHERE signal_id = " + std::to_string(id), ce);
            if (hasCov) {
                const bool disjoint = startUs > ce || cs > endUs;
                if (disjoint) {
                    // Drop stale samples and re-decode the whole new window.
                    // Checked: leaving stale rows while resetting coverage would
                    // orphan them (future expands never re-touch them).
                    if (!db.exec("DELETE FROM signals WHERE signal_id = " + std::to_string(id))) {
                        printError("could not clear stale samples for a disjoint re-decode");
                        return 1;
                    }
                } else {
                    c = Cov { true, cs, ce };
                }
            }
            cov[id] = c;
        }
    }

    if (!db.exec("DELETE FROM signal_stats")) {
        printError("could not clear signal_stats before recompute");
        return 1;
    }

    fastrace::Appender sigApp(db.con(), "signals");
    bool failed = !sigApp.valid();
    uint64_t decodedCount = 0;
    auto lastProgress = Clock::now();
    constexpr uint64_t kProgressEveryMessages = 10000;
    constexpr auto kProgressEveryMs = std::chrono::milliseconds(250);

    fastrace::BlfIngestReader reader;
    const bool ok = reader.visitRange(blfPath, startOffset, endOffset, [&](const fastrace::TraceMessage& msgIn) {
        if (failed) {
            return;
        }
        fastrace::TraceMessage msg = msgIn;
        const uint64_t msgId = nextMsgId++;
        const int64_t ts = static_cast<int64_t>(msg.timestampUs);
        if (ts < startUs || ts > endUs) {
            return;
        }
        if (fastrace::isEthernet(msg.objectType) && !msg.data.empty()) {
            fastrace::indexEthernetPdus(msg);
        }

        tracker.observe(msg);

        if (!lookup.empty()) {
            for (const auto& ds : fastrace::decodeAllSignals(arDb, msg)) {
                const std::string key = (ds.parentPduId != 0)
                    ? ("pdu:" + std::to_string(ds.parentPduId) + ":" + ds.name)
                    : ("can:" + std::to_string(ds.parentCanId) + ":" + ds.name);
                auto it = lookup.find(key);
                if (it == lookup.end()) {
                    continue;
                }
                auto cit = cov.find(it->second.signalId);
                if (cit != cov.end() && cit->second.has && ts >= cit->second.start && ts <= cit->second.end) {
                    continue; // already covered - skip the re-decode
                }
                const double physValue = static_cast<double>(ds.rawValue) * it->second.factor + it->second.offset;
                sigApp.i64(it->second.signalId);
                sigApp.i64(static_cast<int64_t>(msgId));
                sigApp.i64(ts);
                sigApp.u64(ds.rawValue);
                sigApp.f64(physValue);
                if (!sigApp.endRow()) {
                    failed = true;
                    return;
                }
                ++decodedCount;
            }
        }

        const auto now = Clock::now();
        if (nextMsgId % kProgressEveryMessages == 0 || now - lastProgress >= kProgressEveryMs) {
            printProgress(reader.stats().containers, nextMsgId, reader.stats().bytesRead, reader.stats().fileSizeBytes,
                std::chrono::duration_cast<std::chrono::milliseconds>(now - wall0).count());
            lastProgress = now;
        }
    });

    failed = failed || !ok;
    failed = !sigApp.close() || failed;
    if (!failed) {
        failed = !writeSignalStats(db, tracker);
    }

    // Update signal_coverage: coverage tracks the decoded extent and only grows
    // (union), except a disjoint jump which reset it above (c.has == false).
    if (!failed) {
        for (int64_t id : activeIds) {
            const Cov& c = cov[id];
            const int64_t ns = c.has ? (c.start < startUs ? c.start : startUs) : startUs;
            const int64_t ne = c.has ? (c.end > endUs ? c.end : endUs) : endUs;
            // Checked, like every other exec: a failed coverage upsert must not
            // report success, or the next incremental decode trusts stale bounds.
            failed = !db.exec("DELETE FROM signal_coverage WHERE signal_id = " + std::to_string(id))
                || !db.exec("INSERT INTO signal_coverage VALUES (" + std::to_string(id) + "," + std::to_string(ns)
                    + "," + std::to_string(ne) + ")")
                || failed;
        }
    }

    const int64_t elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - wall0).count();
    if (failed) {
        printError("apply-trim failed: " + blfPath);
        return 1;
    }
    printDone(reader.stats().containers, reader.stats().messages, decodedCount, reader.stats().bytesRead,
        reader.stats().fileSizeBytes, elapsedMs);
    return 0;
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

    std::error_code statEc;
    const uint64_t blfSize = std::filesystem::file_size(blfPath, statEc);
    const int64_t blfMtime
        = static_cast<int64_t>(std::filesystem::last_write_time(blfPath, statEc).time_since_epoch().count());

    fastrace::Db db;
    bool failed = !db.open(outPath.string()) || !db.exec(fastrace::kSchemaSql) || !db.meta("source_blf", blfPath)
        || !db.meta("schema_version", fastrace::kSchemaVersion) || !db.meta("stage_format", "libduckdb_appender")
        || !db.meta("blf_size", std::to_string(blfSize)) || !db.meta("blf_mtime", std::to_string(blfMtime));

    fastrace::ArDatabase arDb;
    std::optional<fastrace::SignalStatsTracker> tracker;
    if (!failed && !arxmlPath.empty()) {
        arDb = fastrace::ArxmlParser::parseFile(arxmlPath);
        failed = !fastrace::loadArxml(db, arDb, arxmlPath);
        if (!failed) {
            tracker.emplace(arDb);
        }
    }

    uint64_t peeled = 0;
    uint64_t finalContainers = 0;
    uint64_t finalMessages = 0;
    uint64_t finalBytesRead = 0;
    uint64_t finalBytesTotal = 0;
    int64_t signalStatsUs = 0;
    if (!failed) {
        fastrace::Appender msgApp(db.con(), "messages");
        fastrace::Appender pduApp(db.con(), "protocol_pdu");
        fastrace::Appender someipApp(db.con(), "protocol_someip");
        fastrace::Appender sdApp(db.con(), "protocol_someip_sd");
        fastrace::Appender doipApp(db.con(), "protocol_doip");
        fastrace::Appender ciApp(db.con(), "container_index");
        failed = !msgApp.valid() || !pduApp.valid() || !someipApp.valid() || !sdApp.valid() || !doipApp.valid()
            || !ciApp.valid();

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

            if (tracker) {
                const auto stats0 = Clock::now();
                tracker->observe(msg);
                signalStatsUs += std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - stats0).count();
            }

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
                printProgress(reader.stats().containers, nextMsgId, reader.stats().bytesRead,
                    reader.stats().fileSizeBytes,
                    std::chrono::duration_cast<std::chrono::milliseconds>(now - wall0).count());
                lastProgress = now;
            }
        }, [&](uint64_t ord, uint64_t byteOffset, int64_t firstTsUs, int64_t lastTsUs, uint64_t ownMsgCount) {
            // container_index: coarse per-container seek map (docs/ingestion-pipeline.html).
            // first_msg_id must be the id of this container's first OWN (non-stitched)
            // message - the message a ranged decode starting here reproduces first
            // (a restart has no pendingTail, so a leading cross-container split is
            // dropped). nextMsgId has advanced past all of this container's messages,
            // so that id is (nextMsgId - ownMsgCount).
            if (failed) {
                return;
            }
            ciApp.i64(static_cast<int64_t>(ord));
            ciApp.i64(static_cast<int64_t>(byteOffset));
            ciApp.i64(firstTsUs);
            ciApp.i64(lastTsUs);
            ciApp.i64(static_cast<int64_t>(nextMsgId - ownMsgCount));
            if (!ciApp.endRow()) {
                failed = true;
            }
        });

        failed = failed || !ok;
        failed = !msgApp.close() || !pduApp.close() || !someipApp.close() || !sdApp.close() || !doipApp.close()
            || !ciApp.close() || failed;

        if (!failed && tracker) {
            const auto write0 = Clock::now();
            failed = !writeSignalStats(db, *tracker);
            signalStatsUs += std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - write0).count();
            if (!failed) {
                db.meta("signal_stats_ms", std::to_string(signalStatsUs / 1000));
            }
        }

        if (!failed) {
            finalContainers = reader.stats().containers;
            finalMessages = reader.stats().messages;
            finalBytesRead = reader.stats().bytesRead;
            finalBytesTotal = reader.stats().fileSizeBytes;
            db.meta("stage_a_containers", std::to_string(finalContainers));
            db.meta("stage_a_messages", std::to_string(finalMessages));
            db.meta("protocol_rows", std::to_string(peeled));
        }
    }

    const int64_t elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - wall0).count();

    if (failed) {
        removeOutputs(outPath);
        printError("prepare failed: " + blfPath);
        return 1;
    }

    db.meta("wall_ms", std::to_string(elapsedMs));
    printDone(finalContainers, finalMessages, peeled, finalBytesRead, finalBytesTotal, elapsedMs);
    return 0;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <prepare|apply-trim> [args...]\n", argv[0]);
        return 1;
    }
    if (std::strcmp(argv[1], "prepare") == 0) {
        return runPrepare(argc, argv);
    }
    if (std::strcmp(argv[1], "apply-trim") == 0) {
        return runApplyTrim(argc, argv);
    }
    std::fprintf(stderr, "unknown subcommand: %s\n", argv[1]);
    return 1;
}
