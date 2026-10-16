## 2024-10-16 - ISO 8601 Date String Sorting Optimization
**Learning:** `String.prototype.localeCompare` is significantly slower than standard relational operators (`<` and `>`). For perfectly lexicographically sortable strings like ISO 8601 timestamps, the expensive locale-aware collation provided by `localeCompare` is completely unnecessary and acts as a performance bottleneck.
**Action:** When sorting arrays of ISO 8601 date strings (or other predictably formatted numeric/date strings), always use `a < b ? -1 : (a > b ? 1 : 0)` instead of `a.localeCompare(b)`.
