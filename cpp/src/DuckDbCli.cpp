#include "DuckDbCli.h"

#include <array>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fastrace {
namespace {

std::string shellQuote(const std::string& s)
{
    std::string out;
    out.push_back('\'');
    for (char c : s) {
        if (c == '\'') {
            out += "'\\''";
        } else {
            out.push_back(c);
        }
    }
    out.push_back('\'');
    return out;
}

bool runShell(const std::string& cmd, std::string& captured, int& exitCode)
{
    captured.clear();
    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) {
        exitCode = -1;
        return false;
    }
    std::array<char, 4096> buf {};
    while (fgets(buf.data(), static_cast<int>(buf.size()), pipe) != nullptr) {
        captured += buf.data();
    }
    exitCode = pclose(pipe);
#ifndef _WIN32
    if (WIFEXITED(exitCode)) {
        exitCode = WEXITSTATUS(exitCode);
    }
#endif
    return true;
}

std::string resolveOnPath(const std::string& name)
{
    if (name.find('/') != std::string::npos) {
        return name;
    }
    std::string out;
    int ec = 0;
    if (!runShell("command -v " + shellQuote(name) + " 2>/dev/null", out, ec) || ec != 0) {
        return name;
    }
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) {
        out.pop_back();
    }
    return out.empty() ? name : out;
}

} // namespace

DuckDbCli::DuckDbCli(std::string explicitPath)
{
    if (!explicitPath.empty()) {
        m_binary = std::move(explicitPath);
        return;
    }
    if (const char* env = std::getenv("FASTRACE_DUCKDB")) {
        if (env[0] != '\0') {
            m_binary = env;
            return;
        }
    }
    m_binary = resolveOnPath("duckdb");
}

bool DuckDbCli::available(std::string* err) const
{
    namespace fs = std::filesystem;
    std::error_code ec;
    if (fs::exists(m_binary, ec) && fs::is_regular_file(m_binary, ec)) {
        return true;
    }
    std::string out;
    int exitCode = 0;
    if (runShell("command -v " + shellQuote(m_binary) + " 2>/dev/null", out, exitCode) && exitCode == 0
        && !out.empty()) {
        return true;
    }
    if (err) {
        *err = "duckdb CLI not found (tried '" + m_binary
            + "'). Install DuckDB CLI or pass --duckdb <path> / set FASTRACE_DUCKDB.";
    }
    return false;
}

bool DuckDbCli::run(const std::string& dbPath, const std::string& sql, std::string* err) const
{
    // Prefer -c for short SQL; write temp file for large scripts to avoid shell limits.
    const bool useFile = sql.size() > 8000 || sql.find('\n') != std::string::npos;
    if (useFile) {
        const auto tmp = std::filesystem::temp_directory_path() / "fastrace_duckdb_cmd.sql";
        {
            std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
            if (!out) {
                if (err) {
                    *err = "failed to write temp SQL file";
                }
                return false;
            }
            out << sql;
            if (!sql.empty() && sql.back() != ';') {
                out << ';';
            }
            out << '\n';
        }
        const bool ok = runFile(dbPath, tmp, err);
        std::error_code ec;
        std::filesystem::remove(tmp, ec);
        return ok;
    }

    const std::string cmd = shellQuote(m_binary) + " " + shellQuote(dbPath) + " -c " + shellQuote(sql) + " 2>&1";
    std::string captured;
    int exitCode = 0;
    if (!runShell(cmd, captured, exitCode)) {
        if (err) {
            *err = "popen failed for duckdb";
        }
        return false;
    }
    if (exitCode != 0) {
        if (err) {
            *err = captured.empty() ? ("duckdb exit " + std::to_string(exitCode)) : captured;
        }
        return false;
    }
    return true;
}

bool DuckDbCli::runFile(const std::string& dbPath, const std::filesystem::path& sqlFile, std::string* err) const
{
    if (!std::filesystem::exists(sqlFile)) {
        if (err) {
            *err = "SQL file not found: " + sqlFile.string();
        }
        return false;
    }
    const std::string cmd = shellQuote(m_binary) + " " + shellQuote(dbPath) + " < " + shellQuote(sqlFile.string())
        + " 2>&1";
    std::string captured;
    int exitCode = 0;
    if (!runShell(cmd, captured, exitCode)) {
        if (err) {
            *err = "popen failed for duckdb";
        }
        return false;
    }
    if (exitCode != 0) {
        if (err) {
            *err = captured.empty() ? ("duckdb exit " + std::to_string(exitCode)) : captured;
        }
        return false;
    }
    return true;
}

std::filesystem::path DuckDbCli::findSqlFile(const char* name, const char* argv0)
{
    std::vector<std::filesystem::path> candidates;
    if (const char* root = std::getenv("FASTRACE_ROOT")) {
        candidates.push_back(std::filesystem::path(root) / "cpp" / "sql" / name);
    }
    candidates.push_back(std::filesystem::path("cpp/sql") / name);
    candidates.push_back(std::filesystem::path("sql") / name);
    if (argv0) {
        candidates.push_back(std::filesystem::path(argv0).parent_path() / "sql" / name);
        candidates.push_back(std::filesystem::path(argv0).parent_path().parent_path() / "sql" / name);
    }
    for (const auto& p : candidates) {
        std::error_code ec;
        if (std::filesystem::exists(p, ec)) {
            return p;
        }
    }
    return {};
}

} // namespace fastrace
