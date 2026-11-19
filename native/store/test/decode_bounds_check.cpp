// Checker for the fastrace_decode_signals_bounds ctest: asserts decode-signals
// respects its [start_us, end_us] bound and is idempotent on re-run (no
// duplicate rows for the same signal across repeated Apply calls).
#include <cstdio>
#include <cstdlib>
#include <string>

#include <duckdb.h>

namespace {

int gFailures = 0;

void expectSignalRowCount(duckdb_connection con, int64_t signalId, int64_t want, const char* label)
{
    const std::string sql = "select count(*) from signals where signal_id = " + std::to_string(signalId) + ";";
    duckdb_result res;
    if (duckdb_query(con, sql.c_str(), &res) != DuckDBSuccess) {
        std::fprintf(stderr, "FAIL (%s): query failed: %s\n", label, duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        ++gFailures;
        return;
    }
    const int64_t got = duckdb_value_int64(&res, 0, 0);
    duckdb_destroy_result(&res);
    if (got != want) {
        std::fprintf(stderr, "FAIL (%s): signals row count for signal_id=%lld = %lld, want %lld\n", label,
            static_cast<long long>(signalId), static_cast<long long>(got), static_cast<long long>(want));
        ++gFailures;
    }
}

} // namespace

int main(int argc, char** argv)
{
    if (argc != 4) {
        std::fprintf(stderr, "usage: %s <fixture.duckdb> <signal_id> <want_count>\n", argv[0]);
        return 1;
    }
    duckdb_database db = nullptr;
    duckdb_connection con = nullptr;
    if (duckdb_open(argv[1], &db) == DuckDBError || duckdb_connect(db, &con) == DuckDBError) {
        std::fprintf(stderr, "FAIL: could not open %s\n", argv[1]);
        return 1;
    }
    expectSignalRowCount(con, std::strtoll(argv[2], nullptr, 10), std::strtoll(argv[3], nullptr, 10), argv[1]);
    duckdb_disconnect(&con);
    duckdb_close(&db);
    if (gFailures > 0) {
        return 1;
    }
    std::printf("decode_bounds_check: OK\n");
    return 0;
}
