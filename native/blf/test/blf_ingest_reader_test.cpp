// Exercises BlfIngestReader's byte-progress stats (bytesRead/fileSizeBytes)
// against the committed synthetic fixture shared with native/store's tests.
#include "BlfIngestReader.h"
#include <cstdio>

#ifndef FASTRACE_FIXTURE_BLF
#error "FASTRACE_FIXTURE_BLF must be defined by CMake"
#endif

int main()
{
    int failures = 0;

    fastrace::BlfIngestReader reader;
    const bool ok = reader.visit(FASTRACE_FIXTURE_BLF, [](const fastrace::TraceMessage&) { });
    if (!ok) {
        std::fprintf(stderr, "FAIL: visit() returned false\n");
        return 1;
    }

    const auto& stats = reader.stats();
    if (stats.fileSizeBytes == 0) {
        std::fprintf(stderr, "FAIL: fileSizeBytes must be nonzero, got 0\n");
        ++failures;
    }
    if (stats.bytesRead == 0) {
        std::fprintf(stderr, "FAIL: bytesRead must be nonzero after a successful visit, got 0\n");
        ++failures;
    }
    if (stats.bytesRead > stats.fileSizeBytes) {
        std::fprintf(stderr, "FAIL: bytesRead (%llu) exceeds fileSizeBytes (%llu)\n",
            static_cast<unsigned long long>(stats.bytesRead), static_cast<unsigned long long>(stats.fileSizeBytes));
        ++failures;
    }
    // The fixture is one LOG_CONTAINER - bytesRead after the (only) container
    // must equal fileSizeBytes exactly, not just be "close".
    if (stats.bytesRead != stats.fileSizeBytes) {
        std::fprintf(stderr, "FAIL: bytesRead (%llu) != fileSizeBytes (%llu) at end of a single-container fixture\n",
            static_cast<unsigned long long>(stats.bytesRead), static_cast<unsigned long long>(stats.fileSizeBytes));
        ++failures;
    }

    if (failures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("blf_ingest_reader_test: OK\n");
    return 0;
}
