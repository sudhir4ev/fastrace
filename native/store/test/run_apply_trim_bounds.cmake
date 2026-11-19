# Verifies the combined `apply-trim` subcommand: one indexed pass that
# recomputes window-scoped signal_stats for every signal AND decodes only the
# uncovered delta for the active signals, tracking coverage in signal_coverage.
# The fixture's one EngineRpm sample is at timestamp_us=1 (signal_id 0).
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

# 1. Decode signal 0 over [0,10] (includes ts=1): 1 sample row, stats=1, coverage (0,10).
run_parse(apply-trim "${_blf}" 0 10 0)
check(0 1 1 0 10)

# 2. Shrink to [2,5] (excludes ts=1): decode skipped so the row stays (1), stats recompute to 0,
#    coverage unchanged at (0,10) - coverage tracks decoded extent, never shrinks.
run_parse(apply-trim "${_blf}" 2 5 0)
check(0 1 0 0 10)

# 3. Disjoint jump to [100,200]: stale rows deleted, re-decode finds nothing, coverage reset (100,200).
run_parse(apply-trim "${_blf}" 100 200 0)
check(0 0 0 100 200)

# 4. Stats-only Apply over [0,10] with NO active signals: signals untouched, stats recompute to 1,
#    coverage unchanged (not active this pass).
run_parse(apply-trim "${_blf}" 0 10)
check(0 0 1 100 200)
