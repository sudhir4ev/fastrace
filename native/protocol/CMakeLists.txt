add_library(fastrace_protocol STATIC
  src/ProtocolParser.cpp
)
target_include_directories(fastrace_protocol PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)
target_link_libraries(fastrace_protocol PUBLIC fastrace_blf)
