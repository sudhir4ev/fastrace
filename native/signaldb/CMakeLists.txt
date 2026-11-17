add_library(fastrace_signaldb STATIC
  src/ArxmlParser.cpp
  src/SignalDecoder.cpp
)
target_include_directories(fastrace_signaldb PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_include_directories(fastrace_signaldb PRIVATE
  ${PROJECT_SOURCE_DIR}/blf/include
)
target_link_libraries(fastrace_signaldb PUBLIC pugixml::pugixml spdlog::spdlog)

enable_testing()

add_executable(fastrace_signaldb_test test/signaldb_test.cpp)
target_link_libraries(fastrace_signaldb_test PRIVATE fastrace_signaldb)
target_include_directories(fastrace_signaldb_test PRIVATE ${PROJECT_SOURCE_DIR}/blf/include)
target_compile_definitions(fastrace_signaldb_test PRIVATE
  FASTRACE_FIXTURE_ARXML="${PROJECT_SOURCE_DIR}/store/test/fixtures/fixture.arxml"
)
add_test(NAME fastrace_signaldb_test COMMAND fastrace_signaldb_test)
