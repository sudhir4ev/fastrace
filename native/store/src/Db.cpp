#include "Store.h"

#include <spdlog/spdlog.h>

namespace fastrace {

Db::~Db()
{
    if (m_con) {
        duckdb_disconnect(&m_con);
    }
    if (m_db) {
        duckdb_close(&m_db);
    }
}

bool Db::open(const std::string& path)
{
    if (duckdb_open(path.c_str(), &m_db) == DuckDBError) {
        spdlog::error("duckdb_open failed: {}", path);
        return false;
    }
    if (duckdb_connect(m_db, &m_con) == DuckDBError) {
        spdlog::error("duckdb_connect failed");
        return false;
    }
    return true;
}

bool Db::exec(const std::string& sql)
{
    duckdb_result res;
    const bool ok = duckdb_query(m_con, sql.c_str(), &res) == DuckDBSuccess;
    if (!ok) {
        spdlog::error("duckdb_query: {}", duckdb_result_error(&res));
    }
    duckdb_destroy_result(&res);
    return ok;
}

bool Db::meta(const std::string& key, const std::string& value)
{
    std::string v;
    for (char c : value) {
        v += (c == '\'') ? std::string("''") : std::string(1, c);
    }
    return exec("INSERT INTO meta VALUES ('" + key + "', '" + v
        + "') ON CONFLICT (key) DO UPDATE SET value = excluded.value;");
}

} // namespace fastrace
