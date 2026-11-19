# Regression for the container_index start-offset resolution: a trailing
# timestamp-0 container must NOT hijack the seek to EOF (which decoded nothing on
# real traces). Prepare, inject the hijack row, apply-trim a full-ish window over
# the fixture's one EngineRpm sample (ts=1), and assert it is still decoded.
file(MAKE_DIRECTORY "${OUT_DIR}")
file(COPY "${FIXTURE_BLF}" "${FIXTURE_ARXML}" DESTINATION "${OUT_DIR}")
get_filename_component(_blf "${FIXTURE_BLF}" NAME)
get_filename_component(_arxml "${FIXTURE_ARXML}" NAME)
set(_out "${OUT_DIR}/fixture.duckdb")
file(REMOVE "${_out}" "${_out}.wal")

execute_process(COMMAND "${FASTRACE_PARSE}" prepare "${_blf}" "${_arxml}"
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "prepare exited with ${_rv}")
endif()

execute_process(COMMAND "${HIJACK_SEED}" "${_out}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "hijack seed failed")
endif()

# Full-span window [0,10] over the fixture (its one sample is at ts=1). With the
# bug the trailing ts=0 row wins the start-offset and nothing decodes.
execute_process(COMMAND "${FASTRACE_PARSE}" apply-trim "${_blf}" 0 10 0
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "apply-trim exited with ${_rv}")
endif()

# signal 0: 1 decoded row, samples 1, coverage (0,10).
execute_process(COMMAND "${APPLY_CHECK}" "${_out}" 0 1 1 0 10 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "apply_trim_bounds_check failed - the hijack row likely captured the seek")
endif()
