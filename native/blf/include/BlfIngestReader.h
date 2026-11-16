#pragma once

#include <cstdint>
#include <functional>
#include <string>

#include "TraceMessage.h"

namespace fastrace {

/// Sequential BLF walker for ingest: one LOG_CONTAINER at a time, inflate,
/// decode, stitch cross-container splits, emit TraceMessage in file order.
/// Independent of Analyzer's parallel pipeline / decodeChunk.
class BlfIngestReader {
public:
    using MessageHandler = std::function<void(const TraceMessage& msg)>;

    struct Stats {
        uint64_t containers = 0;
        uint64_t messages = 0;
        uint64_t splitObjects = 0;
        int64_t inflateDecodeUs = 0; // wall time in visit's inflate+decode loop
    };

    /// mmap + walk. Returns false on open/header failure.
    bool visit(const std::string& blfPath, MessageHandler onMessage);

    const Stats& stats() const { return m_stats; }

private:
    Stats m_stats;
};

} // namespace fastrace
