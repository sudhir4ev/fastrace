# Smoke test for fastrace_fixture_gen: run it and assert both outputs exist
# and are non-empty. Does not regenerate the committed fixture.blf/fixture.arxml.
file(MAKE_DIRECTORY "${OUT_DIR}")
execute_process(
  COMMAND "${FIXTURE_GEN}" "${OUT_DIR}/fixture.blf" "${OUT_DIR}/fixture.arxml"
  RESULT_VARIABLE _rv
)
if(NOT _rv EQUAL 0)
  message(FATAL_ERROR "fastrace_fixture_gen exited with ${_rv}")
endif()
foreach(_f "${OUT_DIR}/fixture.blf" "${OUT_DIR}/fixture.arxml")
  if(NOT EXISTS "${_f}")
    message(FATAL_ERROR "${_f} was not written")
  endif()
  file(SIZE "${_f}" _sz)
  if(_sz EQUAL 0)
    message(FATAL_ERROR "${_f} is empty")
  endif()
endforeach()
