#include "MappedFile.h"

#ifdef _WIN32
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <spdlog/spdlog.h>

MappedFile::MappedFile()
{
#ifdef _WIN32
#else
    addr = MAP_FAILED;
#endif
}

MappedFile::~MappedFile()
{
    if (prefault_thread.joinable()) {
        prefault_thread.join();
    }
#ifdef _WIN32
    if (addr) {
        UnmapViewOfFile(addr);
    }
    if (hMapping) {
        CloseHandle(hMapping);
    }
    if (hFile != INVALID_HANDLE_VALUE) {
        CloseHandle(hFile);
    }
#else
    if (addr != MAP_FAILED) {
        munmap(addr, size);
    }
#endif
}

bool MappedFile::open(const std::string& path)
{
#ifdef _WIN32
    hFile = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (INVALID_HANDLE_VALUE == hFile) {
        spdlog::error("Could not open file {}", path);
        return false;
    }

    LARGE_INTEGER fileSize;
    if (!GetFileSizeEx(hFile, &fileSize)) {
        spdlog::error("GetFileSizeEx failed for {}", path);
        return false;
    }
    size = static_cast<size_t>(fileSize.QuadPart);

    hMapping = CreateFileMappingA(hFile, NULL, PAGE_READONLY, 0, 0, NULL);
    if (NULL == hMapping) {
        spdlog::error("CreateFileMapping failed for {}", path);
        return false;
    }

    addr = MapViewOfFile(hMapping, FILE_MAP_READ, 0, 0, 0);
    if (NULL == addr) {
        spdlog::error("MapViewOfFile failed for {}", path);
        return false;
    }

    prefault_thread = std::thread([this]() {
        HMODULE hKernel32 = GetModuleHandleA("kernel32.dll");
        if (hKernel32) {
            typedef BOOL(WINAPI * PrefetchVirtualMemory_t)(HANDLE, ULONG_PTR, PVOID, ULONG);
            auto pPrefetch = (PrefetchVirtualMemory_t)GetProcAddress(hKernel32, "PrefetchVirtualMemory");
            if (pPrefetch) {
                struct {
                    PVOID VirtualAddress;
                    SIZE_T NumberOfBytes;
                } entry = { addr, size };
                pPrefetch(GetCurrentProcess(), 1, &entry, 0);
                return;
            }
        }
        // Fallback: manually fault pages
        const size_t pageSize = 4096;
        volatile char* p = static_cast<volatile char*>(addr);
        for (size_t i = 0; i < size; i += pageSize) {
            char c = p[i];
            (void)c;
        }
    });
#else
    int fd = ::open(path.c_str(), O_RDONLY);
    if (fd < 0) {
        spdlog::error("Could not open file {}", path);
        return false;
    }

    struct stat st {};
    if (fstat(fd, &st) != 0) {
        spdlog::error("fstat failed for {}", path);
        close(fd);
        return false;
    }
    size = static_cast<size_t>(st.st_size);

    // Map without MAP_POPULATE so mmap returns immediately.
    addr = ::mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (MAP_FAILED == addr) {
        spdlog::error("mmap failed for {}", path);
        return false;
    }

    // Start dedicated background thread to pre-fault pages at full I/O bandwidth.
    // MADV_POPULATE_READ (Linux 5.14+) synchronously populates page tables,
    // acting exactly like MAP_POPULATE but off the main thread.
    prefault_thread = std::thread([this]() {
#ifndef MADV_POPULATE_READ
#define MADV_POPULATE_READ 22
#endif
        int ret = madvise(addr, size, MADV_POPULATE_READ);
        if (ret != 0) {
            // Fallback to sequential read-ahead
            madvise(addr, size, MADV_SEQUENTIAL);
            madvise(addr, size, MADV_WILLNEED);
        }
    });
#endif
    return true;
}

Cursor MappedFile::cursor() const noexcept
{
    const char* b = static_cast<const char*>(addr);
    return Cursor { b, b + size, b };
}
