add_executable(fastrace_parse
  src/main.cpp
)
target_link_libraries(fastrace_parse PRIVATE fastrace_blf fastrace_protocol fastrace_signaldb fastrace_store)
fastrace_copy_duckdb_runtime(fastrace_parse)

add_test(NAME fastrace_store_fixture_prepare
  COMMAND ${CMAKE_COMMAND}
    -DFASTRACE_PARSE=$<TARGET_FILE:fastrace_parse>
    -DFIXTURE_CHECK=$<TARGET_FILE:fastrace_fixture_check>
    -DFIXTURE_BLF=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf
    -DFIXTURE_ARXML=${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.arxml
    -DOUT_DIR=${CMAKE_CURRENT_BINARY_DIR}/fixture_prepare
    -P ${PROJECT_SOURCE_DIR}/store/test/run_fixture_prepare.cmake
)
