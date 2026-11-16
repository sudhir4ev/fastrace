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
