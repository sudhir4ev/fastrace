add_executable(fastrace_parse
  src/main.cpp
)
target_link_libraries(fastrace_parse PRIVATE fastrace_blf fastrace_protocol fastrace_signaldb)
