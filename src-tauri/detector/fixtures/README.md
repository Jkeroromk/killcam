# Screen-reading test fixtures

What the kill-counter reader saw in real recordings, used by the tests in
`src/detector.rs` so changes to the reader can't quietly start miscounting.

Each file is the red-text mask around the "N 淘汰数" counter, 6 frames a second:
`KCFX` | u16 width | u16 height | u32 frames | u16 x, y of the counter
template | per frame a run count, then alternating off / on run lengths
(LEB128 varints).

| file | what | kills |
|---|---|---|
| `tdm1080_a`–`d.rle` | team deathmatch at 1920×1080: counter 1 → 13 | 1, 3, 5, 4 |
| `br1440.rle` | battle royale at 3440×1440 | 11 |
