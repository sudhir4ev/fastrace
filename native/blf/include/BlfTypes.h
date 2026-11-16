#pragma once
#include <cstdint>

#pragma pack(push, 1)
typedef struct {
    uint16_t year;
    uint16_t month;
    uint16_t dayOfWeek;
    uint16_t day;
    uint16_t hour;
    uint16_t minute;
    uint16_t second;
    uint16_t milliseconds;
} BlfTimeStamp;

typedef struct {
    char signature[4];
    uint32_t headerSize;
    uint32_t apiVersion;
    uint8_t appId;
    uint8_t compressionLevel;
    uint8_t majorVersion;
    uint8_t minorVersion;
    uint64_t compressedSize;
    uint64_t uncompressedSize;
    uint32_t numObj;
    uint32_t appBuildId;
    BlfTimeStamp measurementStartTime;
    BlfTimeStamp measurementEndTime;
    uint64_t nextRestorepoint;
} BlfFileHeader;

typedef struct {
    uint32_t signature; // "LOBJ"
    uint16_t headerSize;
    uint16_t headerVersion;
    uint32_t objectSize;
    uint32_t objectType;
} BlfObjectHeaderBase;

typedef struct {
    uint32_t flags;
    uint16_t staticSize;
    uint16_t version;
    uint64_t timestamp;
} BlfObjectHeader;

// CAN_MESSAGE (type 1) and CAN_MESSAGE2 (type 86) share the same payload
// layout. Wire order: channel, dlc, flags, id, data[dlc]  (only up to 8 bytes
// for classic CAN).
struct CANMessage {
    uint16_t channel; // 1-based channel index
    uint8_t dlc; // data length code (0-8)
    uint8_t flags; // TX=0x04, remote frame=0x10, etc.
    uint32_t id; // arbitration id; bit 31 set → extended (29-bit)
    uint8_t data[8]; // payload (only dlc bytes are valid)
};
using CANMessage2 = CANMessage; // type 86 shares the same layout

// CAN_FD_MESSAGE (type 100) fixed header; always followed by data[64] (padded
// with zeros). Total payload is always 88 bytes (24-byte header + 64-byte
// data).
struct CANFDMessage {
    uint16_t channel; // 1-based channel index
    uint8_t flags; // 0x00=Rx
    uint8_t dlc; // raw CAN FD DLC code (0-15)
    uint32_t arbId; // bit 31 set → extended 29-bit ID
    uint32_t frameLength; // frame length in ns (0 if not measured)
    uint16_t btrCfgArb; // arbitration bit-timing config
    uint8_t validDataBytes; // actual data byte count (DLC→length mapped)
    uint8_t dir; // 0=Rx, 1=Tx, 2=TxRq
    uint8_t reserved[8];
    // uint8_t data[64] follows (always 64 bytes; zeros beyond validDataBytes)
};
static_assert(sizeof(CANFDMessage) == 24);

// CAN_FD_MESSAGE_64 (type 101) fixed header; variable-length data follows.
// payloadBytes = sizeof(CANFDMessage64) + validDataBytes (padded to next 4-byte
// boundary).
// based on blf header definition in wireshark
struct CANFDMessage64 {
    uint8_t channel; // 1-based channel index
    uint8_t dlc; // raw CAN FD DLC code (0-15)
    uint8_t validDataBytes; // actual data byte count
    uint8_t txCount; // transmit count
    uint32_t arbId; // bit 31 set → extended 29-bit ID
    uint32_t frameLength; // frame length in ns
    uint32_t flags; // bit 12: BRS, bit 13: EDL, bits 20-21: channel variant
    uint32_t btrCfgArb; // arbitration bit-timing config
    uint32_t btrCfgData; // data-phase bit-timing config
    uint32_t timeOffsetBrsNs; // BRS bit time offset in ns
    uint32_t timeOffsetCrcDelNs; // CRC delimiter time offset in ns
    uint16_t bitCount; // total bit count of frame
    uint8_t dir; // 0=Rx, 1=Tx, 2=TxRq
    uint8_t extDataOffset; // byte offset to secondary payload (0 if none)
                           // remaining bytes: reserved + data[validDataBytes] (padded to 4-byte
                           // boundary)
    uint32_t crc; // CRC of the CAN FD frame
};
static_assert(sizeof(CANFDMessage64) == 40);

