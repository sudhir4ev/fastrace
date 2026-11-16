#pragma once

#include <string>
#include <thread>

#include "Cursor.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

struct MappedFile {
#ifdef _WIN32
    void* addr = nullptr;
    HANDLE hFile = INVALID_HANDLE_VALUE;
    HANDLE hMapping = NULL;
#else
    void* addr;
#endif
    size_t size = 0;
    std::thread prefault_thread;

    MappedFile();
    ~MappedFile();
    MappedFile(const MappedFile&) = delete;
    MappedFile& operator=(const MappedFile&) = delete;

    bool open(const std::string& path);
    Cursor cursor() const noexcept;
};
