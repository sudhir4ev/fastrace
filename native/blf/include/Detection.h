#pragma once
#include <cstdint>
#include <map>
#include <string>

enum class Severity { Info, Warning, Error };

struct ByteRange {
    size_t offset;
    size_t length;
};

struct Detection {
    uint64_t timestampUs;
    std::string detectorName;
    Severity severity;
    std::string message;
    size_t messageIndex;
    ByteRange relatedBytes;
    std::map<std::string, std::string> context;
};
