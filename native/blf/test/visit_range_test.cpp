// Exercises the per-container callback (visit overload) and the byte-ranged
// visitRange seek against the committed synthetic fixture. The fixture is a
// single LOG_CONTAINER, so this proves the callback metadata and the
// byte-offset gate; the multi-container skip is the same offset gate and is
// covered end-to-end by native/store's apply-trim integration test.
#include "BlfIngestReader.h"
#include <cstdint>
#include <cstdio>
#include <tuple>
#include <vector>

#ifndef FASTRACE_FIXTURE_BLF
#error "FASTRACE_FIXTURE_BLF must be defined by CMake"
#endif

int main()
{
    int failures = 0;
    auto expect = [&](bool cond, const char* msg) {
        if (!cond) {
            std::fprintf(stderr, "FAIL: %s\n", msg);
            ++failures;
        }
    };

    // Full walk via the new overload: capture per-container metadata + the
    // message count and timestamp extent.
    std::vector<std::tuple<uint64_t, uint64_t, int64_t, int64_t, uint64_t>> containers;
    uint64_t fullCount = 0;
    int64_t fullMin = INT64_MAX, fullMax = INT64_MIN;
    fastrace::BlfIngestReader full;
    const bool okFull = full.visit(
        FASTRACE_FIXTURE_BLF,
        [&](const fastrace::TraceMessage& m) {
            ++fullCount;
            fullMin = std::min(fullMin, static_cast<int64_t>(m.timestampUs));
            fullMax = std::max(fullMax, static_cast<int64_t>(m.timestampUs));
        },
        [&](uint64_t ord, uint64_t off, int64_t f, int64_t l, uint64_t n) {
            containers.push_back({ ord, off, f, l, n });
        });
    expect(okFull, "visit() with onContainer returned true");
    expect(!containers.empty(), "at least one container reported");
    expect(fullCount > 0, "fixture emitted messages");

    // Callback bookkeeping must match the message stream.
    uint64_t cbMsgSum = 0;
    for (const auto& [ord, off, f, l, n] : containers) {
        cbMsgSum += n;
        expect(l >= f, "container last_ts >= first_ts");
    }
    expect(cbMsgSum == fullCount, "sum of per-container msgCount == total messages");
    const auto [ord0, off0, first0, last0, n0] = containers.front();
    expect(first0 >= fullMin && last0 <= fullMax, "container ts range within the trace extent");

    // visitRange from the first container's own offset emits every message.
    uint64_t allCount = 0;
    fastrace::BlfIngestReader r1;
    r1.visitRange(FASTRACE_FIXTURE_BLF, off0, UINT64_MAX, [&](const fastrace::TraceMessage&) { ++allCount; });
    expect(allCount == fullCount, "visitRange(firstOffset, MAX) emits the full stream");

    // visitRange starting past every container emits nothing (byte-offset gate).
    uint64_t noneCount = 0;
    fastrace::BlfIngestReader r2;
    r2.visitRange(FASTRACE_FIXTURE_BLF, full.stats().fileSizeBytes, UINT64_MAX,
        [&](const fastrace::TraceMessage&) { ++noneCount; });
    expect(noneCount == 0, "visitRange starting past EOF emits nothing");

    // endByteOffset before the container's offset stops immediately.
    uint64_t stoppedCount = 0;
    fastrace::BlfIngestReader r3;
    r3.visitRange(FASTRACE_FIXTURE_BLF, 0, off0, [&](const fastrace::TraceMessage&) { ++stoppedCount; });
    expect(stoppedCount == 0, "endByteOffset at/before the first container stops before emitting");

    if (failures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("visit_range_test: OK\n");
    return 0;
}
