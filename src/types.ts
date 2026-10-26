/**
 * A duration: milliseconds as a number, or a string such as `"30m"`, `"12h"`, `"1d"`.
 * Supported units: `m` (minutes), `h` (hours), `d` (days).
 */
export type Interval = number | `${number}${'m' | 'h' | 'd'}`;
