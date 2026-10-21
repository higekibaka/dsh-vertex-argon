## 2024-10-16 - ISO 8601 Date String Sorting Optimization
**Learning:** `String.prototype.localeCompare` is significantly slower than standard relational operators (`<` and `>`). For perfectly lexicographically sortable strings like ISO 8601 timestamps, the expensive locale-aware collation provided by `localeCompare` is completely unnecessary and acts as a performance bottleneck.
**Action:** When sorting arrays of ISO 8601 date strings (or other predictably formatted numeric/date strings), always use `a < b ? -1 : (a > b ? 1 : 0)` instead of `a.localeCompare(b)`.

## 2024-10-27 - O(N log N) Sorting Overhead for Min/Max
**Learning:** Sorting an entire array just to find the minimum and maximum values (`oldestAt`, `newestAt`) is an unnecessary O(N log N) performance overhead, and also incurs O(N) array allocation overhead when chained with `.map()` and `.filter()`. A simple O(N) linear scan loop is significantly faster.
**Action:** When only minimum and/or maximum values are needed from an array, use a single O(N) iteration loop instead of `.sort()`.

## 2026-10-17 - Cache Intl Formatters Instead Of Rebuilding Them Per Value
**Learning:** `toLocaleTimeString` and `Number#toLocaleString` construct a new `Intl` formatter on every call, which is pure overhead when the locale and options never change.
**Action:** Hoist `new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false })` and `new Intl.NumberFormat()` to module scope, then call the cached `.format()`. The three `numeric` options with `hour12: false` are byte-identical to `toLocaleTimeString([], { hour12: false })` in every locale, so zh-CN/en-GB keep their zero-padded hours and ko-KR keeps its own pattern.

## 2026-10-21 - One-Pass Date Window Instead Of Map/Filter/Sort
**Learning:** Reading the oldest and newest start time by mapping every record, filtering the strings and sorting the copy allocated a full array (plus the sort's own work) only to read two values.
**Action:** Walk the records once with two running comparisons (`oldestAt`/`newestAt`) seeded with `null`, so an empty or fully non-string field set still reports `null`. Relational `<`/`>` on ISO 8601 strings is the same UTF-16 code-unit order `sort()` used, and non-string starts stay excluded.
