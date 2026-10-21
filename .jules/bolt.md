## 2024-10-16 - ISO 8601 Date String Sorting Optimization
**Learning:** `String.prototype.localeCompare` is significantly slower than standard relational operators (`<` and `>`). For perfectly lexicographically sortable strings like ISO 8601 timestamps, the expensive locale-aware collation provided by `localeCompare` is completely unnecessary and acts as a performance bottleneck.
**Action:** When sorting arrays of ISO 8601 date strings (or other predictably formatted numeric/date strings), always use `a < b ? -1 : (a > b ? 1 : 0)` instead of `a.localeCompare(b)`.
## 2024-10-27 - O(N log N) Sorting Overhead for Min/Max
**Learning:** Sorting an entire array just to find the minimum and maximum values (`oldestAt`, `newestAt`) is an unnecessary O(N log N) performance overhead, and also incurs O(N) array allocation overhead when chained with `.map()` and `.filter()`. A simple O(N) linear scan loop is significantly faster.
**Action:** When only minimum and/or maximum values are needed from an array, use a single O(N) iteration loop instead of `.sort()`.