// ETHERNET_FRAME_EX (type 121) fixed header; variable Ethernet payload follows.
struct EthernetFrameExHeader {
    uint16_t structLength; // total size of this header struct
    uint16_t flags; // frame flags
    uint16_t channel; // 1-based channel index
    uint16_t dir; // 0=Rx, 1=Tx, 2=TxRq
    uint64_t reserved;
    uint32_t asin; // AUTOSAR service instance number
    uint32_t frameChecksum; // Ethernet FCS
    uint16_t etherType; // EtherType of the payload
    uint16_t payloadLen; // byte count of Ethernet payload that follows
    uint32_t payloadFcs; // FCS over payload
                         // payloadLen bytes of raw Ethernet payload follow immediately
};
static_assert(sizeof(EthernetFrameExHeader) == 32);

// ETHERNET_FRAME (type 120) fixed header; raw Ethernet payload follows
// immediately. Note: no MAC addresses in the BLF struct — those live inside the
// raw payload bytes.
struct EthernetFrameHeader {
    uint16_t structLength; // remaining header bytes after this field (= 30)
    uint16_t flags;
    uint16_t channel; // 1-based channel index
    uint16_t direction; // 0=Rx, 1=Tx, 2=TxRq
    uint64_t reserved;
    uint16_t ethType; // EtherType (mirrors the value inside the raw payload)
    uint16_t tpid; // VLAN TPID
    uint16_t tci; // VLAN TCI
    uint16_t payloadLength; // byte count of raw Ethernet payload that follows
    uint64_t res2;
    // payloadLength bytes of raw Ethernet frame data (dst MAC, src MAC,
    // EtherType, ...) follow
};
#pragma pack(pop)

