#include "Store.h"

#include <spdlog/spdlog.h>

namespace fastrace {

Appender::Appender(duckdb_connection con, const char* table)
    : m_table(table)
{
    if (duckdb_appender_create(con, nullptr, table, &m_app) == DuckDBError) {
        spdlog::error("appender_create {} failed", table);
        m_app = nullptr;
    }
}

Appender::~Appender() { close(); }

void Appender::i64(int64_t v) { duckdb_append_int64(m_app, v); }

void Appender::u64(uint64_t v) { duckdb_append_uint64(m_app, v); }

void Appender::i32(int32_t v) { duckdb_append_int32(m_app, v); }

void Appender::f64(double v) { duckdb_append_double(m_app, v); }

void Appender::b(bool v) { duckdb_append_bool(m_app, v); }

void Appender::str(const std::string& s) { duckdb_append_varchar_length(m_app, s.data(), s.size()); }

void Appender::null() { duckdb_append_null(m_app); }

bool Appender::endRow()
{
    if (duckdb_appender_end_row(m_app) == DuckDBError) {
        spdlog::error("appender {}: {}", m_table, duckdb_appender_error(m_app));
        return false;
    }
    return true;
}

bool Appender::close()
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

} // namespace fastrace
