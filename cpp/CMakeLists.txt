cmake_minimum_required(VERSION 3.20)
project(fastrace_cpp VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Default to RelWithDebInfo build type if not specified
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE "RelWithDebInfo" CACHE STRING "Choose the type of build." FORCE)
endif()

# Dependencies
include(FetchContent)

FetchContent_Declare(
  spdlog
  GIT_REPOSITORY https://github.com/gabime/spdlog.git
  GIT_TAG        v1.15.3
)
FetchContent_Declare(
  libdeflate
  GIT_REPOSITORY https://github.com/ebiggers/libdeflate.git
  GIT_TAG        v1.25
)
set(LIBDEFLATE_BUILD_GZIP OFF CACHE BOOL "" FORCE)
set(LIBDEFLATE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(spdlog libdeflate)

FetchContent_Declare(
  pugixml
  GIT_REPOSITORY https://github.com/zeux/pugixml.git
  GIT_TAG        v1.14
)
FetchContent_MakeAvailable(pugixml)

FetchContent_Declare(
  sqlite_amalgamation
  URL      https://www.sqlite.org/2026/sqlite-amalgamation-3530200.zip
  URL_HASH SHA3_256=81142986038e18f96c4a54e1a72562ae17e502a916f2a7701eff43388cbf1a40
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
if(POLICY CMP0169)
  cmake_policy(SET CMP0169 OLD)
endif()
FetchContent_GetProperties(sqlite_amalgamation)
if(NOT sqlite_amalgamation_POPULATED)
  FetchContent_Populate(sqlite_amalgamation)
endif()
if(POLICY CMP0169)
  cmake_policy(SET CMP0169 NEW)
endif()

add_library(sqlite3_amalg STATIC ${sqlite_amalgamation_SOURCE_DIR}/sqlite3.c)
target_include_directories(sqlite3_amalg PUBLIC ${sqlite_amalgamation_SOURCE_DIR})
# Suppress warnings from the third-party amalgamation source
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang|AppleClang")
  target_compile_options(sqlite3_amalg PRIVATE -w)
endif()

# Include directories
include_directories(include)

# Library for analyzer components so UI can link against it
add_library(fastrace_analyzer STATIC
  src/Analyzer.cpp
  src/MappedFile.cpp
  src/WorkQueue.cpp
  src/RecentFiles.cpp
  src/SignalDecoder.cpp
  src/ArxmlParser.cpp
  src/DetectionEngine.cpp
  src/ProtocolParser.cpp
  src/BlfIngestReader.cpp
  src/DuckDbCli.cpp
  detectors/PduDetector.cpp
  detectors/SomeIpSdDetector.cpp
  detectors/DoipDetector.cpp
)
target_include_directories(fastrace_analyzer PUBLIC 
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/include/detectors
)
target_link_libraries(fastrace_analyzer PUBLIC libdeflate_static spdlog::spdlog sqlite3_amalg pugixml::pugixml)

# Executable
add_executable(cpp_parser
  src/main.cpp
)
target_link_libraries(cpp_parser PRIVATE fastrace_analyzer)

add_executable(fastrace_ingest src/ingest_main.cpp)
target_link_libraries(fastrace_ingest PRIVATE fastrace_analyzer)

add_executable(fastrace_query src/query_main.cpp)
target_link_libraries(fastrace_query PRIVATE fastrace_analyzer)
