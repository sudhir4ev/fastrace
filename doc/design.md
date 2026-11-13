# Fastrace C++ Parser Design

## Requirements

The core goal of `fastrace_cpp` is to parse Vector BLF (Binary Log File) files at extremely high throughput. The parser must meet the following requirements:
- **Parallel Decompression**: Decompress `CONTAINER` (type 10) payloads concurrently using multiple worker threads.
- **High Performance**: Minimize memory allocations and data copying. Operate directly on decompressed memory buffers that fit well within the CPU's L3 cache.
- **Accurate Log Object Decoding**: Correctly identify and decode embedded inner log objects (LOBJs) such as CAN messages (`CAN_MESSAGE`, `CAN_MESSAGE2`) and Ethernet frames (`ETHERNET_FRAME`).
- **Cross-Container Split Assembly**: Handle cases where a single LOBJ is split across two contiguous compressed container boundaries (e.g. the header and part of the payload are at the tail of container $N$, and the rest of the payload is at the head of container $N+1$).
- **Lock-Free Hot Path**: Cross-container assembly must avoid serializing the decompression pipeline or using expensive inter-thread synchronization during normal object processing.

## Architecture & Design

### Pipeline Overview

The system uses a single-producer, multi-consumer pipeline designed to overlap file I/O with decompression compute:

1. **Producer Thread** (Main Thread):
   - Memory-maps the file (`MappedFile`) and uses OS-level pre-fetching (`MADV_POPULATE_READ` / `PrefetchVirtualMemory`).
   - Scans the file sequentially to find `CONTAINER` LOBJs.
   - Assigns a monotonically increasing `containerIndex` to each container.
   - Pushes `{compData, compSize, containerIndex}` structs into a bounded, thread-safe `WorkQueue`.

2. **Consumer Threads**:
   - Pop compressed containers from the `WorkQueue`.
   - Decompress the payload into a persistent, per-thread scratch buffer (minimizing allocations).
   - Parse all fully-contained inner LOBJs directly from the scratch buffer.
   - Accumulate statistics locally and merge them once at thread exit to avoid lock contention.

### Cross-Container Split Handling: The Stitcher Thread

To handle split LOBJs without stalling the parallel consumer threads, the parser uses an asynchronous **Stitcher Thread** approach.

When a consumer processes a decompressed container (with `containerIndex = i`), it performs the following checks:
- **Head Fragment Detection**: If the beginning of the decompressed buffer does not start with an `"LOBJ"` signature, it means the buffer begins with the remainder of an object from the previous container. The consumer extracts these initial bytes and pushes them as a `HeadFragment{i, bytes}` to a lock-free or low-contention `FragmentQueue`.
- **Tail Fragment Detection**: If the consumer reaches the end of the buffer and detects an incomplete object (i.e. `objectEnd > dataLen`), it extracts those trailing bytes and pushes them as a `TailFragment{i, bytes}` to the `FragmentQueue`.

**Stitcher Thread Execution**:
- A dedicated background Stitcher Thread runs concurrently with the Consumers.
- It consumes `HeadFragment` and `TailFragment` messages from the `FragmentQueue`.
- It maintains an internal reassembly state. When it receives both a `TailFragment` for container `i` and a `HeadFragment` for container `i+1`, it concatenates the two byte arrays.
- The Stitcher Thread then runs the standard `processInnerObjects` logic on the reassembled, contiguous buffer to decode the stitched log object.
- It maintains its own local counters and merges them into the global statistics upon completion.

### Advantages of this Design

- **Zero Wait**: Consumer threads never have to wait for each other. Container $i+1$ can be fully processed before container $i$ finishes decompression.
- **Isolated Complexity**: The complex logic of matching boundaries and reassembling bytes is isolated to a single Stitcher Thread, keeping the Consumer hot-path extremely simple and fast.
- **Low Overhead**: Splits occur relatively rarely (typically a few dozen times per GB). The overhead of copying fragment bytes and pushing to the `FragmentQueue` is negligible compared to the total throughput.
