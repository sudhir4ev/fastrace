add_library(fastrace_blf STATIC
  src/MappedFile.cpp
  src/WorkQueue.cpp
  src/Analyzer.cpp
  src/BlfIngestReader.cpp
)
target_include_directories(fastrace_blf PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(fastrace_blf PUBLIC libdeflate_static spdlog::spdlog fastrace_signaldb)

enable_testing()

add_executable(fastrace_blf_test test/blf_ingest_reader_test.cpp)
target_link_libraries(fastrace_blf_test PRIVATE fastrace_blf)
target_compile_definitions(fastrace_blf_test PRIVATE
  FASTRACE_FIXTURE_BLF="${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf"
)
add_test(NAME fastrace_blf_test COMMAND fastrace_blf_test)

add_executable(fastrace_visit_range_test test/visit_range_test.cpp)
target_link_libraries(fastrace_visit_range_test PRIVATE fastrace_blf)
target_compile_definitions(fastrace_visit_range_test PRIVATE
  FASTRACE_FIXTURE_BLF="${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.blf"
)
add_test(NAME fastrace_visit_range_test COMMAND fastrace_visit_range_test)
