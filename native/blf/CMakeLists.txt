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
