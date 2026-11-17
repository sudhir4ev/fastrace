# Runs `fastrace_parse prepare` against a copy of the committed fixture (so
# the generated .duckdb lands in the build tree, not next to the source
# fixture), then checks row counts via fastrace_fixture_check.
file(MAKE_DIRECTORY "${OUT_DIR}")
file(COPY "${FIXTURE_BLF}" "${FIXTURE_ARXML}" DESTINATION "${OUT_DIR}")
get_filename_component(_blf_name "${FIXTURE_BLF}" NAME)
get_filename_component(_arxml_name "${FIXTURE_ARXML}" NAME)

set(_out "${OUT_DIR}/fixture.duckdb")
file(REMOVE "${_out}" "${_out}.wal")

execute_process(
  COMMAND "${FASTRACE_PARSE}" prepare "${_blf_name}" "${_arxml_name}"
  WORKING_DIRECTORY "${OUT_DIR}"
  RESULT_VARIABLE _rv
)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "fastrace_parse prepare exited with ${_rv}")
endif()

execute_process(
  COMMAND "${FIXTURE_CHECK}" "${_out}"
  RESULT_VARIABLE _rv2
)
if(NOT _rv2 EQUAL 0)
  message(FATAL_ERROR "fastrace_fixture_check failed")
endif()
