// ctest entry point for fastrace_store, independent of any BLF file or the
// rest of the monorepo (native/store/README.md documents how to run this
// alone). Exercises the embedded schema + Appender/meta round trip against
// a handful of hand-built rows with known values.

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

#include <duckdb.h>

#include "SchemaEmbed.h"
#include "Store.h"

namespace {

int gFailures = 0;

void expect(bool cond, const char* what)
{
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++gFailures;
    }
}

int64_t queryScalarInt(duckdb_connection con, const std::string& sql)
{
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        std::fprintf(stderr, "query failed: %s (%s)\n", sql.c_str(), duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        return -1;
    }
    int64_t v = duckdb_value_int64(&res, 0, 0);
    duckdb_destroy_result(&res);
    return v;
}

std::string queryScalarStr(duckdb_connection con, const std::string& sql)
{
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        duckdb_destroy_result(&res);
        return {};
    }
    char* s = duckdb_value_varchar(&res, 0, 0);
    std::string out = s ? s : "";
    duckdb_free(s);
    duckdb_destroy_result(&res);
    return out;
}

} // namespace

int main()
{
    const std::string outPath = (std::filesystem::temp_directory_path() / "fastrace_store_roundtrip_test.duckdb").string();
    std::error_code ec;
    std::filesystem::remove(outPath, ec);
    std::filesystem::remove(outPath + ".wal", ec);

    fastrace::Db db;
    expect(db.open(outPath), "Db::open");
    expect(db.exec(fastrace::kSchemaSql), "exec embedded schema.sql");
    expect(db.meta("schema_version", fastrace::kSchemaVersion), "write schema_version meta");
    expect(db.meta("source_blf", "roundtrip_test.blf"), "write source_blf meta");

    {
        fastrace::Appender msg(db.con(), "messages");
        expect(msg.valid(), "messages appender valid");
        msg.i64(0);
        msg.i64(1000);
        msg.i32(1); // object_type
        msg.i32(1); // channel
        msg.i32(0x100); // arb_id
        msg.b(false);
        msg.i32(8); // dlc
        msg.str("");
        msg.i32(0);
        msg.i32(8); // payload_len
        expect(msg.endRow(), "messages endRow");
        expect(msg.close(), "messages close");
    }

    {
        fastrace::Appender pdu(db.con(), "arxml_pdu");
        fastrace::Appender can(db.con(), "arxml_can");
        fastrace::Appender ecu(db.con(), "arxml_ecu");
        pdu.i64(1);
        pdu.str("E1Pdu");
        pdu.str("192.168.1.10");
        pdu.i32(5000);
        expect(pdu.endRow(), "arxml_pdu endRow");
        expect(pdu.close(), "arxml_pdu close");

        can.i64(0x100);
        can.str("EngineMsg");
        can.b(false);
        can.i32(8);
        expect(can.endRow(), "arxml_can endRow");
        expect(can.close(), "arxml_can close");

        ecu.str("Gateway");
        expect(ecu.endRow(), "arxml_ecu endRow");
        expect(ecu.close(), "arxml_ecu close");
    }

    {
        fastrace::Appender sig(db.con(), "arxml_signal");
        expect(sig.valid(), "arxml_signal appender valid");
        sig.i64(0);
        sig.str("EngineRpm");
        sig.str("can");
        sig.i64(0x100);
        sig.i32(0); // start_bit
        sig.i32(16); // bit_length
        sig.b(false); // big_endian
        sig.f64(0.25); // factor
        sig.f64(0.0); // offset
        expect(sig.endRow(), "arxml_signal endRow");
        expect(sig.close(), "arxml_signal close");
    }

    {
        fastrace::Appender sampleApp(db.con(), "signals");
        expect(sampleApp.valid(), "signals appender valid");
        sampleApp.i64(0); // signal_id
        sampleApp.i64(0); // msg_id
        sampleApp.i64(1000); // timestamp_us
        sampleApp.u64(513); // raw_value
        sampleApp.f64(128.25); // phys_value == raw_value * factor + offset
        expect(sampleApp.endRow(), "signals endRow");
        expect(sampleApp.close(), "signals close");
    }

    expect(queryScalarInt(db.con(), "select count(*) from messages") == 1, "messages row count == 1");
    expect(queryScalarInt(db.con(), "select arb_id from messages where msg_id = 0") == 0x100, "messages.arb_id round trips");
    expect(queryScalarInt(db.con(), "select count(*) from arxml_pdu") == 1, "arxml_pdu row count == 1");
    expect(queryScalarInt(db.con(), "select count(*) from arxml_can") == 1, "arxml_can row count == 1");
    expect(queryScalarInt(db.con(), "select count(*) from arxml_ecu") == 1, "arxml_ecu row count == 1");
    expect(queryScalarInt(db.con(), "select count(*) from arxml_signal") == 1, "arxml_signal row count == 1");
    expect(queryScalarStr(db.con(), "select name from arxml_signal where signal_id = 0") == "EngineRpm",
        "arxml_signal.name round trips");
    expect(queryScalarInt(db.con(), "select count(*) from signals") == 1, "signals row count == 1");
    expect(queryScalarInt(db.con(), "select raw_value from signals where signal_id = 0") == 513,
        "signals.raw_value round trips");
    expect(queryScalarStr(db.con(), "select value from meta where key = 'schema_version'") == fastrace::kSchemaVersion,
        "meta.schema_version round trips");

    if (gFailures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", gFailures);
        return 1;
    }
    std::printf("fastrace_store_roundtrip: OK\n");
    return 0;
}