// All known BLF object type IDs (sourced from vector_blf / python-can /
// Wireshark blf.h). Values are assigned by Vector Informatik and are stable
// across tool versions.
enum BLFObjectType : uint32_t {
    UNKNOWN = 0,
    CAN_MESSAGE = 1,
    CAN_ERROR = 2,
    CAN_OVERLOAD = 3,
    CAN_STATISTIC = 4,
    APP_TRIGGER = 5,
    ENV_INTEGER = 6,
    ENV_DOUBLE = 7,
    ENV_STRING = 8,
    ENV_DATA = 9,
    LOG_CONTAINER = 10,
    LIN_MESSAGE = 11,
    LIN_CRC_ERROR = 12,
    LIN_DLC_INFO = 13,
    LIN_RCV_ERROR = 14,
    LIN_SND_ERROR = 15,
    LIN_SLV_TIMEOUT = 16,
    LIN_SCHED_MODCH = 17,
    LIN_SYN_ERROR = 18,
    LIN_BAUDRATE = 19,
    LIN_SLEEP = 20,
    LIN_WAKEUP = 21,
    MOST_SPY = 22,
    MOST_CTRL = 23,
    MOST_LIGHTLOCK = 24,
    MOST_STATISTIC = 25,
    Reserved26 = 26,
    Reserved27 = 27,
    Reserved28 = 28,
    FLEXRAY_DATA = 29,
    FLEXRAY_SYNC = 30,
    CAN_DRIVER_ERROR = 31,
    MOST_PKT = 32,
    MOST_PKT2 = 33,
    MOST_HWMODE = 34,
    MOST_REG = 35,
    MOST_GENREG = 36,
    MOST_NETSTATE = 37,
    MOST_DATALOST = 38,
    MOST_TRIGGER = 39,
    FLEXRAY_CYCLE = 40,
    FLEXRAY_MESSAGE = 41,
    LIN_CHECKSUM_INFO = 42,
    LIN_SPIKE_EVENT = 43,
    CAN_DRIVER_SYNC = 44,
    FLEXRAY_STATUS = 45,
    GPS_EVENT = 46,
    FR_ERROR = 47,
    FR_STATUS = 48,
    FR_STARTCYCLE = 49,
    FR_RCVMESSAGE = 50,
    REALTIMECLOCK = 51,
    Reserved52 = 52,
    Reserved53 = 53,
    LIN_STATISTIC = 54,
    J1708_MESSAGE = 55,
    J1708_VIRTUAL_MSG = 56,
    LIN_MESSAGE2 = 57,
    LIN_SND_ERROR2 = 58,
    LIN_SYN_ERROR2 = 59,
    LIN_CRC_ERROR2 = 60,
    LIN_RCV_ERROR2 = 61,
    LIN_WAKEUP2 = 62,
    LIN_SPIKE_EVENT2 = 63,
    LIN_LONG_DOM_SIG = 64,
    APP_TEXT = 65,
    FR_RCVMESSAGE_EX = 66,
    MOST_STATISTICEX = 67,
    MOST_TXLIGHT = 68,
    MOST_ALLOCTAB = 69,
    MOST_STRESS = 70,
    ETHERNET_FRAME = 71,
    SYS_VARIABLE = 72,
    CAN_ERROR_EXT = 73,
    CAN_DRIVER_ERROR_EXT = 74,
    LIN_LONG_DOM_SIG2 = 75,
    MOST_150_MESSAGE = 76,
    MOST_150_PKT = 77,
    MOST_ETHERNET_PKT = 78,
    MOST_150_MESSAGE_FRAGMENT = 79,
    MOST_150_PKT_FRAGMENT = 80,
    MOST_ETHERNET_PKT_FRAGMENT = 81,
    MOST_SYSTEM_EVENT = 82,
    MOST_150_ALLOCTAB = 83,
    MOST_50_MESSAGE = 84,
    MOST_50_PKT = 85,
    CAN_MESSAGE2 = 86,
    LIN_UNEXPECTED_WAKEUP = 87,
    LIN_SHORT_OR_SLOW_RESPONSE = 88,
    LIN_DISTURBANCE_EVENT = 89,
    SERIAL_EVENT = 90,
    OVERRUN_ERROR = 91,
    EVENT_COMMENT = 92,
    WLAN_FRAME = 93,
    WLAN_STATISTIC = 94,
    MOST_ECL = 95,
    GLOBAL_MARKER = 96,
    AFDX_FRAME = 97,
    AFDX_STATISTIC = 98,
    KLINE_STATUSEVENT = 99,
    CAN_FD_MESSAGE = 100,
    CAN_FD_MESSAGE_64 = 101,
    ETHERNET_RX_ERROR = 102,
    ETHERNET_STATUS = 103,
    CAN_FD_ERROR_64 = 104,
    LIN_SHORT_OR_SLOW_RESPONSE2 = 105,
    AFDX_STATUS = 106,
    AFDX_BUS_STATISTIC = 107,
    Reserved108 = 108,
    AFDX_ERROR_EVENT = 109,
    A429_ERROR = 110,
    A429_STATUS = 111,
    A429_BUS_STATISTIC = 112,
    A429_MESSAGE = 113,
    ETHERNET_STATISTIC = 114,
    Unknown115 = 115,
    Reserved116 = 116,
    Reserved117 = 117,
    TEST_STRUCTURE = 118,
    DIAG_REQUEST_INTERPRETATION = 119,
    ETHERNET_FRAME_EX = 120,
    ETHERNET_FRAME_FORWARDED = 121,
    ETHERNET_ERROR_EX = 122,
    ETHERNET_ERROR_FORWARDED = 123,
    FUNCTION_BUS = 124,
    DATA_LOST_BEGIN = 125,
    DATA_LOST_END = 126,
    WATER_MARK_EVENT = 127,
    TRIGGER_CONDITION = 128,
    CAN_SETTING_CHANGED = 129,
    DISTRIBUTED_OBJECT_MEMBER = 130,
    ATTRIBUTE_EVENT = 131,
};
