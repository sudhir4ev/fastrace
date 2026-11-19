# fastrace_store: embeds schema/schema.sql (docs/adr/0001) and wraps the
# DuckDB Appender (docs/adr/0002) to write the Trace Store.

include(FetchContent)

set(FASTRACE_DUCKDB_VERSION "v1.1.3")

if(APPLE)
  set(_duckdb_asset "libduckdb-osx-universal.zip")
  set(_duckdb_lib_name "libduckdb.dylib")
elseif(WIN32)
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|ARM64|aarch64)$")
    set(_duckdb_asset "libduckdb-windows-arm64.zip")
  else()
    set(_duckdb_asset "libduckdb-windows-amd64.zip")
  endif()
  set(_duckdb_lib_name "duckdb.dll")
  set(_duckdb_implib_name "duckdb.lib")
else()
  if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64)$")
    set(_duckdb_asset "libduckdb-linux-aarch64.zip")
  else()
    set(_duckdb_asset "libduckdb-linux-amd64.zip")
  endif()
  set(_duckdb_lib_name "libduckdb.so")
endif()

FetchContent_Declare(
  duckdb_prebuilt
  URL https://github.com/duckdb/duckdb/releases/download/${FASTRACE_DUCKDB_VERSION}/${_duckdb_asset}
)
FetchContent_MakeAvailable(duckdb_prebuilt)

add_library(duckdb SHARED IMPORTED GLOBAL)
set_target_properties(duckdb PROPERTIES
  IMPORTED_LOCATION "${duckdb_prebuilt_SOURCE_DIR}/${_duckdb_lib_name}"
  INTERFACE_INCLUDE_DIRECTORIES "${duckdb_prebuilt_SOURCE_DIR}"
)
if(WIN32)
  set_target_properties(duckdb PROPERTIES
    IMPORTED_IMPLIB "${duckdb_prebuilt_SOURCE_DIR}/${_duckdb_implib_name}"
  )
endif()
add_library(duckdb::duckdb ALIAS duckdb)

# Embed schema/schema.sql and its version comment at configure time (docs/adr/0001 rule 1).
set(FASTRACE_SCHEMA_PATH "${PROJECT_SOURCE_DIR}/../schema/schema.sql")
file(READ "${FASTRACE_SCHEMA_PATH}" FASTRACE_SCHEMA_SQL)
string(REGEX MATCH "schema_version: ([0-9]+)" _version_match "${FASTRACE_SCHEMA_SQL}")
if(NOT CMAKE_MATCH_1)
  message(FATAL_ERROR "schema/schema.sql is missing a '-- schema_version: N' comment")
endif()
set(FASTRACE_SCHEMA_VERSION "${CMAKE_MATCH_1}")
configure_file(
  include/SchemaEmbed.h.in
  ${CMAKE_CURRENT_BINARY_DIR}/generated/SchemaEmbed.h
  @ONLY
)

add_library(fastrace_store STATIC
  src/Db.cpp
  src/Appender.cpp
  src/ArxmlLoad.cpp
  src/ProtocolAppend.cpp
)
target_include_directories(fastrace_store PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_BINARY_DIR}/generated
  ${PROJECT_SOURCE_DIR}/blf/include
)
target_include_directories(fastrace_store PRIVATE
  ${PROJECT_SOURCE_DIR}/signaldb/include
)
target_link_libraries(fastrace_store
  PUBLIC duckdb::duckdb
  PRIVATE fastrace_blf fastrace_protocol fastrace_signaldb spdlog::spdlog
)

# Copy the DuckDB shared library next to any executable that links fastrace_store,
# so it's found at runtime without needing it installed system-wide.
function(fastrace_copy_duckdb_runtime target)
  add_custom_command(TARGET ${target} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${duckdb_prebuilt_SOURCE_DIR}/${_duckdb_lib_name}"
      "$<TARGET_FILE_DIR:${target}>"
  )
endfunction()

enable_testing()

add_executable(fastrace_fixture_gen test/fixtures/generate_fixture.cpp)
target_link_libraries(fastrace_fixture_gen PRIVATE fastrace_blf libdeflate_static)
fastrace_copy_duckdb_runtime(fastrace_fixture_gen)

add_executable(fastrace_store_test test/fixture_roundtrip_test.cpp)
target_link_libraries(fastrace_store_test PRIVATE fastrace_store)
fastrace_copy_duckdb_runtime(fastrace_store_test)
add_test(NAME fastrace_store_roundtrip COMMAND fastrace_store_test)

add_test(NAME fastrace_fixture_gen_smoke
  COMMAND ${CMAKE_COMMAND}
    -DFIXTURE_GEN=$<TARGET_FILE:fastrace_fixture_gen>
    -DOUT_DIR=${CMAKE_CURRENT_BINARY_DIR}/fixture_smoke
    -P ${CMAKE_CURRENT_SOURCE_DIR}/test/fixtures/run_fixture_gen_smoke.cmake
)

add_executable(fastrace_fixture_check test/fixture_prepare_check.cpp)
target_link_libraries(fastrace_fixture_check PRIVATE duckdb::duckdb)
fastrace_copy_duckdb_runtime(fastrace_fixture_check)

add_executable(fastrace_decode_bounds_check test/decode_bounds_check.cpp)
target_link_libraries(fastrace_decode_bounds_check PRIVATE duckdb::duckdb)
fastrace_copy_duckdb_runtime(fastrace_decode_bounds_check)

add_test(NAME fastrace_decode_signals_bounds
  COMMAND ${CMAKE_COMMAND}
    -DFASTRACE_PARSE=$<TARGET_FILE:fastrace_parse>
    -DBOUNDS_CHECK=$<TARGET_FILE:fastrace_decode_bounds_check>
    -DFIXTURE_BLF=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf
    -DFIXTURE_ARXML=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.arxml
    -DOUT_DIR=${CMAKE_CURRENT_BINARY_DIR}/decode_bounds
    -P ${PROJECT_SOURCE_DIR}/store/test/run_decode_signals_bounds.cmake
)

add_executable(fastrace_signal_stats_check test/signal_stats_bounds_check.cpp)
target_link_libraries(fastrace_signal_stats_check PRIVATE duckdb::duckdb)
fastrace_copy_duckdb_runtime(fastrace_signal_stats_check)

add_test(NAME fastrace_signal_stats_bounds
  COMMAND ${CMAKE_COMMAND}
    -DFASTRACE_PARSE=$<TARGET_FILE:fastrace_parse>
    -DSTATS_CHECK=$<TARGET_FILE:fastrace_signal_stats_check>
    -DFIXTURE_BLF=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf
    -DFIXTURE_ARXML=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.arxml
    -DOUT_DIR=${CMAKE_CURRENT_BINARY_DIR}/signal_stats_bounds
    -P ${PROJECT_SOURCE_DIR}/store/test/run_signal_stats_bounds.cmake
)

