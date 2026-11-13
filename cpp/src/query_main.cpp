#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include <spdlog/spdlog.h>

#include "DuckDbCli.h"

#ifndef _WIN32
#include <unistd.h>
#else
#include <io.h>
#define isatty _isatty
#define STDIN_FILENO 0
#define execvp _execvp
#endif

namespace {

void usage(const char* argv0)
{
    std::cerr << "Usage: " << argv0 << " --db <path.duckdb> [--duckdb <cli>]\n"
              << "  Thin wrapper around the external duckdb CLI.\n"
              << "  Interactive: " << argv0 << " --db <path>\n"
              << "  Batch:       echo 'SELECT 1;' | " << argv0 << " --db <path>\n";
}

} // namespace

int main(int argc, char** argv)
{
    spdlog::set_level(spdlog::level::warn);
    std::string dbPath;
    std::string duckdbPath;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--db" && i + 1 < argc) {
            dbPath = argv[++i];
        } else if (a == "--duckdb" && i + 1 < argc) {
            duckdbPath = argv[++i];
        } else if (a == "-h" || a == "--help") {
            usage(argv[0]);
            return 0;
        } else {
            std::cerr << "unknown arg: " << a << '\n';
            usage(argv[0]);
            return 1;
        }
    }
    if (dbPath.empty()) {
        usage(argv[0]);
        return 1;
    }

    fastrace::DuckDbCli cli(duckdbPath);
    std::string err;
    if (!cli.available(&err)) {
        spdlog::error("{}", err);
        return 1;
    }

    // Replace this process with duckdb <db> so interactive + stdin batch just work.
    std::vector<char*> args;
    args.push_back(const_cast<char*>(cli.binary().c_str()));
    args.push_back(const_cast<char*>(dbPath.c_str()));
    args.push_back(nullptr);
    execvp(args[0], args.data());
    spdlog::error("failed to exec {}: check --duckdb / PATH", cli.binary());
    return 1;
}
