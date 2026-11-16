#pragma once
#include <cstddef>
#include <cstring>

// Cursor – lightweight read-cursor over a contiguous memory region.
struct Cursor {
    const char* base;
    const char* end;
    const char* pos;

    bool eof() const noexcept { return pos >= end; }
    size_t tell() const noexcept { return static_cast<size_t>(pos - base); }
    size_t remaining() const noexcept { return static_cast<size_t>(end - pos); }

    bool read(void* dst, size_t n) noexcept
    {
        if (pos + n > end) {
            return false;
        }
        std::memcpy(dst, pos, n);
        pos += n;
        return true;
    }

    const char* peek(size_t n) noexcept
    {
        if (pos + n > end) {
            return nullptr;
        }
        const char* p = pos;
        pos += n;
        return p;
    }

    bool skip(size_t n) noexcept
    {
        if (pos + n > end) {
            return false;
        }
        pos += n;
        return true;
    }
};
