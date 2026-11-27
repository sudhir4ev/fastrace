add_library(fastrace_protocol STATIC
  src/ProtocolParser.cpp
)
target_include_directories(fastrace_protocol PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(fastrace_protocol PUBLIC fastrace_blf)

enable_testing()

add_executable(fastrace_protocol_test test/protocol_parser_test.cpp)
target_link_libraries(fastrace_protocol_test PRIVATE fastrace_protocol)
add_test(NAME fastrace_protocol_test COMMAND fastrace_protocol_test)
