#include <cstdio>
#include <cstring>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: fastrace_parse <prepare|decode-signals> [args...]\n");
        return 1;
    }
    if (std::strcmp(argv[1], "prepare") == 0) {
        std::fprintf(stderr, "fastrace_parse prepare: not implemented yet (see docs/adr/0002)\n");
        return 1;
    }
    if (std::strcmp(argv[1], "decode-signals") == 0) {
        std::fprintf(stderr, "fastrace_parse decode-signals: not implemented yet (see docs/adr/0005)\n");
        return 1;
    }
    std::fprintf(stderr, "unknown subcommand: %s\n", argv[1]);
    return 1;
}
