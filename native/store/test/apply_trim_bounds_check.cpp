// Checker for the fastrace_apply_trim_bounds ctest. Asserts, after an
// `apply-trim` run, the per-signal `signals` row count (decode delta), the
// window-scoped `signal_stats.samples`, and the `signal_coverage` window.
// A coverage want of -1 means "no signal_coverage row for this signal".
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

void expectEq(int64_t got, int64_t want, const char* label)
{
    if (got != want) {
        std::fprintf(
            stderr, "FAIL: %s = %lld, want %lld\n", label, static_cast<long long>(got), static_cast<long long>(want));
        ++gFailures;
    }
}
} // namespace

int main(int argc, char** argv)
{
    if (argc != 7) {
        std::fprintf(stderr,
            "usage: %s <fixture.duckdb> <signal_id> <want_signal_rows> <want_samples> <want_cov_start> "
            "<want_cov_end>\n",
            argv[0]);
        return 1;
    }
    duckdb_database db = nullptr;
    duckdb_connection con = nullptr;
    if (duckdb_open(argv[1], &db) == DuckDBError || duckdb_connect(db, &con) == DuckDBError) {
        std::fprintf(stderr, "FAIL: could not open %s\n", argv[1]);
        return 1;
    }
    const std::string sid = argv[2];
    const int64_t wantRows = std::strtoll(argv[3], nullptr, 10);
    const int64_t wantSamples = std::strtoll(argv[4], nullptr, 10);
    const int64_t wantCovStart = std::strtoll(argv[5], nullptr, 10);
    const int64_t wantCovEnd = std::strtoll(argv[6], nullptr, 10);

    expectEq(queryInt(con, "select count(*) from signals where signal_id = " + sid + ";", "signal_rows"), wantRows,
        "signal_rows");
    expectEq(queryInt(con, "select samples from signal_stats where signal_id = " + sid + ";", "samples"), wantSamples,
        "samples");
    // signal_stats must always hold exactly one row per arxml_signal.
    expectEq(queryInt(con, "select count(*) from signal_stats;", "stats_rows"),
        queryInt(con, "select count(*) from arxml_signal;", "arxml_rows"), "stats_rows==arxml_rows");

    const int64_t covRows = queryInt(con, "select count(*) from signal_coverage where signal_id = " + sid + ";", "cov");
    if (wantCovStart < 0) {
        expectEq(covRows, 0, "coverage_absent");
    } else {
        expectEq(covRows, 1, "coverage_present");
        expectEq(queryInt(con, "select start_us from signal_coverage where signal_id = " + sid + ";", "cov_start"),
            wantCovStart, "cov_start");
        expectEq(queryInt(con, "select end_us from signal_coverage where signal_id = " + sid + ";", "cov_end"),
            wantCovEnd, "cov_end");
    }

    duckdb_disconnect(&con);
    duckdb_close(&db);
    if (gFailures > 0) {
        return 1;
    }
    std::printf("apply_trim_bounds_check: OK\n");
    return 0;
}
