#include "WorkQueue.h"

WorkQueue::WorkQueue(size_t cap)
    : cap_(cap)
    , ring_(cap)
{
}

bool WorkQueue::push(Item item, const std::atomic<bool>& cancelled)
{
    std::unique_lock<std::mutex> lk(mu_);
    // Wait until there is space OR we are cancelled.
    cvSpace_.wait(lk, [&] { return count_ < cap_ || cancelled.load(std::memory_order_relaxed); });
    if (cancelled.load(std::memory_order_relaxed)) {
        return false;
    }
    ring_[tail_] = item;
    tail_ = (tail_ + 1) % cap_;
    ++count_;
    cvWork_.notify_one();
    return true;
}

std::optional<WorkQueue::Item> WorkQueue::pop()
{
    std::unique_lock<std::mutex> lk(mu_);
    cvWork_.wait(lk, [&] { return count_ > 0 || closed_; });
    if (0 == count_) {
        return std::nullopt;
    }
    Item item = ring_[head_];
    head_ = (head_ + 1) % cap_;
    --count_;
    cvSpace_.notify_one();
    return item;
}

void WorkQueue::close()
{
    std::unique_lock<std::mutex> lk(mu_);
    closed_ = true;
    cvWork_.notify_all();
}

void WorkQueue::wakeProducer()
{
    // Notify the space CV so a blocked push() re-evaluates its condition
    // (which now includes the cancelled flag).
    cvSpace_.notify_all();
}
