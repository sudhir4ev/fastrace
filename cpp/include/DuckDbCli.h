#pragma once

#include <filesystem>
#include <string>

namespace fastrace {

/// Drive an external `duckdb` executable (no libduckdb link).
class DuckDbCli {
public:
    /// Resolve binary: explicitPath, else FASTRACE_DUCKDB, else "duckdb" on PATH.
    explicit DuckDbCli(std::string explicitPath = {});

    const std::string& binary() const { return m_binary; }

    /// True if `binary()` looks runnable (file exists or found on PATH via `command -v`).
    bool available(std::string* err = nullptr) const;

    /// Run SQL against dbPath (`duckdb <db> -c "..."`). Returns false on non-zero exit.
    bool run(const std::string& dbPath, const std::string& sql, std::string* err = nullptr) const;

    /// Run a .sql file (`duckdb <db> < file.sql`).
    bool runFile(const std::string& dbPath, const std::filesystem::path& sqlFile,
        std::string* err = nullptr) const;

    /// Locate a project SQL file (FASTRACE_ROOT, cwd, or beside argv0).
    static std::filesystem::path findSqlFile(const char* name, const char* argv0 = nullptr);

private:
    std::string m_binary;
};

} // namespace fastrace
