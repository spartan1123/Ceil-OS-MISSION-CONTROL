# TOOLS - Capabilities and Quality Gates

## Tooling Philosophy
Use multiple independent signals to catch different bug classes:
- Compiler diagnostics
- Static analysis
- Unit/integration tests
- Sanitizers
- Runtime memory checking
- Optional fuzzing for input-heavy surfaces

## Baseline Build Standards (C)
Prefer C17 by default, fallback to C11 when required.

### GCC Strict Build (Debug)
gcc -std=c17 -O0 -g3 -Wall -Wextra -Wpedantic -Werror \
  -Wconversion -Wsign-conversion -Wshadow -Wformat=2 \
  -Wstrict-prototypes -Wmissing-prototypes -Wnull-dereference \
  -Wdouble-promotion -Wundef -fno-omit-frame-pointer ...

### Clang Strict Build (Debug)
clang -std=c17 -O0 -g3 -Wall -Wextra -Wpedantic -Werror \
  -Wconversion -Wsign-conversion -Wshadow -Wformat=2 \
  -Wstrict-prototypes -Wmissing-prototypes -Wnull-dereference \
  -Wdouble-promotion -Wundef -fno-omit-frame-pointer ...

Note:
- -Werror can be selectively relaxed only with explicit documented justification.

## Static Analysis Gates
Run at least one compiler analyzer plus one external analyzer when possible.

### GCC Analyzer
gcc -fanalyzer ...

### Clang Static Analyzer (whole project)
scan-build --status-bugs make -j
or
scan-build --status-bugs cmake --build build -j

### clang-tidy
clang-tidy <file.c> -p build -checks=-*,clang-analyzer-*,bugprone-* --

### Cppcheck
cppcheck --project=compile_commands.json \
  --enable=warning,style,performance,portability,information \
  --inconclusive --error-exitcode=2

## Dynamic Analysis Gates
### Sanitizers (Clang/GCC where supported)
- AddressSanitizer + UBSan for debug verification:
  -fsanitize=address,undefined -fno-omit-frame-pointer

### Valgrind (when available)
valgrind --leak-check=full --show-leak-kinds=all --track-origins=yes ./app

## Testing Framework
### CMake + CTest
Use include(CTest), enable_testing(), and add_test() in CMake.

### C Unit Testing
Prefer cmocka for unit tests where mocks/fixtures are needed.

## Optional Advanced Validation
For parser/protocol/input-heavy code:
- libFuzzer target with sanitizer instrumentation.

## Required Verification Sequence Before Final Report
1. Clean build
2. Strict warning gate
3. Static analyzer gate
4. Unit/integration tests
5. Sanitizer run
6. Valgrind run (if environment supports it)
7. Regression check on changed behavior

## Failure Handling
If any gate fails:
1. Stop final reporting.
2. Capture failing signal and root cause.
3. Fix safely.
4. Re-run all impacted gates.
5. Repeat until green.

## Evidence Logging
For each task keep:
- Commands run
- Exit codes
- Key diagnostics
- Final pass/fail summary
