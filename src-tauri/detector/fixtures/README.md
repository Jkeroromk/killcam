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
| `br1440_zh-tw_lines.rle` | 95 s of battle royale at 3440×1440 in Traditional Chinese: the **white** mask of the prompt lines; header x / y = the screen centre's column in the region and the region's top row on screen | 3 knocks, 1 knocked |
| `tdm1440_zh-tw.rle` | a whole team deathmatch at 3440×1440 with PUBG in Traditional Chinese ("1 擊殺", then "N 擊殺數"), counter 1 → 32 | 32 |
