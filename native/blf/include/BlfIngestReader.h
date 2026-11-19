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
    using ContainerHandler = std::function<void(
        uint64_t ord, uint64_t byteOffset, int64_t firstTsUs, int64_t lastTsUs, uint64_t msgCount)>;

    struct Stats {
        uint64_t containers = 0;
        uint64_t messages = 0;
        uint64_t splitObjects = 0;
        uint64_t bytesRead = 0; // byte offset into the file after the last fully-inflated container
        uint64_t fileSizeBytes = 0; // total mapped file size, set once at visit() start
        int64_t inflateDecodeUs = 0; // wall time in visit's inflate+decode loop
    };

    /// mmap + walk. onContainer (optional) fires once per non-empty container
    /// after its messages are emitted. Returns false on open/header failure.
    bool visit(const std::string& blfPath, MessageHandler onMessage, ContainerHandler onContainer = nullptr);

    /// Walk only containers in the byte range [startByteOffset, endByteOffset).
    /// startByteOffset must be a LOBJ signature offset from container_index
    /// (or 0 for the first container). endByteOffset may be UINT64_MAX for "to
    /// EOF". Returns false on open/header failure.
    bool visitRange(
        const std::string& blfPath, uint64_t startByteOffset, uint64_t endByteOffset, MessageHandler onMessage);

    const Stats& stats() const { return m_stats; }

private:
    bool visitImpl(const std::string& blfPath, uint64_t startByteOffset, uint64_t endByteOffset,
        MessageHandler onMessage, ContainerHandler onContainer);

    Stats m_stats;
};

} // namespace fastrace
