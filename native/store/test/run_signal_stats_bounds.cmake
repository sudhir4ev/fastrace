# Verifies the new `signal-stats` subcommand: narrowing the window to exclude
# the fixture's one CAN message (timestamp_us=1) must drop EngineRpm's
# recomputed `samples` to 0; widening back to include it must restore 1; and
# signal_stats must always have exactly one row per arxml_signal (the
# full-table DELETE-then-rewrite must never leave a partial row set).
file(MAKE_DIRECTORY "${OUT_DIR}")
file(COPY "${FIXTURE_BLF}" "${FIXTURE_ARXML}" DESTINATION "${OUT_DIR}")
get_filename_component(_blf_name "${FIXTURE_BLF}" NAME)
get_filename_component(_arxml_name "${FIXTURE_ARXML}" NAME)
set(_out "${OUT_DIR}/fixture.duckdb")
file(REMOVE "${_out}" "${_out}.wal")

execute_process(COMMAND "${FASTRACE_PARSE}" prepare "${_blf_name}" "${_arxml_name}"
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "prepare exited with ${_rv}")
endif()

# Bound excludes timestamp_us=1 -> EngineRpm's samples recompute to 0.
execute_process(COMMAND "${FASTRACE_PARSE}" signal-stats "${_blf_name}" 100 200
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal-stats (excluding bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${STATS_CHECK}" "${_out}" 0 0 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal_stats_bounds_check failed after excluding bound")
endif()

# Bound includes timestamp_us=1 -> EngineRpm's samples recompute to 1.
execute_process(COMMAND "${FASTRACE_PARSE}" signal-stats "${_blf_name}" 0 10
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal-stats (including bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${STATS_CHECK}" "${_out}" 0 1 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "signal_stats_bounds_check failed after including bound")
endif()
