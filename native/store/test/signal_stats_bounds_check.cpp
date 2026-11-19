// Checker for the fastrace_signal_stats_bounds ctest.
#include <cstdio>
#include <cstdlib>
#include <string>

#include <duckdb.h>

namespace {
int gFailures = 0;

int64_t queryInt(duckdb_connection con, const std::string& sql, const char* label)
{
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        std::fprintf(stderr, "FAIL (%s): query failed: %s\n", label, duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        ++gFailures;
        return -1;
    }
    const int64_t v = duckdb_value_int64(&res, 0, 0);
    duckdb_destroy_result(&res);
    return v;
}
} // namespace

int main(int argc, char** argv)
{
    if (argc != 5) {
        std::fprintf(stderr, "usage: %s <fixture.duckdb> <signal_id> <want_samples> <want_total_rows>\n", argv[0]);
        return 1;
    }
    duckdb_database db = nullptr;
    duckdb_connection con = nullptr;
    if (duckdb_open(argv[1], &db) == DuckDBError || duckdb_connect(db, &con) == DuckDBError) {
        std::fprintf(stderr, "FAIL: could not open %s\n", argv[1]);
        return 1;
    }
    const int64_t signalId = std::strtoll(argv[2], nullptr, 10);
    const int64_t wantSamples = std::strtoll(argv[3], nullptr, 10);
    const int64_t wantTotalRows = std::strtoll(argv[4], nullptr, 10);

    const int64_t gotSamples = queryInt(
        con, "select samples from signal_stats where signal_id = " + std::to_string(signalId) + ";", "samples");
    if (gotSamples != wantSamples) {
        std::fprintf(stderr, "FAIL: samples = %lld, want %lld\n", static_cast<long long>(gotSamples),
            static_cast<long long>(wantSamples));
        ++gFailures;
    }
    const int64_t gotTotalRows = queryInt(con, "select count(*) from signal_stats;", "total_rows");
    if (gotTotalRows != wantTotalRows) {
        std::fprintf(stderr, "FAIL: signal_stats row count = %lld, want %lld (one row per arxml_signal)\n",
            static_cast<long long>(gotTotalRows), static_cast<long long>(wantTotalRows));
        ++gFailures;
    }

    duckdb_disconnect(&con);
    duckdb_close(&db);
    if (gFailures > 0) {
        return 1;
    }
    std::printf("signal_stats_bounds_check: OK\n");
    return 0;
}
