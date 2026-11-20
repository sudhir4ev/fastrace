// Injects a trailing timestamp-0 container_index row (large byte_offset, near
// "EOF") to reproduce the real-trace shape where the last container holds only
// ts=0 messages. With the buggy start-offset SQL (max byte_offset where
// first_ts_us <= start) this row hijacks the seek to the end of the file and the
// window decodes nothing; the fix (min byte_offset where last_ts_us >= start)
// ignores it. Used by the fastrace_apply_trim_hijack ctest.
#include <cstdio>

#include <duckdb.h>

int main(int argc, char** argv)
{
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s <store.duckdb>\n", argv[0]);
        return 1;
    }
    duckdb_database db = nullptr;
    duckdb_connection con = nullptr;
    if (duckdb_open(argv[1], &db) == DuckDBError || duckdb_connect(db, &con) == DuckDBError) {
        std::fprintf(stderr, "FAIL: could not open %s\n", argv[1]);
        return 1;
    }
    duckdb_result res;
    // ord/first_msg_id are arbitrary; byte_offset is far past the tiny fixture's
    // real containers, first_ts_us=last_ts_us=0 mimics trailing ts=0 messages.
    if (duckdb_query(con, "INSERT INTO container_index VALUES (999999, 10000000, 0, 0, 999999, false);", &res)
        != DuckDBSuccess) {
        std::fprintf(stderr, "FAIL: insert failed: %s\n", duckdb_result_error(&res));
        duckdb_destroy_result(&res);
        return 1;
    }
    duckdb_destroy_result(&res);
    duckdb_disconnect(&con);
    duckdb_close(&db);
    std::printf("container_index_hijack_seed: OK\n");
    return 0;
}
