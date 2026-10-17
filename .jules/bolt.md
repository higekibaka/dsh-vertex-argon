## 2024-10-16 - ISO 8601 Date String Sorting Optimization
**Learning:** `String.prototype.localeCompare` is significantly slower than standard relational operators (`<` and `>`). For perfectly lexicographically sortable strings like ISO 8601 timestamps, the expensive locale-aware collation provided by `localeCompare` is completely unnecessary and acts as a performance bottleneck.
**Action:** When sorting arrays of ISO 8601 date strings (or other predictably formatted numeric/date strings), always use `a < b ? -1 : (a > b ? 1 : 0)` instead of `a.localeCompare(b)`.
## 2026-10-17 - [Intl Formatters Optimization]
**Learning:** [Instantiating `Intl.DateTimeFormat` and `Intl.NumberFormat` instances on every call is significantly slower than reusing cached instances. Using `.toLocaleString()` and `.toLocaleTimeString()` creates these objects implicitly.]
**Action:** [Cache `Intl.*Format` objects at the module or class level to avoid recreating them during renders or in loops.]
