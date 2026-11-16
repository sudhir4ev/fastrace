#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "ArxmlTypes.h"
#include "MappedFile.h"
#include "TraceMessage.h"

namespace fastrace {

struct ChunkEntry {
    size_t fileOffset; // byte offset of container in mmap
    uint64_t containerIndex; // 0-based container sequence number
    uint32_t skipMessages; // messages before chunk start inside the container
};

enum class ProtocolGroup : uint8_t { CAN, Ethernet, COUNT };

struct HistogramData {
    uint64_t binWidthUs = 0;
    uint64_t traceStartUs = 0;
    uint64_t traceEndUs = 0;
    std::array<std::vector<uint32_t>, static_cast<size_t>(ProtocolGroup::COUNT)> bins;
};

struct PerfCounters {
    uint64_t containers = 0;
    uint64_t compressedBytes = 0;
    uint64_t decompressedBytes = 0;
    uint64_t splitObjects = 0;
    int64_t pipelineUs = 0;
    size_t nThreads = 0;
    std::unordered_map<uint32_t, uint64_t> objectCounts;
};

std::string_view objectTypeName(uint32_t t);

struct SignalBin {
    uint64_t timestampUs = 0;
    uint64_t minRaw = UINT64_MAX;
    uint64_t maxRaw = 0;
    bool hasData = false;
};

class Analyzer {
public:
    bool skipDecompress = false;
    bool dumpObjContents = false;
    bool collectMessages = false;
    size_t maxMessages = 100'000;

    // ── Async loading support ────────────────────────────────────────────────
    /// Set to true by the UI thread to request early termination of processFile.
    std::atomic<bool> cancelled { false };
    /// Set to true by the UI thread to request early termination of buildHistogram.
    std::atomic<bool> histogramCancelled { false };
    /// Number of chunks processed so far in buildHistogram.
    std::atomic<size_t> histogramChunksProcessed { 0 };
    /// Bytes consumed by the producer so far (updated each container push).
    std::atomic<size_t> bytesRead { 0 };
    /// Total file size in bytes; set once at the start of processFile.
    std::atomic<size_t> totalBytes { 0 };
    /// Messages appended to `messages` so far; incremented lock-free after
    /// push_back.
    std::atomic<size_t> messagesCollected { 0 };

    // ── Database async-load progress ─────────────────────────────────────────
    std::atomic<float> dbLoadProgress { 0.0f };
    std::atomic<bool> dbLoadCancelled { false };

    PerfCounters perf;
    std::vector<TraceMessage> messages;
    std::mutex messagesMu;

    static constexpr size_t CHUNK_SIZE = 10'000;

    size_t buildIndex(const std::string& filename);

    const std::vector<ChunkEntry>& getChunkIndex() const { return chunkIndex_; }
    const HistogramData& histogram() const { return histogram_; }
    std::vector<TraceMessage> decodeChunk(size_t chunkIndex) const;
    size_t totalMessages() const noexcept { return totalMessages_; }

    void buildHistogram(int numBins);

    void processFile(const std::string& filename);

    void loadDatabase(const std::string& path);
    void clearDatabase();
    void reset();
    const ArDatabase& arDatabase() const { return m_arDatabase_; }

    void buildSignalTimeSeries(const std::string& iSignalName, int numBins, std::vector<SignalBin>& out);

    /// Range-bounded variant: only bins within [startUs, endUs] are computed.
    /// Equivalent to buildSignalTimeSeries when startUs==0 && endUs==0.
    void buildSignalTimeSeriesRange(
        const std::string& iSignalName, int numBins, std::vector<SignalBin>& out, uint64_t startUs, uint64_t endUs);

private:
    std::vector<ChunkEntry> chunkIndex_;
    HistogramData histogram_;
    size_t totalMessages_ = 0;
    MappedFile mf_;
    ArDatabase m_arDatabase_;
};

} // namespace fastrace
