// Regression test for the msg_id alignment invariant visitRange + container_index
// must satisfy (the plan's highest-risk item). Builds a 2-container BLF whose
// second container OPENS with a cross-container split object, so container 1's
// first *reproducible* message is NOT the stitched one. A ranged decode that
// starts at container 1 (empty pendingTail) drops the stitched message, so the
// id it seeds from container_index must point at container 1's first OWN message,
// not the stitched one - otherwise every appended signals.msg_id is shifted.
#include "BlfIngestReader.h"

#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <vector>

#include <libdeflate.h>

namespace {
using Bytes = std::vector<uint8_t>;

void le16(Bytes& b, uint16_t v)
{
    b.push_back(v & 0xFF);
    b.push_back((v >> 8) & 0xFF);
}
void le32(Bytes& b, uint32_t v)
{
    for (int i = 0; i < 4; ++i) {
        b.push_back((v >> (8 * i)) & 0xFF);
    }
}
void le64(Bytes& b, uint64_t v)
{
    for (int i = 0; i < 8; ++i) {
        b.push_back((v >> (8 * i)) & 0xFF);
    }
}
void pad(Bytes& b, size_t n) { b.insert(b.end(), n, 0); }

// 32-byte inner LOBJ header (base 16 + BlfObjectHeader 16), flags=0x2 -> ts/1000.
void canMessage(Bytes& b, uint64_t timestampNs, uint32_t arbId)
{
    Bytes payload;
    le16(payload, 1); // channel
    payload.push_back(8); // dlc
    payload.push_back(0); // flags
    le32(payload, arbId);
    pad(payload, 8); // 8 data bytes
    b.push_back('L');
    b.push_back('O');
    b.push_back('B');
    b.push_back('J');
    le16(b, 32); // headerSize
    le16(b, 1); // headerVersion
    le32(b, 32 + static_cast<uint32_t>(payload.size())); // objectSize
    le32(b, 1); // objectType = CAN_MESSAGE
    le32(b, 2); // flags = 0x2
    le16(b, 0);
    le16(b, 0);
    le64(b, timestampNs);
    b.insert(b.end(), payload.begin(), payload.end());
}

Bytes zlib(const Bytes& in)
{
    auto* c = libdeflate_alloc_compressor(6);
    Bytes out(in.size() + 1024);
    size_t n = libdeflate_zlib_compress(c, in.data(), in.size(), out.data(), out.size());
    out.resize(n);
    libdeflate_free_compressor(c);
    return out;
}

void appendContainer(Bytes& file, const Bytes& inner)
{
    const Bytes comp = zlib(inner);
    file.push_back('L');
    file.push_back('O');
    file.push_back('B');
    file.push_back('J');
    le16(file, 32); // headerSize
    le16(file, 1); // headerVersion
    le32(file, 48 + static_cast<uint32_t>(comp.size())); // objectSize: 32 hdr + 16 pad + zlib
    le32(file, 10); // objectType = LOG_CONTAINER
    pad(file, 16); // placeholder region (unread)
    file.insert(file.end(), comp.begin(), comp.end());
}

Bytes buildSplitBlf()
{
    // Three CAN objects of 48 bytes each (32 header + 16 payload); distinct ts.
    Bytes a, bMsg, c;
    canMessage(a, 1000, 0x100); // ts 1us
    canMessage(bMsg, 5000, 0x200); // ts 5us  -> the split (stitched) message
    canMessage(c, 9000, 0x300); // ts 9us  -> container 1's first OWN message

    // Container 0: A + first 20 bytes of B. Container 1: B remainder + C.
    Bytes inner0 = a;
    inner0.insert(inner0.end(), bMsg.begin(), bMsg.begin() + 20);
    Bytes inner1(bMsg.begin() + 20, bMsg.end());
    inner1.insert(inner1.end(), c.begin(), c.end());

    Bytes file;
    file.push_back('L');
    file.push_back('O');
    file.push_back('G');
    file.push_back('G');
    le32(file, 80); // headerSize == sizeof(BlfFileHeader), so no extra skip
    le32(file, 0); // apiVersion
    file.push_back(0); // appId
    file.push_back(0); // compressionLevel
    file.push_back(1); // majorVersion
    file.push_back(1); // minorVersion
    le64(file, 0); // compressedSize (unread)
    le64(file, 0); // uncompressedSize (unread)
    le32(file, 0); // numObj (unread)
    le32(file, 0); // appBuildId
    pad(file, 16);
    pad(file, 16);
    le64(file, 0);

    appendContainer(file, inner0);
    appendContainer(file, inner1);
    return file;
}
} // namespace

int main()
{
    int failures = 0;
    auto expect = [&](bool cond, const char* msg) {
        if (!cond) {
            std::fprintf(stderr, "FAIL: %s\n", msg);
            ++failures;
        }
    };

    const auto path = std::filesystem::temp_directory_path() / "fastrace_msgid_split.blf";
    {
        const Bytes blf = buildSplitBlf();
        std::ofstream(path, std::ios::binary).write(reinterpret_cast<const char*>(blf.data()), blf.size());
    }

    // Full visit: record each message's ts in emit order, and per container its
    // byte offset + the count param + the running emit count at callback time.
    std::vector<int64_t> fullTs;
    struct Ci {
        uint64_t ord, off, count, emitAfter;
    };
    std::vector<Ci> cis;
    uint64_t emitted = 0;
    fastrace::BlfIngestReader full;
    const bool okFull = full.visit(
        path.string(),
        [&](const fastrace::TraceMessage& m) {
            fullTs.push_back(static_cast<int64_t>(m.timestampUs));
            ++emitted;
        },
        [&](uint64_t ord, uint64_t off, int64_t, int64_t, uint64_t count) {
            cis.push_back({ ord, off, count, emitted });
        });
    expect(okFull, "full visit ok");
    expect(fullTs.size() == 3, "full visit emits 3 messages (A, stitched B, C)");
    expect(cis.size() == 2, "two containers reported");

    // The split message (ts 5) must be the stitched one: emit order A(1), B(5), C(9).
    expect(
        fullTs.size() == 3 && fullTs[0] == 1 && fullTs[1] == 5 && fullTs[2] == 9, "emit order is A=1, B(split)=5, C=9");

    // Seed container 1 the way runApplyTrim does: first_msg_id = emitAfter - count.
    const Ci& c1 = cis[1];
    const uint64_t seed = c1.emitAfter - c1.count;

    // A ranged decode starting at container 1 reproduces C first (stitched B dropped).
    int64_t firstRangedTs = -1;
    fastrace::BlfIngestReader ranged;
    ranged.visitRange(path.string(), c1.off, UINT64_MAX, [&](const fastrace::TraceMessage& m) {
        if (firstRangedTs < 0) {
            firstRangedTs = static_cast<int64_t>(m.timestampUs);
        }
    });
    expect(firstRangedTs == 9, "ranged visit at container 1 reproduces C (ts 9) first");

    // The invariant: the message the seed points at (in full-visit order) must be
    // the same message the ranged visit actually produces first. With the bug the
    // seed points at B (ts 5), off by the one stitched message.
    expect(seed < fullTs.size(), "seed in range");
    if (seed < fullTs.size()) {
        expect(fullTs[seed] == firstRangedTs,
            "container_index first_msg_id aligns with the first ranged-reproduced message");
    }

    std::error_code ec;
    std::filesystem::remove(path, ec);

    if (failures > 0) {
        std::fprintf(stderr, "%d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("visit_range_msgid_test: OK\n");
    return 0;
}
