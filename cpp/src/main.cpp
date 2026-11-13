#include <chrono>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#endif
#include <spdlog/spdlog.h>

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>

#include "Analyzer.h"

namespace {

std::string payloadHex(const std::vector<uint8_t>& data, size_t maxBytes = 32)
{
    const size_t n = (std::min)(data.size(), maxBytes);
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (size_t i = 0; i < n; ++i) {
        if (i > 0) {
            oss << ' ';
        }
        oss << std::setw(2) << static_cast<unsigned>(data[i]);
    }
    if (data.size() > maxBytes) {
        oss << " ...";
    }
    return oss.str();
}

void dumpMessages(fastrace::Analyzer& analyzer, const std::string& filename, size_t limit)
{
    const size_t total = analyzer.buildIndex(filename);
    spdlog::info("Indexed {} messages in {} chunks; dumping first {}", total, analyzer.getChunkIndex().size(),
        limit);

    std::cout << "#idx\tts_us\tobjectType\tchannel\tarbId\textended\tdlc\tdstIp\tdstPort\tlen\tpayload_hex\n";

    size_t printed = 0;
    for (size_t ci = 0; ci < analyzer.getChunkIndex().size() && printed < limit; ++ci) {
        auto msgs = analyzer.decodeChunk(ci);
        for (const auto& m : msgs) {
            if (printed >= limit) {
                break;
            }
            std::cout << printed << '\t' << m.timestampUs << '\t' << m.objectType << '\t' << m.channel << '\t'
                      << "0x" << std::hex << m.arbId << std::dec << '\t' << (m.extendedId ? 1 : 0) << '\t'
                      << static_cast<unsigned>(m.dlc) << '\t' << m.dstIp << '\t' << m.dstPort << '\t'
                      << m.data.size() << '\t' << payloadHex(m.data) << '\n';
            ++printed;
        }
    }
    spdlog::info("Dumped {} message(s)", printed);
}

} // namespace

void benchmarkRawRead(const std::string& filename)
{
    std::ifstream file(filename, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        spdlog::error("Could not open file {} for raw read benchmark", filename);
        return;
    }

    const size_t fileSize = file.tellg();
    file.seekg(0, std::ios::beg);

    constexpr size_t kBufSize = 1024 * 1024; // 1 MiB chunks
    std::vector<char> buf(kBufSize);

    auto start = std::chrono::high_resolution_clock::now();
    while (file.read(buf.data(), kBufSize) || file.gcount() > 0) {
        if (0 == file.gcount()) {
            break;
        }
    }
    auto end = std::chrono::high_resolution_clock::now();

    const double seconds = std::chrono::duration<double>(end - start).count();
    const double megabytes = static_cast<double>(fileSize) / (1024.0 * 1024.0);

    spdlog::info("--- Raw read benchmark ---");
    spdlog::info("File size : {:.2f} MiB", megabytes);
    spdlog::info("Read time : {:.3f} ms", seconds * 1000.0);
    spdlog::info("Throughput: {:.2f} MiB/s", megabytes / seconds);
}

// Evict a single file from the page cache.
void dropFileCache(const std::string& filename)
{
#ifdef _WIN32
    // Windows has no per-file cache eviction without admin privileges.
#elif defined(__APPLE__)
    int fd = open(filename.c_str(), O_RDONLY);
    if (fd < 0) {
        spdlog::warn("could not open file for cache drop");
        return;
    }

    off_t len = lseek(fd, 0, SEEK_END);
    if (len > 0) {
        void* mapped = mmap(nullptr, static_cast<size_t>(len), PROT_READ, MAP_SHARED, fd, 0);
        if (mapped == MAP_FAILED) {
            spdlog::warn("mmap failed for cache drop");
        } else {
            int ret = madvise(mapped, static_cast<size_t>(len), MADV_DONTNEED);
            if (ret != 0) {
                spdlog::warn("madvise failed ({})", ret);
            } else {
                spdlog::debug("Page cache dropped for file");
            }
            munmap(mapped, static_cast<size_t>(len));
        }
    }
    close(fd);
#else
    int fd = open(filename.c_str(), O_RDONLY);
    if (fd < 0) {
        spdlog::warn("could not open file for cache drop");
        return;
    }

    fdatasync(fd);
    off_t len = lseek(fd, 0, SEEK_END);
    if (len > 0) {
        int ret = posix_fadvise(fd, 0, len, POSIX_FADV_DONTNEED);
        if (ret != 0) {
            spdlog::warn("posix_fadvise failed ({})", ret);
        } else {
            spdlog::debug("Page cache dropped for file");
        }
    }
    close(fd);
#endif
}

