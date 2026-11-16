#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <vector>

struct WorkQueue {
    struct Item {
        const char* compData;
        size_t compSize;
        uint64_t containerIndex;
        size_t fileOffset;
    };

    explicit WorkQueue(size_t cap);

    // Called by producer.  Blocks if the queue is full.
    // Returns false (without pushing) if `cancelled` becomes true while waiting.
    bool push(Item item, const std::atomic<bool>& cancelled);

    // Called by consumers.  Returns nullopt when closed AND empty.
    std::optional<Item> pop();

    // Signal that no more items will be pushed.  Wakes all waiting consumers.
    void close();

    // Wake a blocked producer so it can re-check the cancelled flag.
    void wakeProducer();

private:
    const size_t cap_;
    std::vector<Item> ring_;
    size_t head_ = 0;
    size_t tail_ = 0;
    size_t count_ = 0;
    bool closed_ = false;
    std::mutex mu_;
    std::condition_variable cvWork_; // consumers wait here
    std::condition_variable cvSpace_; // producer waits here
};
