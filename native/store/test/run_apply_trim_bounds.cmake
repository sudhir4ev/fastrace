# Verifies `apply-trim`: indexed decode of the uncovered delta for active
# signals, tracked in signal_coverage. signal_stats stays Prepare-time
# (full-trace) and is not rewritten. The fixture's one EngineRpm sample is at
# timestamp_us=1 (signal_id 0); Prepare leaves signal_stats.samples=1.
file(MAKE_DIRECTORY "${OUT_DIR}")
file(COPY "${FIXTURE_BLF}" "${FIXTURE_ARXML}" DESTINATION "${OUT_DIR}")
get_filename_component(_blf "${FIXTURE_BLF}" NAME)
get_filename_component(_arxml "${FIXTURE_ARXML}" NAME)
set(_out "${OUT_DIR}/fixture.duckdb")
file(REMOVE "${_out}" "${_out}.wal")

function(run_parse)
  execute_process(COMMAND "${FASTRACE_PARSE}" ${ARGN} WORKING_DIRECTORY "${OUT_DIR}" RESULT_VARIABLE _rv)
  if(NOT _rv EQUAL 0)
    message(FATAL_ERROR "fastrace_parse ${ARGN} exited with ${_rv}")
  endif()
endfunction()

function(check)
  execute_process(COMMAND "${APPLY_CHECK}" "${_out}" ${ARGN} RESULT_VARIABLE _rv)
  if(NOT _rv EQUAL 0)
    message(FATAL_ERROR "apply_trim_bounds_check ${ARGN} failed")
  endif()
endfunction()

run_parse(prepare "${_blf}" "${_arxml}")

# 1. Decode signal 0 over [0,10] (includes ts=1): 1 sample row, prepare stats=1, coverage (0,10).
run_parse(apply-trim "${_blf}" 0 10 0)
check(0 1 1 0 10)

# 2. Shrink to [2,5] (excludes ts=1): no BLF read, row stays, prepare stats untouched, coverage unchanged.
run_parse(apply-trim "${_blf}" 2 5 0)
check(0 1 1 0 10)

# 3. Disjoint jump to [100,200]: stale rows deleted, re-decode finds nothing, coverage reset (100,200).
#    Prepare-time signal_stats.samples remains 1.
run_parse(apply-trim "${_blf}" 100 200 0)
check(0 0 1 100 200)

# 4. Apply over [0,10] with NO active signals: early-out, signals/coverage/stats unchanged.
run_parse(apply-trim "${_blf}" 0 10)
check(0 0 1 100 200)
