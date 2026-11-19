# Fixture's EngineRpm (signal_id 0) has exactly one decoded sample, at
# timestamp_us=1 (CAN message at timestampNs=1000 on the fixture's EngineFrame
# arb id 0x100 - see native/store/test/fixtures/generate_fixture.cpp). This
# drives decode-signals with a bound that excludes it, then one that includes
# it, then re-runs the including bound a second time to prove it doesn't
# duplicate rows.
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

# Bound excludes timestamp_us=1 -> zero rows for signal_id 0.
execute_process(COMMAND "${FASTRACE_PARSE}" decode-signals "${_blf_name}" 100 200 0
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode-signals (excluding bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${BOUNDS_CHECK}" "${_out}" 0 0 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode_bounds_check failed after excluding bound")
endif()

# Bound includes timestamp_us=1 -> one row.
execute_process(COMMAND "${FASTRACE_PARSE}" decode-signals "${_blf_name}" 0 10 0
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode-signals (including bound) exited with ${_rv}")
endif()
execute_process(COMMAND "${BOUNDS_CHECK}" "${_out}" 0 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode_bounds_check failed after including bound")
endif()

# Re-running the same including bound must not duplicate the row.
execute_process(COMMAND "${FASTRACE_PARSE}" decode-signals "${_blf_name}" 0 10 0
  WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode-signals (re-run) exited with ${_rv}")
endif()
execute_process(COMMAND "${BOUNDS_CHECK}" "${_out}" 0 1 RESULT_VARIABLE _rv)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "decode_bounds_check failed after re-running the same bound (duplicate rows?)")
endif()