int main(int argc, char* argv[])
{
    if (argc < 2) {
        spdlog::error("Usage: {} <filename> [--no-decompress] [--benchmark] "
                      "[--dump-objects] [--dump-messages [N]] [--debug]",
            argv[0]);
        return 1;
    }

    spdlog::set_level(spdlog::level::info);

    std::string filename = argv[1];
    fastrace::Analyzer analyzer;
    bool runBenchmark = false;
    bool dumpMessagesFlag = false;
    size_t dumpMessageLimit = 20;

    for (int i = 2; i < argc; ++i) {
        std::string arg = argv[i];
        if ("--no-decompress" == arg) {
            analyzer.skipDecompress = true;
        } else if ("--benchmark" == arg) {
            runBenchmark = true;
        } else if ("--dump-objects" == arg) {
            analyzer.dumpObjContents = true;
        } else if ("--dump-messages" == arg) {
            dumpMessagesFlag = true;
            if (i + 1 < argc) {
                char* end = nullptr;
                const unsigned long parsed = std::strtoul(argv[i + 1], &end, 10);
                if (end != argv[i + 1] && *end == '\0' && parsed > 0) {
                    dumpMessageLimit = parsed;
                    ++i;
                }
            }
        } else if ("--debug" == arg) {
            spdlog::set_level(spdlog::level::debug);
        }
    }

    if (dumpMessagesFlag) {
        dumpMessages(analyzer, filename, dumpMessageLimit);
        return 0;
    }

    if (analyzer.skipDecompress) {
        spdlog::info("*** --no-decompress: consumers will skip inflate() ***");
    }

    std::ifstream sizeProbe(filename, std::ios::binary | std::ios::ate);
    const size_t sizeBytes = sizeProbe.is_open() ? static_cast<size_t>(sizeProbe.tellg()) : 0;
    sizeProbe.close();
    const double sizeMegabytes = static_cast<double>(sizeBytes) / (1024.0 * 1024.0);

    // --- BLF processing ---
    // TODO: we want to drop caches only when measuring performance
    dropFileCache(filename);

    auto procStartTs = std::chrono::high_resolution_clock::now();
    analyzer.processFile(filename);
    auto procEndTs = std::chrono::high_resolution_clock::now();

    const double proc_s = std::chrono::duration<double>(procEndTs - procStartTs).count();

    // --- raw read benchmark (cold cache) ---
    if (runBenchmark) {
        dropFileCache(filename);
        benchmarkRawRead(filename);
    }

    // --- summary ---
    const double compMiB = static_cast<double>(analyzer.perf.compressedBytes) / (1024.0 * 1024.0);
    const double decompMiB = static_cast<double>(analyzer.perf.decompressedBytes) / (1024.0 * 1024.0);
    const double pipe_ms = analyzer.perf.pipelineUs * 1e-3;

    spdlog::info("--- BLF processing ---");
    spdlog::info("processFile took      {:.3f} ms", proc_s * 1000.0);
    spdlog::info("Avg processing speed: {:.2f} MiB/s (compressed throughput)", sizeMegabytes / proc_s);
    spdlog::info("--- Pipeline breakdown ---");
    spdlog::info("  Workers             : {}", analyzer.perf.nThreads);
    spdlog::info("  Containers          : {}", analyzer.perf.containers);
    spdlog::info("  Compressed in       : {:.2f} MiB", compMiB);
    spdlog::info("  Decompressed out    : {:.2f} MiB", decompMiB);
    spdlog::info("  Pipeline wall-clock : {:.3f} ms  (producer + consumers overlapped)", pipe_ms);
    if (!analyzer.skipDecompress && pipe_ms > 0.0) {
        spdlog::info("  Decomp throughput   : {:.2f} MiB/s compressed  /  {:.2f} "
                     "MiB/s uncompressed",
            compMiB / (pipe_ms * 1e-3), decompMiB / (pipe_ms * 1e-3));
    }
    spdlog::info("  Split objects       : {}  (reassembled by Stitcher thread; "
                 "add --debug for detail)",
        analyzer.perf.splitObjects);
    spdlog::info("--- Decoded objects (by type, sorted by count) ---");
    if (analyzer.perf.objectCounts.empty()) {
        spdlog::info("  (none — run without --no-decompress to decode objects)");
    } else {
        // Sort entries by count descending for readability
        std::vector<std::pair<uint32_t, uint64_t>> sorted(
            analyzer.perf.objectCounts.begin(), analyzer.perf.objectCounts.end());
        std::sort(sorted.begin(), sorted.end(), [](const auto& a, const auto& b) { return a.second > b.second; });

        for (const auto& [type, cnt] : sorted) {
            auto name = fastrace::objectTypeName(type);
            if (name.empty()) {
                spdlog::info("  [{:>3}] {:<36} : {}", type, std::format("UNKNOWN_{}", type), cnt);
            } else {
                spdlog::info("  [{:>3}] {:<36} : {}", type, name, cnt);
            }
        }
    }

    return 0;
}
