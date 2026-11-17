// Checker invoked by the fastrace_store_fixture_prepare ctest: asserts the
// exact per-table row counts ADR 0007 calls for, after `fastrace_parse
// prepare` has already run against the committed synthetic fixture (see
// native/store/test/fixtures/generate_fixture.cpp for how these counts are
// derived from the fixture's contents).

#include <cstdio>
#include <string>

#include <duckdb.h>

namespace {

int gFailures = 0;

void expectCount(duckdb_connection con, const char* table, int64_t want)
{
    const std::string sql = std::string("select count(*) from ") + table + ";";
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        std::fprintf(stderr, "FAIL: query failed for %s: %s\n", table, duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        ++gFailures;
        return;
    }
    const int64_t got = duckdb_value_int64(&res, 0, 0);
    duckdb_destroy_result(&res);
    if (got != want) {
        std::fprintf(stderr, "FAIL: %s row count = %lld, want %lld\n", table, static_cast<long long>(got),
            static_cast<long long>(want));
        ++gFailures;
    }
}

void expectScalar(duckdb_connection con, const char* label, const std::string& sql, double want)
{
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        std::fprintf(stderr, "FAIL: query failed for %s: %s\n", label, duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        ++gFailures;
        return;
    }
    const double got = duckdb_value_double(&res, 0, 0);
    duckdb_destroy_result(&res);
    if (got != want) {
        std::fprintf(stderr, "FAIL: %s = %f, want %f\n", label, got, want);
        ++gFailures;
    }
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s <fixture.duckdb>\n", argv[0]);
        return 1;
    }

    duckdb_database db = nullptr;
    duckdb_connection con = nullptr;
    if (duckdb_open(argv[1], &db) == DuckDBError || duckdb_connect(db, &con) == DuckDBError) {
        std::fprintf(stderr, "FAIL: could not open %s\n", argv[1]);
        return 1;
    }

    expectCount(con, "messages", 6); // 2 CAN + 4 Ethernet
    expectCount(con, "protocol_pdu", 2); // E1's packed PDU + E4's incidental PDU-walk hit
    expectCount(con, "protocol_someip", 1); // E2
    expectCount(con, "protocol_someip_sd", 1); // E3
    expectCount(con, "protocol_doip", 1); // E4
    expectCount(con, "arxml_pdu", 1);
    expectCount(con, "arxml_can", 1);
    expectCount(con, "arxml_ecu", 1);
    expectCount(con, "arxml_signal", 1); // EngineRpm, the fixture's one scaled signal
    expectScalar(con, "arxml_signal.factor", "select factor from arxml_signal where name = 'EngineRpm'", 0.25);
    expectScalar(con, "arxml_signal.offset", "select \"offset\" from arxml_signal where name = 'EngineRpm'", 0.0);

    duckdb_disconnect(&con);
    duckdb_close(&db);

    if (gFailures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", gFailures);
        return 1;
    }
    std::printf("fastrace_store_fixture_prepare: OK\n");
    return 0;
}
